import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = vi.hoisted(() => {
  type Entry = {
    kind: 'string' | 'set';
    value: string | Set<string>;
    expiresAt: number | null;
  };

  const state = {
    clients: [] as FakeRedis[],
    entries: new Map<string, Entry>(),
    pipelineExecutions: [] as string[][],
    reset(): void {
      state.clients.length = 0;
      state.entries.clear();
      state.pipelineExecutions.length = 0;
    },
  };

  function getEntry(key: string): Entry | undefined {
    const entry = state.entries.get(key);
    if (entry?.expiresAt !== null && entry && entry.expiresAt <= Date.now()) {
      state.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  function setString(key: string, value: string, seconds?: number): void {
    state.entries.set(key, {
      kind: 'string',
      value,
      expiresAt: seconds === undefined ? null : Date.now() + seconds * 1000,
    });
  }

  class FakePipeline {
    readonly commands: string[] = [];
    private readonly operations: Array<() => unknown> = [];

    sadd(key: string, ...members: string[]): this {
      this.commands.push(`sadd ${key} ${members.join(' ')}`);
      this.operations.push(() => {
        const current = getEntry(key);
        const set = current?.kind === 'set' ? current.value as Set<string> : new Set<string>();
        const before = set.size;
        members.forEach((member) => set.add(member));
        state.entries.set(key, { kind: 'set', value: set, expiresAt: current?.expiresAt ?? null });
        return set.size - before;
      });
      return this;
    }

    srem(key: string, ...members: string[]): this {
      this.commands.push(`srem ${key} ${members.join(' ')}`);
      this.operations.push(() => {
        const current = getEntry(key);
        if (!current || current.kind !== 'set') return 0;
        const set = current.value as Set<string>;
        let removed = 0;
        members.forEach((member) => {
          if (set.delete(member)) removed += 1;
        });
        return removed;
      });
      return this;
    }

    expire(key: string, seconds: number): this {
      this.commands.push(`expire ${key} ${seconds}`);
      this.operations.push(() => {
        const current = getEntry(key);
        if (!current) return 0;
        current.expiresAt = Date.now() + seconds * 1000;
        return 1;
      });
      return this;
    }

    async exec(): Promise<Array<[null, unknown]>> {
      state.pipelineExecutions.push([...this.commands]);
      return this.operations.map((operation) => [null, operation()] as [null, unknown]);
    }
  }

  class FakeRedis {
    readonly url: string;
    readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    quitCalled = false;

    constructor(url: string) {
      this.url = url;
      state.clients.push(this);
    }

    on(eventName: string, handler: (...args: unknown[]) => void): this {
      const handlers = this.listeners.get(eventName) ?? new Set<(...args: unknown[]) => void>();
      handlers.add(handler);
      this.listeners.set(eventName, handlers);
      return this;
    }

    emit(eventName: string, ...args: unknown[]): void {
      this.listeners.get(eventName)?.forEach((handler) => handler(...args));
    }

    pipeline(): FakePipeline {
      return new FakePipeline();
    }

    async get(key: string): Promise<string | null> {
      const entry = getEntry(key);
      return entry?.kind === 'string' ? entry.value as string : null;
    }

    async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
      const ttlIndex = args.findIndex((argument) => argument === 'EX' || argument === 'PX');
      const ttl = ttlIndex >= 0 ? Number(args[ttlIndex + 1]) : undefined;
      setString(key, value, ttlIndex >= 0 && args[ttlIndex] === 'PX' ? ttl / 1000 : ttl);
      return 'OK';
    }

    async setex(key: string, seconds: number, value: string): Promise<'OK'> {
      setString(key, value, seconds);
      return 'OK';
    }

    async expire(key: string, seconds: number): Promise<0 | 1> {
      const entry = getEntry(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }

    async ttl(key: string): Promise<number> {
      const entry = getEntry(key);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    }

    async smembers(key: string): Promise<string[]> {
      const entry = getEntry(key);
      return entry?.kind === 'set' ? Array.from(entry.value as Set<string>).sort() : [];
    }

    async sadd(key: string, ...members: string[]): Promise<number> {
      const pipeline = new FakePipeline();
      pipeline.sadd(key, ...members);
      const results = await pipeline.exec();
      return Number(results[0]?.[1] ?? 0);
    }

    async srem(key: string, ...members: string[]): Promise<number> {
      const pipeline = new FakePipeline();
      pipeline.srem(key, ...members);
      const results = await pipeline.exec();
      return Number(results[0]?.[1] ?? 0);
    }

    async exists(key: string): Promise<0 | 1> {
      return getEntry(key) ? 1 : 0;
    }

    async del(...keys: string[]): Promise<number> {
      let deleted = 0;
      keys.forEach((key) => {
        if (state.entries.delete(key)) deleted += 1;
      });
      return deleted;
    }

    async keys(pattern: string): Promise<string[]> {
      const expression = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
      return Array.from(state.entries.keys()).filter((key) => {
        getEntry(key);
        return expression.test(key);
      }).sort();
    }

    async quit(): Promise<'OK'> {
      this.quitCalled = true;
      return 'OK';
    }
  }

  return { FakeRedis, state };
});

vi.mock('ioredis', () => ({
  default: redisMock.FakeRedis,
  Redis: redisMock.FakeRedis,
}));

type RedisSessionStorage = typeof import('../../src/auth/redis-session-storage.server');
let storage: RedisSessionStorage;
const originalEnv = { ...process.env };

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = 'redis://spine-test';
  process.env.REDIS_KEY_PREFIX = 'spine-test:';
  process.env.SESSION_DEFAULT_TTL = '60';
  process.env.OAUTH_STATE_TTL = '60';
  process.env.SESSION_ENCRYPTION = 'false';
  vi.resetModules();
  storage = await import('../../src/auth/redis-session-storage.server');
});

beforeEach(async () => {
  await storage.closeRedisConnection();
  redisMock.state.reset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await storage.closeRedisConnection();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

function cookieRequest(setCookie: string): Request {
  return new Request('https://app.example.test/dashboard', {
    headers: { cookie: setCookie.split(';', 1)[0] },
  });
}

function sessionIdFromCookie(setCookie: string): string {
  const cookieValue = decodeURIComponent(setCookie.split(';', 1)[0].split('=', 2)[1]);
  return cookieValue.slice(0, cookieValue.lastIndexOf('.'));
}

describe('Redis session storage', () => {
  it('persists sessions, refreshes expiry, and maintains membership indexes through pipelines', async () => {
    const response = await storage.createAuthSession(
      new Request('https://app.example.test/login', {
        headers: { 'user-agent': 'spine-test-agent' },
      }),
      {
        userId: 'user-1',
        accessToken: 'access-token',
        user: { sub: 'user-1', email: 'user@example.test' },
        sid: 'sid-1',
        sessionState: 'state-1',
      },
    );
    const setCookie = response.get('set-cookie');
    expect(setCookie).toBeTruthy();

    const sessionId = sessionIdFromCookie(setCookie!);
    const sessionRequest = cookieRequest(setCookie!);
    const session = await storage.getAuthSession(sessionRequest);

    expect(session).toMatchObject({
      sessionId,
      userId: 'user-1',
      accessToken: 'access-token',
      sid: 'sid-1',
      sessionState: 'state-1',
    });
    expect(redisMock.state.pipelineExecutions).toEqual([
      expect.arrayContaining([
        expect.stringContaining('sadd spine-test:session:index:user:user-1'),
        expect.stringContaining('expire spine-test:session:index:user:user-1 60'),
      ]),
    ]);

    const sessionEntry = redisMock.state.entries.get(`spine-test:session:${sessionId}`);
    expect(sessionEntry?.expiresAt).toBeTypeOf('number');
    expect(await storage.listAuthSessionDataForUser('user-1')).toHaveLength(1);
    expect(await storage.destroyAuthSessionById(sessionId)).toBe(true);
    expect(await storage.listAuthSessionDataForUser('user-1')).toEqual([]);
  });

  it('handles OAuth state keys, expiry cleanup, Redis errors, and graceful quit', async () => {
    const stateId = await storage.createOAuthState({
      state: 'oauth-state',
      codeVerifier: 'verifier',
      returnUrl: 'https://app.example.test/callback',
      createdAt: Date.now(),
    });
    expect(await storage.getOAuthState(stateId)).toEqual({
      state: 'oauth-state',
      codeVerifier: 'verifier',
      returnUrl: 'https://app.example.test/callback',
      createdAt: expect.any(Number),
    });

    const oauthKey = `spine-test:oauth:state:${stateId}`;
    const oauthEntry = redisMock.state.entries.get(oauthKey);
    expect(oauthEntry?.expiresAt).toBeTypeOf('number');
    oauthEntry!.expiresAt = null;
    await expect(storage.cleanupExpiredOAuthStates()).resolves.toBe(1);
    await expect(storage.getOAuthState(stateId)).resolves.toBeNull();

    const client = redisMock.state.clients[0];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const redisError = new Error('Redis unavailable');
    client.emit('error', redisError);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Redis Client Error'));

    await storage.closeRedisConnection();
    expect(client.quitCalled).toBe(true);
    expect(redisMock.state.clients).toHaveLength(1);

    await storage.createOAuthState({ state: 'new-state' });
    expect(redisMock.state.clients).toHaveLength(2);
  });

  it('preserves getOAuthState compatibility while supporting strict callback reads', async () => {
    const stateId = 'malformed-state-id';
    redisMock.state.entries.set(`spine-test:oauth:state:${stateId}`, {
      kind: 'string',
      value: '{malformed',
      expiresAt: null,
    });

    await expect(storage.getOAuthState(stateId)).resolves.toBeNull();
    await expect(
      storage.getOAuthState(stateId, { throwOnMalformed: true }),
    ).rejects.toThrow('OAuth state storage failure');
  });
});
