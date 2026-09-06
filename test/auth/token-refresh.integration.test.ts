import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Uses a dedicated Redis database/server selected by the caller. All writes and
// cleanup are restricted to a random prefix; no production keys are inspected.
const redisUrl = process.env.SPINE_TEST_REDIS_URL;
describe.skipIf(!redisUrl)('token refresh with real Redis, encryption and an HTTP OIDC provider', () => {
  const prefix = `spine-refresh-test:${randomUUID()}:`;
  const originalEnv = { ...process.env };
  let redis: Redis;
  let server: Server;
  let storage: typeof import('../../src/auth/redis-session-storage.server');
  let otherStorage: typeof storage;
  let auth: typeof import('../../src/auth/auth.server');
  let otherAuth: typeof auth;
  let attempt: typeof import('../../src/auth/token-refresh.server');
  let protection: typeof import('../../src/auth/route-protection.server');
  let issuer: string;
  let grants: string[] = [];
  let reply: (response: ServerResponse) => Promise<void>;

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  function success(response: ServerResponse, extra: Record<string, unknown> = {}) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      access_token: 'new-access-token', refresh_token: 'new-refresh-token',
      token_type: 'Bearer', expires_in: 300, ...extra,
    }));
  }

  async function createSession(extra: Record<string, unknown> = {}) {
    const headers = await storage.createAuthSession(new Request(`${issuer}/login`), {
      userId: 'user-1', user: { sub: 'user-1', name: 'Before' },
      accessToken: 'old-access-token', refreshToken: 'old-refresh-token',
      idToken: 'old-id-token', expiresAt: Date.now() - 1000, ...extra,
    });
    const cookie = headers.get('Set-Cookie')!.split(';')[0];
    const request = new Request(`${issuer}/protected`, { headers: { cookie } });
    const session = await storage.getAuthSession(request);
    return { request, cookie, session, key: `${prefix}session:${session.sessionId}` };
  }

  beforeAll(async () => {
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    server = createServer(async (request, response) => {
      if (request.url === '/.well-known/openid-configuration') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ issuer, token_endpoint: `${issuer}/token`, authorization_endpoint: `${issuer}/authorize` }));
      } else if (request.url === '/token') {
        let body = '';
        for await (const chunk of request) body += chunk;
        grants.push(new URLSearchParams(body).get('refresh_token') ?? '');
        await reply(response);
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    issuer = `http://127.0.0.1:${address.port}`;
    Object.assign(process.env, {
      NODE_ENV: 'test', REDIS_URL: redisUrl, REDIS_KEY_PREFIX: prefix,
      SESSION_SECRET: 'spine-test-secret-at-least-thirty-two-characters',
      SESSION_ENCRYPTION: 'true', SESSION_ENCRYPTION_KEY: 'a'.repeat(64),
      SESSION_COOKIE_SECURE: 'false', SESSION_COOKIE_NAME: '__refresh_test_session',
      OIDC_AUTHORITY: issuer, OIDC_CLIENT_ID: 'test-client', OIDC_CLIENT_AUTH_METHOD: 'none',
      OIDC_REDIRECT_URI: `${issuer}/callback`, OIDC_APPLICATION_TYPE: 'dashboard',
    });
    delete process.env.OIDC_CLIENT_SECRET;
    vi.resetModules();
    storage = await import('../../src/auth/redis-session-storage.server');
    auth = await import('../../src/auth/auth.server');
    protection = await import('../../src/auth/route-protection.server');
    // Independent module instances have distinct Redis clients and caches.
    // Their only shared refresh coordination is the real Redis lease.
    vi.resetModules();
    otherStorage = await import('../../src/auth/redis-session-storage.server');
    otherAuth = await import('../../src/auth/auth.server');
    attempt = await import('../../src/auth/token-refresh.server');
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    grants = [];
    reply = async (response) => success(response);
    protection.resetRouteProtectionConfig();
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
  });

  afterAll(async () => {
    await storage?.closeRedisConnection();
    await otherStorage?.closeRedisConnection();
    if (redis) {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it('rotates once across direct, 401 and route entrypoints with separate modules and different cookies', async () => {
    const { request, cookie, key } = await createSession();
    const gate = deferred();
    reply = async (response) => { await gate.promise; success(response); };
    const direct = auth.refreshTokens(request);
    await vi.waitFor(() => expect(grants).toHaveLength(1));
    const reactive = attempt.attemptTokenRefresh(new Request(request.url, { headers: { cookie: `theme=dark; ${cookie}` } }));
    const loaded = vi.fn((user) => user?.sub);
    const route = protection.protectRoute(request, 'auth', loaded);
    await storage.updateAuthSession(request, { user: { sub: 'user-1', name: 'Changed during refresh' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    gate.resolve();
    await expect(direct).resolves.toMatchObject({ success: true });
    await expect(reactive).resolves.toMatchObject({ success: true, newAccessToken: 'new-access-token' });
    await expect(route).resolves.toBe('user-1');
    expect(grants).toEqual(['old-refresh-token']);
    expect(await redis.get(key)).toMatch(/^enc:v1:/);
    expect(await storage.getAuthSession(request)).toMatchObject({
      accessToken: 'new-access-token', refreshToken: 'new-refresh-token', idToken: 'old-id-token',
      user: { name: 'Changed during refresh' },
    });
  });

  it('blocks transient provider failure with 503 while preserving the encrypted session for recovery', async () => {
    const { request, key } = await createSession();
    const before = await redis.get(key);
    reply = async (response) => {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'temporarily_unavailable' }));
    };
    const loaded = vi.fn();
    const error = await protection.protectRoute(request, 'auth', loaded).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(503);
    expect((error as Response).headers.get('Cache-Control')).toBe('no-store');
    expect(loaded).not.toHaveBeenCalled();
    expect(await redis.get(key)).toBe(before);
    expect(await auth.getUser(request)).toBeNull();
    reply = async (response) => success(response);
    await expect(protection.protectRoute(request, 'auth', (user) => user?.sub)).resolves.toBe('user-1');
  });

  it('keeps provider network failures retryable in the 401 adapter', async () => {
    const { request, key } = await createSession();
    reply = async (response) => { response.destroy(); };
    await expect(attempt.attemptTokenRefresh(request)).resolves.toMatchObject({ success: false, shouldLogout: false });
    expect(await redis.exists(key)).toBe(1);
  });

  it('logs out on invalid_grant and never runs the protected loader', async () => {
    const { request, key } = await createSession();
    reply = async (response) => {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid_grant' }));
    };
    const loaded = vi.fn();
    await expect(protection.protectRoute(request, 'auth', loaded)).rejects.toMatchObject({ status: 302 });
    expect(loaded).not.toHaveBeenCalled();
    expect(await redis.exists(key)).toBe(0);
  });

  it('never recreates a session deleted during an in-flight grant', async () => {
    const { request, key } = await createSession();
    const gate = deferred();
    reply = async (response) => { await gate.promise; success(response); };
    const refreshed = auth.refreshTokens(request);
    await vi.waitFor(() => expect(grants).toHaveLength(1));
    await storage.destroyAuthSession(request);
    gate.resolve();
    await expect(refreshed).resolves.toMatchObject({ success: false, shouldLogout: true });
    expect(await redis.exists(key)).toBe(0);
    await expect(storage.getAuthSession(request)).resolves.toEqual({});
  });

  it('cannot publish or release another owner lease after losing its lock', async () => {
    const { request, key, session } = await createSession();
    const before = await redis.get(key);
    const gate = deferred();
    reply = async (response) => { await gate.promise; success(response); };
    const refreshed = auth.refreshTokens(request);
    await vi.waitFor(() => expect(grants).toHaveLength(1));
    const lockKey = `${prefix}session:refresh-lock:${session.sessionId}`;
    await redis.set(lockKey, 'replacement-owner', 'PX', 20_000);
    gate.resolve();
    await expect(refreshed).resolves.toMatchObject({ success: false, shouldLogout: false });
    expect(await redis.get(key)).toBe(before);
    expect(await redis.get(lockKey)).toBe('replacement-owner');
  });

  it('uses JWT-only expiry and replaces old metadata when expires_in is omitted', async () => {
    const jwt = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
    const { request } = await createSession({ accessToken: jwt(Math.floor(Date.now() / 1000) - 10), expiresAt: undefined });
    await expect(protection.shouldRefreshToken(request)).resolves.toBe(true);
    reply = async (response) => success(response, { access_token: jwt(Math.floor(Date.now() / 1000) + 300), expires_in: undefined });
    await expect(otherAuth.refreshTokens(request)).resolves.toMatchObject({ success: true });
    await expect(auth.getUser(request)).resolves.toMatchObject({ sub: 'user-1' });
    await expect(protection.shouldRefreshToken(request)).resolves.toBe(false);
  });

  it('does not turn invalid_grant from a lost lease into a terminal session failure', async () => {
    const { request, key, session } = await createSession();
    const gate = deferred();
    reply = async (response) => {
      await gate.promise;
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid_grant' }));
    };
    const refreshed = auth.refreshTokens(request);
    await vi.waitFor(() => expect(grants).toHaveLength(1));
    await redis.set(`${prefix}session:refresh-lock:${session.sessionId}`, 'replacement-owner', 'PX', 20_000);
    gate.resolve();
    await expect(refreshed).resolves.toMatchObject({ success: false, shouldLogout: false });
    expect(await redis.exists(key)).toBe(1);
  });

  it('preserves a replacement refresh generation even when its access token is still expired', async () => {
    const { request } = await createSession();
    const gate = deferred();
    reply = async (response) => {
      await gate.promise;
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid_grant' }));
    };
    const loaded = vi.fn();
    const route = protection.protectRoute(request, 'auth', loaded).catch((error: unknown) => error);
    await vi.waitFor(() => expect(grants).toHaveLength(1));
    await storage.updateAuthSession(request, { refreshToken: 'replacement-refresh' });
    gate.resolve();
    await expect(route).resolves.toMatchObject({ status: 503 });
    expect(loaded).not.toHaveBeenCalled();
    await expect(storage.getAuthSession(request)).resolves.toMatchObject({
      accessToken: 'old-access-token', refreshToken: 'replacement-refresh',
    });
  });

  it('accepts a valid two-part opaque provider token without reading it as JWT expiry', async () => {
    const { request } = await createSession();
    const token = `opaque.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}`;
    reply = async (response) => success(response, { access_token: token });
    await expect(auth.refreshTokens(request)).resolves.toMatchObject({ success: true, tokens: { access_token: token } });
    await expect(auth.getUser(request)).resolves.toMatchObject({ sub: 'user-1' });
    await expect(storage.isSessionValid(request)).resolves.toBe(true);
    await expect(storage.requireAuthSession(request)).resolves.toMatchObject({ accessToken: token });
    await expect(protection.shouldRefreshToken(request)).resolves.toBe(false);
  });

  it('compares the original generation atomically before invalid_grant cleanup', async () => {
    const { request, session } = await createSession();
    reply = async (response) => {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid_grant' }));
    };
    const originalEval = Redis.prototype.eval;
    let replaced = false;
    const spy = vi.spyOn(Redis.prototype, 'eval').mockImplementation(async function (...args) {
      if (!replaced && String(args[0]).includes("redis.call('SREM'")) {
        replaced = true;
        await storage.updateAuthSession(request, { refreshToken: 'replacement-before-delete' });
      }
      return originalEval.apply(this, args);
    });
    try {
      await expect(protection.protectRoute(request, 'auth', vi.fn())).rejects.toMatchObject({ status: 503 });
      expect(replaced).toBe(true);
      await expect(storage.getAuthSession(request)).resolves.toMatchObject({
        sessionId: session.sessionId, refreshToken: 'replacement-before-delete', accessToken: 'old-access-token',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('never deletes a replacement committed between lease release and logout response', async () => {
    const { request, session } = await createSession();
    reply = async (response) => {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid_grant' }));
    };
    const originalEval = Redis.prototype.eval;
    let replaced = false;
    const spy = vi.spyOn(Redis.prototype, 'eval').mockImplementation(async function (...args) {
      const result = await originalEval.apply(this, args);
      if (!replaced && String(args[0]).includes("return redis.call('DEL', KEYS[1])")) {
        replaced = true;
        await storage.updateAuthSession(request, {
          ...session, accessToken: 'replacement-access', refreshToken: 'replacement-refresh', expiresAt: Date.now() + 300_000,
        });
      }
      return result;
    });
    try {
      const loaded = vi.fn();
      const response = await protection.protectRoute(request, 'auth', loaded).catch((error: unknown) => error);
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(302);
      expect((response as Response).headers.get('Set-Cookie')).toContain('Max-Age=0');
      expect(loaded).not.toHaveBeenCalled();
      expect(replaced).toBe(true);
      await expect(storage.getAuthSession(request)).resolves.toMatchObject({
        sessionId: session.sessionId, accessToken: 'replacement-access', refreshToken: 'replacement-refresh',
      });
      await expect(auth.getUser(request)).resolves.toMatchObject({ sub: 'user-1' });
    } finally {
      spy.mockRestore();
    }
  });

  it('conditionally invalidates an expired session without a refresh token and preserves adapter metadata', async () => {
    const { request, key } = await createSession({ refreshToken: undefined });
    await expect(attempt.attemptTokenRefresh(request)).resolves.toMatchObject({
      success: false, shouldLogout: true, sessionInvalidated: true,
    });
    expect(await redis.exists(key)).toBe(0);
    expect(grants).toHaveLength(0);
  });

  it('times out a stalled provider without publishing tokens or deleting the session', async () => {
    const { request, key, session } = await createSession();
    const before = await redis.get(key);
    const gate = deferred();
    reply = async (response) => { await gate.promise; success(response); };
    const refreshed = auth.refreshTokens(request);
    await vi.waitFor(() => expect(grants).toHaveLength(1));
    await expect(refreshed).resolves.toMatchObject({ success: false, shouldLogout: false });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await redis.get(key)).toBe(before);
    expect(await redis.exists(`${prefix}session:refresh-lock:${session.sessionId}`)).toBe(0);
  }, 20_000);

  it('blocks malformed success and does not treat a two-part opaque token as a JWT', async () => {
    const { request, key } = await createSession();
    const before = await redis.get(key);
    reply = async (response) => success(response, { access_token: undefined });
    await expect(auth.refreshTokens(request)).resolves.toMatchObject({ success: false, shouldLogout: false });
    expect(await redis.get(key)).toBe(before);
    const encoded = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 })).toString('base64url');
    const opaque = await createSession({ accessToken: `opaque.${encoded}`, expiresAt: Date.now() + 300_000 });
    await expect(protection.shouldRefreshToken(opaque.request)).resolves.toBe(false);
  });

  it('classifies unreadable encrypted storage as retryable instead of a missing session', async () => {
    const { request, key } = await createSession();
    await redis.set(key, 'enc:v1:invalid');
    await expect(auth.refreshTokens(request)).resolves.toMatchObject({ success: false, shouldLogout: false });
    expect(await redis.get(key)).toBe('enc:v1:invalid');
    expect(grants).toHaveLength(0);
  });
});
