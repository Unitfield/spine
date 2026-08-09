import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isOAuthCallbackError } from '../../src/auth/callback-errors';

const mocks = vi.hoisted(() => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    OIDC_AUTHORITY: process.env.OIDC_AUTHORITY,
    OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID,
    OIDC_REDIRECT_URI: process.env.OIDC_REDIRECT_URI,
    OIDC_CLIENT_AUTH_METHOD: process.env.OIDC_CLIENT_AUTH_METHOD,
    OAUTH_STATE_TTL: process.env.OAUTH_STATE_TTL,
  };
  const configuredTtl = 37;

  process.env.NODE_ENV = 'production';
  process.env.OIDC_AUTHORITY = 'https://identity.unitfield.com/realms/unitfield';
  process.env.OIDC_CLIENT_ID = 'unitfield-app';
  process.env.OIDC_REDIRECT_URI = 'https://app.unitfield.com/oidc/callback';
  process.env.OAUTH_STATE_TTL = String(configuredTtl);

  return {
    configuredTtl,
    originalEnv,
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
  };
});

vi.mock('openid-client', () => ({
  ResponseBodyError: class ResponseBodyError extends Error {},
  allowInsecureRequests: Symbol('allowInsecureRequests'),
  discovery: mocks.discovery,
  None: vi.fn(() => ({})),
  ClientSecretBasic: vi.fn(() => ({})),
  ClientSecretPost: vi.fn(() => ({})),
  randomPKCECodeVerifier: vi.fn(() => 'pkce-verifier'),
  calculatePKCECodeChallenge: vi.fn(async () => 'pkce-challenge'),
  randomState: vi.fn(() => 'expected-state'),
  randomNonce: vi.fn(() => 'expected-nonce'),
  buildAuthorizationUrl: vi.fn(
    () => new URL('https://identity.unitfield.com/authorize?client_id=unitfield-app'),
  ),
}));

type Login = typeof import('../../src/auth/auth.server')['login'];
let login: Login;

beforeAll(async () => {
  vi.resetModules();
  ({ login } = await import('../../src/auth/auth.server'));
});

afterAll(() => {
  for (const [key, value] of Object.entries(mocks.originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('OAuth state TTL configuration', () => {
  it('uses the configured TTL for the login OAuth-state cookie', async () => {
    const response = await login(
      new Request('https://app.unitfield.com/auth/login'),
      '/dashboard',
    );

    expect(response.headers.getSetCookie()).toContain(
      `unitfield_oauth_state_id=state-id; Path=/; HttpOnly; SameSite=Lax; Max-Age=${mocks.configuredTtl}; Secure`,
    );
    expect(response.headers.getSetCookie()).not.toContain(
      expect.stringContaining('Max-Age=600'),
    );
    expect(response.headers.getSetCookie()).toContain(
      'unitfield_oauth_recovery=recovery-ticket; Path=/oidc/callback; HttpOnly; SameSite=Lax; Max-Age=1800; Secure',
    );
  });

  it('cleans the OAuth transaction when required OIDC configuration is missing', async () => {
    const originalClientId = mocks.originalEnv.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_ID;
    mocks.getOAuthState.mockClear();
    mocks.deleteOAuthState.mockClear();
    mocks.destroyAuthSession.mockClear();

    try {
      vi.resetModules();
      const { handleCallback } = await import('../../src/auth/auth.server');
      let thrown: unknown;

      try {
        await handleCallback(new Request(
          'https://app.unitfield.com/auth/callback?code=authorization-code&state=expected-state',
          { headers: { Cookie: 'unitfield_oauth_state_id=state-id' } },
        ));
      } catch (error) {
        thrown = error;
      }

      expect(isOAuthCallbackError(thrown)).toBe(true);
      expect(thrown).toMatchObject({
        code: 'configuration_error',
      });
      expect(isOAuthCallbackError(thrown) && thrown.code).not.toBe('stale_transaction');
      expect(mocks.getOAuthState).not.toHaveBeenCalled();
      expect(mocks.deleteOAuthState).toHaveBeenCalledWith('state-id');
      expect(mocks.destroyAuthSession).toHaveBeenCalledOnce();
    } finally {
      if (originalClientId === undefined) {
        delete process.env.OIDC_CLIENT_ID;
      } else {
        process.env.OIDC_CLIENT_ID = originalClientId;
      }
    }
  });
});
