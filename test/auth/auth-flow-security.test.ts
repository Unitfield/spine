import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.NODE_ENV = 'production';
  process.env.OIDC_AUTHORITY = 'https://identity.unitfield.com/realms/unitfield';
  process.env.OIDC_CLIENT_ID = 'unitfield-app';
  process.env.OIDC_REDIRECT_URI = 'https://app.unitfield.com/auth/callback';

  return {
    createAuthSession: vi.fn(async () => new Headers()),
    getAuthSession: vi.fn(async () => ({})),
    updateAuthSession: vi.fn(async () => new Headers()),
    destroyAuthSession: vi.fn(async () => new Headers()),
    isSessionValid: vi.fn(() => false),
    listAuthSessionDataForUser: vi.fn(async () => []),
    destroyAuthSessionsByIdentitySession: vi.fn(async () => 0),
    destroyAuthSessionsBySid: vi.fn(async () => 0),
    destroyAuthSessionsForUser: vi.fn(async () => 0),
    createOAuthState: vi.fn(async () => 'state-id'),
    getOAuthState: vi.fn(),
    deleteOAuthState: vi.fn(async () => undefined),
    createOAuthRecoveryRecord: vi.fn(async () => 'recovery-ticket'),
    consumeOAuthRecoveryRecord: vi.fn(async () => null),
    deleteOAuthRecoveryRecord: vi.fn(async () => undefined),
    jwtVerify: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    oidcConfiguration: {
      serverMetadata: vi.fn(() => ({
        issuer: 'https://identity.unitfield.com/realms/unitfield',
        authorization_endpoint: 'https://identity.unitfield.com/authorize',
        jwks_uri: 'https://identity.unitfield.com/realms/unitfield/protocol/openid-connect/certs',
      })),
    },
    discovery: vi.fn(async () => mocks.oidcConfiguration),
    authorizationCodeGrant: vi.fn(),
    randomState: vi.fn(() => 'expected-state'),
    randomNonce: vi.fn(() => 'expected-nonce'),
    randomPKCECodeVerifier: vi.fn(() => 'pkce-verifier'),
  };
});

vi.mock('../../src/auth/redis-session-storage.server', () => ({
  AUTH_ERROR_COOKIE_PREFIX: 'unitfield',
  createAuthSession: mocks.createAuthSession,
  getAuthSession: mocks.getAuthSession,
  updateAuthSession: mocks.updateAuthSession,
  destroyAuthSession: mocks.destroyAuthSession,
  isSessionValid: mocks.isSessionValid,
  listAuthSessionDataForUser: mocks.listAuthSessionDataForUser,
  destroyAuthSessionsByIdentitySession: mocks.destroyAuthSessionsByIdentitySession,
  destroyAuthSessionsBySid: mocks.destroyAuthSessionsBySid,
  destroyAuthSessionsForUser: mocks.destroyAuthSessionsForUser,
  createOAuthState: mocks.createOAuthState,
  getOAuthState: mocks.getOAuthState,
  deleteOAuthState: mocks.deleteOAuthState,
  createOAuthRecoveryRecord: mocks.createOAuthRecoveryRecord,
  consumeOAuthRecoveryRecord: mocks.consumeOAuthRecoveryRecord,
  deleteOAuthRecoveryRecord: mocks.deleteOAuthRecoveryRecord,
}));

vi.mock('../../src/logging', () => ({ logger: mocks.logger }));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();

  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => vi.fn()),
    jwtVerify: mocks.jwtVerify,
  };
});

vi.mock('openid-client', () => ({
  ResponseBodyError: class ResponseBodyError extends Error {},
  allowInsecureRequests: Symbol('allowInsecureRequests'),
  discovery: mocks.discovery,
  None: vi.fn(() => ({})),
  ClientSecretBasic: vi.fn(() => ({})),
  ClientSecretPost: vi.fn(() => ({})),
  randomPKCECodeVerifier: mocks.randomPKCECodeVerifier,
  calculatePKCECodeChallenge: vi.fn(async () => 'pkce-challenge'),
  randomState: mocks.randomState,
  randomNonce: mocks.randomNonce,
  authorizationCodeGrant: mocks.authorizationCodeGrant,
  buildAuthorizationUrl: vi.fn(
    () => new URL('https://identity.unitfield.com/authorize?client_id=unitfield-app'),
  ),
}));

import {
  clearAuthServerCache,
  handleBackChannelLogout,
  handleCallback,
  login,
  logout,
} from '../../src/auth/auth.server';
import {
  OAuthCallbackError,
  isOAuthCallbackError,
  isRecoverableOAuthCallbackError,
} from '../../src/auth/callback-errors';
import { errors as joseErrors } from 'jose';
import {
  getScopedOAuthCookieName,
  MAX_PENDING_OAUTH_TRANSACTIONS,
  OAUTH_RECOVERY_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
} from '../../src/auth/oauth-transaction-cookies.server';
import { consumeOAuthRecoveryIntent } from '../../src/auth/oauth-recovery.server';
import type { OAuthState } from '../../src/auth/types';

function serializedLogCalls(): string {
  return JSON.stringify(Object.values(mocks.logger).flatMap((log) => log.mock.calls));
}

function validOAuthState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'expected-state',
    codeVerifier: 'pkce-verifier',
    nonce: 'expected-nonce',
    returnUrl: '/dashboard',
    createdAt: Date.now(),
    ...overrides,
  };
}

function requestWithCallback(
  query: string,
  cookie = 'unitfield_oauth_state_id=state-id',
): Request {
  return new Request(`https://app.unitfield.com/auth/callback?${query}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

async function getCallbackFailure(request: Request): Promise<OAuthCallbackError> {
  try {
    await handleCallback(request);
  } catch (error) {
    if (isOAuthCallbackError(error)) {
      return error;
    }

    throw error;
  }

  throw new Error('Expected handleCallback to fail');
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAuthServerCache();
  mocks.createOAuthState.mockReset();
  mocks.createOAuthState.mockResolvedValue('state-id');
  mocks.randomState.mockReset();
  mocks.randomState.mockReturnValue('expected-state');
  mocks.randomNonce.mockReset();
  mocks.randomNonce.mockReturnValue('expected-nonce');
  mocks.randomPKCECodeVerifier.mockReset();
  mocks.randomPKCECodeVerifier.mockReturnValue('pkce-verifier');
  mocks.createAuthSession.mockResolvedValue(new Headers());
  mocks.destroyAuthSession.mockResolvedValue(new Headers());
  mocks.destroyAuthSessionsByIdentitySession.mockResolvedValue(0);
  mocks.getOAuthState.mockReset();
  mocks.getOAuthState.mockResolvedValue(undefined);
  mocks.deleteOAuthState.mockReset();
  mocks.deleteOAuthState.mockResolvedValue(undefined);
  mocks.createOAuthRecoveryRecord.mockReset();
  mocks.createOAuthRecoveryRecord.mockResolvedValue('recovery-ticket');
  mocks.consumeOAuthRecoveryRecord.mockReset();
  mocks.consumeOAuthRecoveryRecord.mockResolvedValue({ state: 'expected-state', returnUrl: '/dashboard', createdAt: Date.now() });
  mocks.deleteOAuthRecoveryRecord.mockReset();
  mocks.deleteOAuthRecoveryRecord.mockResolvedValue(undefined);
  mocks.jwtVerify.mockReset();
  mocks.discovery.mockReset();
  mocks.discovery.mockResolvedValue(mocks.oidcConfiguration);
  mocks.authorizationCodeGrant.mockReset();
  mocks.oidcConfiguration.serverMetadata.mockReturnValue({
    issuer: 'https://identity.unitfield.com/realms/unitfield',
    authorization_endpoint: 'https://identity.unitfield.com/authorize',
    jwks_uri: 'https://identity.unitfield.com/realms/unitfield/protocol/openid-connect/certs',
  });
});

describe('OAuth flow security boundaries', () => {
  it('stores a safe local return URL without logging its invitation token', async () => {
    const invitationToken = 'invite-secret-123';
    const response = await login(
      new Request('https://app.unitfield.com/auth/login'),
      `/invitations/accept?token=${invitationToken}&next=%2Fdashboard`,
    );

    expect(mocks.createOAuthState).toHaveBeenCalledWith(
      expect.objectContaining({
        returnUrl: `/invitations/accept?token=${invitationToken}&next=%2Fdashboard`,
      }),
    );
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(serializedLogCalls()).not.toContain(invitationToken);
    expect(serializedLogCalls()).not.toContain('/invitations/accept?');
  });

  it('issues an opaque recovery ticket only for ordinary login transactions', async () => {
    const ordinary = await login(
      new Request('https://app.unitfield.com/auth/login'),
      '/dashboard',
    );

    expect(ordinary.headers.getSetCookie()).toEqual(expect.arrayContaining([
      expect.stringMatching(
        /^unitfield_oauth_recovery_[a-f0-9]{64}=recovery-ticket; Path=\/auth\/callback; HttpOnly; SameSite=Lax; Max-Age=1800; Secure$/,
      ),
    ]));
    expect(ordinary.headers.getSetCookie().join('\n')).not.toContain('=1;');

    mocks.createOAuthRecoveryRecord.mockClear();
    const action = await login(
      new Request('https://app.unitfield.com/auth/login'),
      { returnUrl: '/dashboard', kcAction: 'webauthn-register' },
    );

    expect(mocks.createOAuthRecoveryRecord).not.toHaveBeenCalled();
    expect(action.headers.getSetCookie().some((cookie) => cookie.startsWith('unitfield_oauth_recovery'))).toBe(false);
  });

  it.each([
    'https://attacker.example/steal',
    '//attacker.example/steal',
    '/\\attacker.example/steal',
  ])('replaces an unsafe login return URL with the local root: %s', async (returnUrl) => {
    await login(new Request('https://app.unitfield.com/auth/login'), returnUrl);

    expect(mocks.createOAuthState).toHaveBeenCalledWith(
      expect.objectContaining({ returnUrl: '/' }),
    );
  });

  it('revalidates persisted OAuth state before the callback redirect', async () => {
    mocks.getOAuthState.mockResolvedValue({
      state: 'expected-state',
      codeVerifier: 'pkce-verifier',
      nonce: 'expected-nonce',
      returnUrl: 'https://attacker.example/steal',
      createdAt: Date.now(),
    });

    const response = await handleCallback(
      new Request(
        'https://app.unitfield.com/auth/callback?state=expected-state&kc_action_status=success',
        { headers: { Cookie: 'unitfield_oauth_state_id=state-id' } },
      ),
    );

    expect(response.headers.get('location')).toBe('/?kc_action_status=success');
    expect(response.headers.get('location')).not.toContain('attacker.example');
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  it('preserves a safe local invitation path through the callback without logging its query', async () => {
    const invitationToken = 'persisted-invite-secret-789';
    mocks.getOAuthState.mockResolvedValue({
      state: 'expected-state',
      codeVerifier: 'pkce-verifier',
      nonce: 'expected-nonce',
      returnUrl: `/invitations/accept?token=${invitationToken}&next=%2Fdashboard`,
      createdAt: Date.now(),
    });

    const response = await handleCallback(
      new Request(
        'https://app.unitfield.com/auth/callback?state=expected-state&kc_action_status=success',
        { headers: { Cookie: 'unitfield_oauth_state_id=state-id' } },
      ),
    );

    expect(response.headers.get('location')).toBe(
      `/invitations/accept?token=${invitationToken}&next=%2Fdashboard&kc_action_status=success`,
    );
    expect(serializedLogCalls()).not.toContain(invitationToken);
    expect(serializedLogCalls()).not.toContain('/invitations/accept?');
  });

  it('never logs raw callback query values and secures error cookies in production', async () => {
    const invitationToken = 'callback-invite-secret-456';
    const response = await handleCallback(
      new Request(
        `https://app.unitfield.com/auth/callback?error=access_denied&error_description=${invitationToken}&invitation_token=${invitationToken}`,
      ),
    );

    expect(response.headers.get('location')).toBe('https://app.unitfield.com/auth/login');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(response.headers.getSetCookie().join('\n')).not.toContain(invitationToken);
    expect(serializedLogCalls()).not.toContain(invitationToken);
    expect(serializedLogCalls()).not.toContain('error_description');
    expect(serializedLogCalls()).not.toContain('invitation_token');
  });

  it('secures and redacts the temporary logout return cookie in production', async () => {
    const returnToken = 'logout-return-secret-123';
    const response = await logout(new Request(
      `https://app.unitfield.com/auth/logout?logout=local&returnUrl=${encodeURIComponent(`/signed-out?token=${returnToken}`)}`,
    ));

    expect(response.headers.get('location')).toBe(
      `https://app.unitfield.com/signed-out?token=${returnToken}`,
    );
    expect(response.headers.get('set-cookie')).toContain('logout_return_url=');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(serializedLogCalls()).not.toContain(returnToken);
  });
});

describe('parallel OAuth transactions', () => {
  function useTransactionStore() {
    const states = new Map<string, OAuthState>();
    const recoveries = new Map<string, { state: string; returnUrl: string; createdAt: number }>();
    let transaction = 0;
    mocks.randomState.mockImplementation(() => `state-${++transaction}`);
    mocks.randomNonce.mockImplementation(() => `nonce-${transaction}`);
    mocks.randomPKCECodeVerifier.mockImplementation(() => `verifier-${transaction + 1}`);
    mocks.createOAuthState.mockImplementation(async (state: OAuthState) => {
      const id = `id-${transaction}`;
      states.set(id, state);
      return id;
    });
    mocks.getOAuthState.mockImplementation(async (id: string) => states.get(id) ?? null);
    mocks.deleteOAuthState.mockImplementation(async (id: string, expectedState?: string) => {
      if (expectedState === undefined || states.get(id)?.state === expectedState) states.delete(id);
    });
    mocks.createOAuthRecoveryRecord.mockImplementation(async (record) => {
      const ticket = `ticket-${transaction}`;
      recoveries.set(ticket, record);
      return ticket;
    });
    mocks.consumeOAuthRecoveryRecord.mockImplementation(async (ticket: string, state: string) => {
      const record = recoveries.get(ticket);
      if (!record || record.state !== state) return null;
      recoveries.delete(ticket);
      return record;
    });
    mocks.authorizationCodeGrant.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      id_token: 'id-token',
      expires_in: 3600,
      claims: () => ({ sub: 'user-1', iss: 'https://identity.unitfield.com/realms/unitfield' }),
    });
    return { states, recoveries };
  }

  function applyCookies(jar: Map<string, string>, headers: Headers) {
    for (const cookie of headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      if (cookie.includes('Max-Age=0')) jar.delete(name);
      else jar.set(name, pair.slice(separator + 1));
    }
  }

  function jarHeader(jar: Map<string, string>): string {
    return Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ');
  }

  async function twoLogins() {
    const store = useTransactionStore();
    const jar = new Map<string, string>();
    for (const returnUrl of ['/properties?tab=first', '/properties?tab=second']) {
      const response = await login(
        new Request('https://app.unitfield.com/auth/login', { headers: { Cookie: jarHeader(jar) } }),
        returnUrl,
      );
      applyCookies(jar, response.headers);
    }
    expect(jar.size).toBe(4);
    return { ...store, jar };
  }

  it.each([[1, 2], [2, 1]])('completes callbacks in order %i then %i without touching the other flow', async (first, second) => {
    const { states, recoveries, jar } = await twoLogins();
    for (const [index, current] of [first, second].entries()) {
      const response = await handleCallback(requestWithCallback(
        `code=code-${current}&state=state-${current}`, jarHeader(jar),
      ));
      expect(response.headers.get('location')).toBe(`/properties?tab=${current === 1 ? 'first' : 'second'}`);
      expect(mocks.authorizationCodeGrant).toHaveBeenLastCalledWith(
        expect.anything(), expect.any(URL), expect.objectContaining({
          pkceCodeVerifier: `verifier-${current}`,
          expectedState: `state-${current}`,
          expectedNonce: `nonce-${current}`,
        }),
      );
      const cleared = response.headers.getSetCookie();
      expect(cleared.filter((cookie) => cookie.includes('oauth_'))).toHaveLength(2);
      expect(cleared.join('\n')).not.toContain(getScopedOAuthCookieName(OAUTH_STATE_COOKIE_NAME, `state-${current === 1 ? 2 : 1}`));
      applyCookies(jar, response.headers);
      expect(states.size).toBe(1 - index);
      expect(recoveries.size).toBe(1 - index);
      expect(jar.size).toBe((1 - index) * 2);
    }
  });

  it('isolates token exchange failure and keeps the second tab completable', async () => {
    const { states, recoveries, jar } = await twoLogins();
    mocks.authorizationCodeGrant.mockRejectedValueOnce(new Error('provider failure'));
    const failure = await getCallbackFailure(requestWithCallback('code=code-1&state=state-1', jarHeader(jar)));
    expect(failure.code).toBe('token_exchange_failed');
    applyCookies(jar, failure.cleanupHeaders);
    expect(states.has('id-1')).toBe(false);
    expect(recoveries.has('ticket-1')).toBe(false);
    expect(states.has('id-2')).toBe(true);
    expect(recoveries.has('ticket-2')).toBe(true);
    const second = await handleCallback(requestWithCallback('code=code-2&state=state-2', jarHeader(jar)));
    expect(second.headers.get('location')).toBe('/properties?tab=second');
  });

  it('cleans only the provider-error tab and preserves the second tab', async () => {
    const { states, recoveries, jar } = await twoLogins();
    const response = await handleCallback(requestWithCallback('error=access_denied&state=state-1', jarHeader(jar)));
    applyCookies(jar, response.headers);
    expect(states.has('id-1')).toBe(false);
    expect(recoveries.has('ticket-1')).toBe(false);
    expect(states.has('id-2')).toBe(true);
    expect(recoveries.has('ticket-2')).toBe(true);
    expect(jar.has(getScopedOAuthCookieName(OAUTH_STATE_COOKIE_NAME, 'state-2'))).toBe(true);
    expect(jar.has(getScopedOAuthCookieName(OAUTH_RECOVERY_COOKIE_NAME, 'state-2'))).toBe(true);
  });

  it('preserves pending records and cookies for provider errors without a usable state', async () => {
    const { states, recoveries, jar } = await twoLogins();
    jar.set(OAUTH_STATE_COOKIE_NAME, 'legacy-id');
    jar.set(OAUTH_RECOVERY_COOKIE_NAME, 'legacy-ticket');
    const response = await handleCallback(requestWithCallback('error=access_denied', jarHeader(jar)));
    expect(response.headers.getSetCookie().filter((cookie) => cookie.includes('oauth_'))).toEqual([]);
    expect(mocks.deleteOAuthState).not.toHaveBeenCalled();
    expect(mocks.consumeOAuthRecoveryRecord).not.toHaveBeenCalled();
    expect(states.size).toBe(2);
    expect(recoveries.size).toBe(2);
  });

  it('uses only the expired tab original recovery intent once and preserves the fresh tab', async () => {
    const { states, recoveries, jar } = await twoLogins();
    states.get('id-1')!.createdAt -= 10 * 60 * 1000 + 1;
    const callback = requestWithCallback('code=code-1&state=state-1&returnUrl=%2Fevil&complete=1', jarHeader(jar));
    const failure = await getCallbackFailure(callback);
    expect(failure.code).toBe('stale_transaction');
    expect(recoveries.has('ticket-1')).toBe(true);
    const recovery = await consumeOAuthRecoveryIntent(callback, failure);
    expect(recovery.intent).toEqual({ returnUrl: '/properties?tab=first' });
    expect((await consumeOAuthRecoveryIntent(callback, failure)).intent).toBeNull();
    applyCookies(jar, failure.cleanupHeaders);
    applyCookies(jar, recovery.cleanupHeaders);
    expect(states.has('id-2')).toBe(true);
    expect(recoveries.has('ticket-2')).toBe(true);
    expect(jar.size).toBe(2);
  });

  it('cannot replay a completed callback or reuse its recovery budget', async () => {
    const { states, recoveries, jar } = await twoLogins();
    const callback = requestWithCallback('code=code-1&state=state-1', jarHeader(jar));
    await handleCallback(callback);
    const replay = await getCallbackFailure(callback);
    expect(replay.code).toBe('stale_transaction');
    expect((await consumeOAuthRecoveryIntent(callback, replay)).intent).toBeNull();
    expect(mocks.authorizationCodeGrant).toHaveBeenCalledTimes(1);
    expect(states.has('id-2')).toBe(true);
    expect(recoveries.has('ticket-2')).toBe(true);
  });

  it.each(['%', '', 'bad/value', 'x'.repeat(769)])('rejects malformed matching scoped cookies without legacy fallback: %s', async (value) => {
    const scopedName = getScopedOAuthCookieName(OAUTH_STATE_COOKIE_NAME, 'expected-state');
    const callback = requestWithCallback('code=code&state=expected-state',
      `${scopedName}=${value}; unitfield_oauth_state_id=legacy-id; unitfield_oauth_recovery=legacy-ticket`,
    );
    const failure = await getCallbackFailure(callback);
    expect(failure.code).toBe('malformed_callback');
    expect(mocks.getOAuthState).not.toHaveBeenCalled();
    expect(mocks.deleteOAuthState).not.toHaveBeenCalled();
    expect(mocks.consumeOAuthRecoveryRecord).not.toHaveBeenCalled();
    expect((await consumeOAuthRecoveryIntent(callback, failure)).intent).toBeNull();
    expect(failure.cleanupSetCookies.join('\n')).not.toContain('unitfield_oauth_state_id=');
    expect(failure.cleanupSetCookies.join('\n')).not.toContain('unitfield_oauth_recovery=');
  });

  it('rejects duplicate scoped cookies before reading either pointer', async () => {
    const name = getScopedOAuthCookieName(OAUTH_STATE_COOKIE_NAME, 'expected-state');
    const failure = await getCallbackFailure(requestWithCallback('code=code&state=expected-state', `${name}=id-a; ${name}=id-b; unitfield_oauth_state_id=legacy-id`));
    expect(failure.code).toBe('malformed_callback');
    expect(mocks.getOAuthState).not.toHaveBeenCalled();
    expect(mocks.deleteOAuthState).not.toHaveBeenCalled();
  });

  it('preserves another tab server records when the scoped pointers contain its IDs', async () => {
    const { states, recoveries, jar } = await twoLogins();
    jar.set(getScopedOAuthCookieName(OAUTH_STATE_COOKIE_NAME, 'state-1'), 'id-2');
    jar.set(getScopedOAuthCookieName(OAUTH_RECOVERY_COOKIE_NAME, 'state-1'), 'ticket-2');
    const failure = await getCallbackFailure(requestWithCallback('code=code-1&state=state-1', jarHeader(jar)));
    expect(failure.code).toBe('state_mismatch');
    expect(states.has('id-2')).toBe(true);
    expect(recoveries.has('ticket-2')).toBe(true);
    applyCookies(jar, failure.cleanupHeaders);
    expect(jar.has(getScopedOAuthCookieName(OAUTH_STATE_COOKIE_NAME, 'state-2'))).toBe(true);
    expect(jar.has(getScopedOAuthCookieName(OAUTH_RECOVERY_COOKIE_NAME, 'state-2'))).toBe(true);
  });

  it.each(['code=code', 'code=code&state=', 'code=code&state=state-1&state=state-2', `code=code&state=${'a'.repeat(4097)}`])('does not select or clear pending records for invalid callback state', async (query) => {
    const { states, recoveries, jar } = await twoLogins();
    jar.set(OAUTH_STATE_COOKIE_NAME, 'legacy-id');
    jar.set(OAUTH_RECOVERY_COOKIE_NAME, 'legacy-ticket');
    const callback = requestWithCallback(query, jarHeader(jar));
    const failure = await getCallbackFailure(callback);
    expect(failure.code).toBe('malformed_callback');
    expect(failure.cleanupSetCookies.filter((cookie) => cookie.includes('oauth_'))).toEqual([]);
    expect(mocks.getOAuthState).not.toHaveBeenCalled();
    expect(mocks.deleteOAuthState).not.toHaveBeenCalled();
    expect(mocks.consumeOAuthRecoveryRecord).not.toHaveBeenCalled();
    expect((await consumeOAuthRecoveryIntent(callback, failure)).cleanupSetCookies).toEqual([]);
    expect(states.size).toBe(2);
    expect(recoveries.size).toBe(2);
  });

  it('supports a genuine legacy pending callback while leaving scoped tabs untouched', async () => {
    const { states, recoveries, jar } = await twoLogins();
    states.set('legacy-id', { ...validOAuthState(), state: 'legacy-state' } as OAuthState);
    recoveries.set('legacy-ticket', { state: 'legacy-state', returnUrl: '/legacy', createdAt: Date.now() });
    jar.set(OAUTH_STATE_COOKIE_NAME, 'legacy-id');
    jar.set(OAUTH_RECOVERY_COOKIE_NAME, 'legacy-ticket');
    const response = await handleCallback(requestWithCallback('code=legacy-code&state=legacy-state', jarHeader(jar)));
    expect(response.headers.get('location')).toBe('/dashboard');
    expect(response.headers.getSetCookie().join('\n')).toContain(`${OAUTH_STATE_COOKIE_NAME}=;`);
    expect(response.headers.getSetCookie().join('\n')).toContain(`${OAUTH_RECOVERY_COOKIE_NAME}=;`);
    applyCookies(jar, response.headers);
    expect(states.size).toBe(2);
    expect(recoveries.size).toBe(2);
    expect(jar.size).toBe(4);
  });

  it('does not burn a legacy pending flow on a callback for another state', async () => {
    const { states, recoveries } = useTransactionStore();
    states.set('legacy-id', { ...validOAuthState(), state: 'legacy-state' } as OAuthState);
    recoveries.set('legacy-ticket', { state: 'legacy-state', returnUrl: '/legacy', createdAt: Date.now() });
    const callback = requestWithCallback('code=code&state=wrong-state', `${OAUTH_STATE_COOKIE_NAME}=legacy-id; ${OAUTH_RECOVERY_COOKIE_NAME}=legacy-ticket`);
    const failure = await getCallbackFailure(callback);
    expect(failure.code).toBe('state_mismatch');
    expect(failure.cleanupSetCookies.filter((cookie) => cookie.includes('oauth_'))).toEqual([]);
    expect((await consumeOAuthRecoveryIntent(callback, failure)).cleanupSetCookies).toEqual([]);
    expect(states.has('legacy-id')).toBe(true);
    expect(recoveries.has('legacy-ticket')).toBe(true);
  });

  it('rejects a ninth pending login before creating state and preserves all active flows', async () => {
    const { states, recoveries } = useTransactionStore();
    const jar = new Map<string, string>();
    for (let count = 0; count < MAX_PENDING_OAUTH_TRANSACTIONS; count++) {
      applyCookies(jar, (await login(new Request('https://app.unitfield.com/auth/login', { headers: { Cookie: jarHeader(jar) } }))).headers);
    }
    await expect(login(new Request('https://app.unitfield.com/auth/login', { headers: { Cookie: jarHeader(jar) } }))).rejects.toThrow('Login failed');
    expect(mocks.createOAuthState).toHaveBeenCalledTimes(MAX_PENDING_OAUTH_TRANSACTIONS);
    expect(mocks.deleteOAuthState).not.toHaveBeenCalled();
    expect(states.size).toBe(MAX_PENDING_OAUTH_TRANSACTIONS);
    expect(recoveries.size).toBe(MAX_PENDING_OAUTH_TRANSACTIONS);
  });

  it('cleans only the newly generated state when recovery creation fails', async () => {
    const { states, recoveries, jar } = await twoLogins();
    mocks.createOAuthRecoveryRecord.mockRejectedValueOnce(new Error('storage secret'));
    await expect(login(new Request('https://app.unitfield.com/auth/login', { headers: { Cookie: jarHeader(jar) } }))).rejects.toThrow('Login failed');
    expect(mocks.deleteOAuthState).toHaveBeenCalledWith('id-3', 'state-3');
    expect(states.size).toBe(2);
    expect(recoveries.size).toBe(2);
    expect(serializedLogCalls()).not.toContain('storage secret');
  });
});

describe('OAuth callback recovery contract', () => {
  it('marks a valid callback with a missing OAuth cookie as the only recoverable failure', async () => {
    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code&state=expected-state', ''),
    );

    expect(failure.code).toBe('stale_transaction');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(true);
    expect(mocks.getOAuthState).not.toHaveBeenCalled();
    expect(mocks.destroyAuthSession).toHaveBeenCalledOnce();
    expect(failure.cleanupHeaders.getSetCookie()).toEqual([
      `${getScopedOAuthCookieName(OAUTH_STATE_COOKIE_NAME, 'expected-state')}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    ]);
  });

  it('marks an absent Redis transaction as recoverable stale state', async () => {
    mocks.getOAuthState.mockResolvedValue(null);

    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code&state=expected-state'),
    );

    expect(failure.code).toBe('stale_transaction');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(true);
    expect(mocks.deleteOAuthState).toHaveBeenCalledWith('state-id', 'expected-state');
    expect(failure.cleanupHeaders.getSetCookie()).toContain(
      'unitfield_oauth_state_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
  });

  it('leaves the server recovery ticket for the adapter after a clean stale failure', async () => {
    mocks.getOAuthState.mockResolvedValue(null);

    const failure = await getCallbackFailure(
      requestWithCallback(
        'code=authorization-code&state=expected-state',
        'unitfield_oauth_state_id=state-id; unitfield_oauth_recovery=recovery-ticket',
      ),
    );

    expect(failure.code).toBe('stale_transaction');
    expect(mocks.consumeOAuthRecoveryRecord).not.toHaveBeenCalled();
    expect(failure.cleanupHeaders.getSetCookie()).not.toContain(
      'unitfield_oauth_recovery=; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
  });

  it('rejects an OpenID transaction without a nonce before token exchange', async () => {
    mocks.getOAuthState.mockResolvedValue(validOAuthState({ nonce: undefined }));

    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code&state=expected-state'),
    );

    expect(failure.code).toBe('storage_error');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(mocks.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('downgrades stale recovery when OAuth-state cleanup fails', async () => {
    mocks.getOAuthState.mockResolvedValue(null);
    mocks.deleteOAuthState.mockRejectedValue(new Error('Redis cleanup unavailable'));
    const sessionHeaders = new Headers();
    sessionHeaders.append('Set-Cookie', 'session-cleanup=; Max-Age=0');
    mocks.destroyAuthSession.mockResolvedValue(sessionHeaders);

    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code&state=expected-state'),
    );

    expect(failure.code).toBe('storage_error');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(failure.cleanupHeaders.getSetCookie()).toEqual([
      'session-cleanup=; Max-Age=0',
      'unitfield_oauth_state_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    ]);
    expect(serializedLogCalls()).not.toContain('Redis cleanup unavailable');
  });

  it('downgrades stale recovery when auth-session cleanup fails', async () => {
    mocks.getOAuthState.mockResolvedValue(null);
    mocks.destroyAuthSession.mockRejectedValue(new Error('session cleanup unavailable'));

    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code&state=expected-state'),
    );

    expect(failure.code).toBe('storage_error');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(failure.cleanupHeaders.getSetCookie()).toEqual([
      'unitfield_oauth_state_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    ]);
    expect(serializedLogCalls()).not.toContain('session cleanup unavailable');
  });

  it('burns the recovery ticket when stale cleanup fails', async () => {
    mocks.getOAuthState.mockResolvedValue(null);
    mocks.destroyAuthSession.mockRejectedValue(new Error('session cleanup unavailable'));

    const failure = await getCallbackFailure(
      requestWithCallback(
        'code=authorization-code&state=expected-state',
        'unitfield_oauth_state_id=state-id; unitfield_oauth_recovery=recovery-ticket',
      ),
    );

    expect(failure.code).toBe('storage_error');
    expect(mocks.consumeOAuthRecoveryRecord).toHaveBeenCalledWith('recovery-ticket', 'expected-state');
    expect(failure.cleanupHeaders.getSetCookie()).toContain(
      'unitfield_oauth_recovery=; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
  });

  it('marks an explicitly aged transaction as recoverable stale state', async () => {
    mocks.getOAuthState.mockResolvedValue(
      validOAuthState({ createdAt: Date.now() - 10 * 60 * 1000 - 1 }),
    );

    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code&state=expected-state'),
    );

    expect(failure.code).toBe('stale_transaction');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(true);
  });

  it('classifies missing callback state before transaction lookup', async () => {
    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code', ''),
    );

    expect(failure.code).toBe('malformed_callback');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(mocks.getOAuthState).not.toHaveBeenCalled();
  });

  it('classifies missing callback code as malformed', async () => {
    const failure = await getCallbackFailure(
      requestWithCallback('state=expected-state'),
    );

    expect(failure.code).toBe('malformed_callback');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(mocks.getOAuthState).not.toHaveBeenCalled();
  });

  it('keeps exact state mismatches non-recoverable', async () => {
    mocks.getOAuthState.mockResolvedValue(validOAuthState());

    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code&state=attacker-state'),
    );

    expect(failure.code).toBe('state_mismatch');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(mocks.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('does not turn Redis or JSON failures into stale recovery', async () => {
    mocks.getOAuthState.mockRejectedValue(new SyntaxError('Unexpected token in state'));

    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code&state=expected-state'),
    );

    expect(failure.code).toBe('storage_error');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(failure.message).toBe('Authentication failed');
    expect(serializedLogCalls()).not.toContain('Unexpected token in state');
  });

  it('classifies discovery and configuration failures as non-recoverable', async () => {
    mocks.getOAuthState.mockResolvedValue(validOAuthState());
    mocks.discovery.mockRejectedValue(new Error('provider configuration secret'));

    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code&state=expected-state'),
    );

    expect(failure.code).toBe('configuration_error');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(failure.message).toBe('Authentication failed');
    expect(serializedLogCalls()).not.toContain('provider configuration secret');
  });

  it('classifies token exchange failures without exposing provider details', async () => {
    mocks.getOAuthState.mockResolvedValue(validOAuthState());
    mocks.authorizationCodeGrant.mockRejectedValue(new Error('invalid_grant provider-secret'));

    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code&state=expected-state'),
    );

    expect(failure.code).toBe('token_exchange_failed');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(failure.message).toBe('Authentication failed');
    expect(serializedLogCalls()).not.toContain('provider-secret');
  });

  it('classifies session creation failures as non-recoverable', async () => {
    mocks.getOAuthState.mockResolvedValue(validOAuthState());
    mocks.authorizationCodeGrant.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      id_token: 'id-token',
      expires_in: 3600,
      claims: () => ({
        sub: 'user-1',
        email: 'user@example.com',
        iss: 'https://identity.unitfield.com/realms/unitfield',
      }),
    });
    mocks.createAuthSession.mockRejectedValue(new Error('session store unavailable'));

    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code&state=expected-state'),
    );

    expect(failure.code).toBe('session_creation_failed');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(mocks.authorizationCodeGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(URL),
      expect.objectContaining({
        pkceCodeVerifier: 'pkce-verifier',
        expectedState: 'expected-state',
        expectedNonce: 'expected-nonce',
      }),
    );
    expect(serializedLogCalls()).not.toContain('session store unavailable');
  });

  it('exposes cleanup cookies without collapsing repeated Set-Cookie headers', async () => {
    mocks.getOAuthState.mockResolvedValue(validOAuthState());
    mocks.authorizationCodeGrant.mockRejectedValue(new Error('exchange failed'));
    const sessionHeaders = new Headers();
    sessionHeaders.append('Set-Cookie', 'session-a=; Max-Age=0');
    sessionHeaders.append('Set-Cookie', 'session-b=; Max-Age=0');
    mocks.destroyAuthSession.mockResolvedValue(sessionHeaders);

    const failure = await getCallbackFailure(
      requestWithCallback('code=authorization-code&state=expected-state'),
    );

    expect(failure.cleanupHeaders.getSetCookie()).toEqual([
      'session-a=; Max-Age=0',
      'session-b=; Max-Age=0',
      'unitfield_oauth_state_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    ]);
    expect(failure.cleanupSetCookies).toEqual(failure.cleanupHeaders.getSetCookie());
  });

  it('preserves provider access-denied behavior while clearing the OAuth cookie', async () => {
    const response = await handleCallback(
      requestWithCallback(
        'error=access_denied&error_description=No+access&state=expected-state',
        'unitfield_oauth_state_id=state-id; unitfield_oauth_recovery=recovery-ticket',
      ),
    );

    expect(response.headers.get('location')).toBe('https://app.unitfield.com/auth/login');
    expect(mocks.deleteOAuthState).toHaveBeenCalledWith('state-id', 'expected-state');
    expect(response.headers.getSetCookie().join('\n')).not.toContain('No%20access');
    expect(response.headers.getSetCookie()).toContain(
      'unitfield_oauth_state_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
    expect(mocks.consumeOAuthRecoveryRecord).toHaveBeenCalledWith('recovery-ticket', 'expected-state');
    expect(response.headers.getSetCookie()).toContain(
      'unitfield_oauth_recovery=; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
  });

  it('preserves login-required provider handling without recovery', async () => {
    const response = await handleCallback(
      requestWithCallback('error=login_required&state=expected-state'),
    );

    expect(response.headers.get('location')).toBe('https://app.unitfield.com');
    expect(mocks.deleteOAuthState).toHaveBeenCalledWith('state-id', 'expected-state');
    expect(response.headers.getSetCookie()).toContain(
      'unitfield_oauth_state_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
  });

  it('deletes state and omits untrusted descriptions for generic provider errors', async () => {
    const providerDescription = 'provider-description-secret';
    const response = await handleCallback(
      requestWithCallback(
        `error=temporarily_unavailable&error_description=${providerDescription}&state=expected-state`,
      ),
    );

    expect(response.headers.get('location')).toBe('https://app.unitfield.com');
    expect(mocks.deleteOAuthState).toHaveBeenCalledWith('state-id', 'expected-state');
    expect(response.headers.getSetCookie().join('\n')).not.toContain(providerDescription);
    expect(response.headers.getSetCookie().join('\n')).not.toContain('auth_error_desc');
    expect(serializedLogCalls()).not.toContain(providerDescription);
  });

  it('fails closed when provider-error state cleanup fails', async () => {
    mocks.deleteOAuthState.mockRejectedValue(new Error('provider state cleanup unavailable'));

    const failure = await getCallbackFailure(
      requestWithCallback('error=access_denied&error_description=provider-secret&state=expected-state'),
    );

    expect(failure.code).toBe('storage_error');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(failure.cleanupHeaders.getSetCookie()).toContain(
      'unitfield_oauth_state_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
    expect(serializedLogCalls()).not.toContain('provider state cleanup unavailable');
  });

  it('classifies application-action provider cleanup failure as storage error', async () => {
    mocks.getOAuthState.mockResolvedValue(validOAuthState({ kcAction: 'webauthn-register' }));
    mocks.deleteOAuthState.mockRejectedValueOnce(new Error('action provider delete failed'));
    const sessionHeaders = new Headers();
    sessionHeaders.append('Set-Cookie', 'action-session-a=; Max-Age=0');
    sessionHeaders.append('Set-Cookie', 'action-session-b=; Max-Age=0');
    mocks.destroyAuthSession.mockResolvedValue(sessionHeaders);

    const failure = await getCallbackFailure(
      requestWithCallback(
        'error=access_denied&state=expected-state&kc_action_status=error',
      ),
    );

    expect(failure.code).toBe('storage_error');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(mocks.deleteOAuthState).toHaveBeenCalledTimes(2);
    expect(mocks.authorizationCodeGrant).not.toHaveBeenCalled();
    expect(failure.cleanupHeaders.getSetCookie()).toEqual([
      'action-session-a=; Max-Age=0',
      'action-session-b=; Max-Age=0',
      'unitfield_oauth_state_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    ]);
  });

  it('classifies no-code action cleanup failure as storage error', async () => {
    mocks.getOAuthState.mockResolvedValue(validOAuthState({ kcAction: 'webauthn-register' }));
    mocks.deleteOAuthState.mockRejectedValueOnce(new Error('action result delete failed'));
    const sessionHeaders = new Headers();
    sessionHeaders.append('Set-Cookie', 'action-result-a=; Max-Age=0');
    sessionHeaders.append('Set-Cookie', 'action-result-b=; Max-Age=0');
    mocks.destroyAuthSession.mockResolvedValue(sessionHeaders);

    const failure = await getCallbackFailure(
      requestWithCallback('state=expected-state&kc_action_status=success'),
    );

    expect(failure.code).toBe('storage_error');
    expect(isRecoverableOAuthCallbackError(failure)).toBe(false);
    expect(mocks.deleteOAuthState).toHaveBeenCalledTimes(2);
    expect(mocks.authorizationCodeGrant).not.toHaveBeenCalled();
    expect(failure.cleanupHeaders.getSetCookie()).toEqual([
      'action-result-a=; Max-Age=0',
      'action-result-b=; Max-Age=0',
      'unitfield_oauth_state_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    ]);
  });

  it('preserves application-action callbacks without emitting recovery', async () => {
    mocks.getOAuthState.mockResolvedValue(validOAuthState({ kcAction: 'webauthn-register' }));

    const response = await handleCallback(
      requestWithCallback('state=expected-state&kc_action_status=success'),
    );

    expect(response.headers.get('location')).toBe(
      '/dashboard?kc_action=webauthn-register&kc_action_status=success',
    );
    expect(mocks.authorizationCodeGrant).not.toHaveBeenCalled();
  });
});

describe('OIDC back-channel logout telemetry', () => {
  function createLogoutRequest(logoutToken = 'logout-token'): Request {
    return new Request('https://app.unitfield.com/auth/backchannel-logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ logout_token: logoutToken }),
    });
  }

  it('returns 400 and warns for a malformed untrusted logout token', async () => {
    mocks.jwtVerify.mockRejectedValue(new joseErrors.JWSInvalid('Invalid Compact JWS'));

    const response = await handleBackChannelLogout(createLogoutRequest('invalid'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_logout_token',
      error_description: 'Invalid Compact JWS',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Back-channel logout token rejected',
      expect.objectContaining({ errorCode: 'ERR_JWS_INVALID' }),
    );
    expect(mocks.logger.error).not.toHaveBeenCalledWith(
      'Back-channel logout failed',
      expect.anything(),
    );
  });

  it('returns 400 and warns when verified logout claims violate the protocol', async () => {
    mocks.jwtVerify.mockResolvedValue({
      payload: {
        iss: 'https://identity.unitfield.com/realms/unitfield',
        aud: 'unitfield-app',
        sid: 'identity-session-id',
      },
      protectedHeader: { alg: 'RS256' },
    });

    const response = await handleBackChannelLogout(createLogoutRequest());

    expect(response.status).toBe(400);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Back-channel logout token rejected',
      expect.objectContaining({
        error: expect.stringContaining('missing back-channel logout event'),
      }),
    );
    expect(mocks.logger.error).not.toHaveBeenCalledWith(
      'Back-channel logout failed',
      expect.anything(),
    );
  });

  it('keeps provider configuration failures at error level', async () => {
    mocks.oidcConfiguration.serverMetadata.mockReturnValue({
      issuer: 'https://identity.unitfield.com/realms/unitfield',
      authorization_endpoint: 'https://identity.unitfield.com/authorize',
    });

    const response = await handleBackChannelLogout(createLogoutRequest());

    expect(response.status).toBe(400);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Back-channel logout failed',
      expect.objectContaining({ message: 'OIDC provider does not expose jwks_uri' }),
    );
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      'Back-channel logout token rejected',
      expect.anything(),
    );
  });

  it('keeps provider JWKS availability failures at error level', async () => {
    mocks.jwtVerify.mockRejectedValue(new joseErrors.JWKSTimeout('JWKS request timed out'));

    const response = await handleBackChannelLogout(createLogoutRequest());

    expect(response.status).toBe(400);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Back-channel logout failed',
      expect.objectContaining({
        code: 'ERR_JWKS_TIMEOUT',
        message: 'JWKS request timed out',
      }),
    );
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      'Back-channel logout token rejected',
      expect.anything(),
    );
  });

  it('preserves successful session cleanup and response behavior', async () => {
    mocks.jwtVerify.mockResolvedValue({
      payload: {
        iss: 'https://identity.unitfield.com/realms/unitfield',
        aud: 'unitfield-app',
        sid: 'identity-session-id',
        events: {
          'http://schemas.openid.net/event/backchannel-logout': {},
        },
      },
      protectedHeader: { alg: 'RS256' },
    });
    mocks.destroyAuthSessionsByIdentitySession.mockResolvedValue(2);

    const response = await handleBackChannelLogout(createLogoutRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      destroyedSessions: 2,
      issuer: 'https://identity.unitfield.com/realms/unitfield',
      sid: 'identity-session-id',
    });
    expect(mocks.destroyAuthSessionsByIdentitySession).toHaveBeenCalledWith({
      sid: 'identity-session-id',
      userId: undefined,
    });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'Back-channel logout processed',
      expect.objectContaining({ destroyedSessions: 2 }),
    );
  });
});
