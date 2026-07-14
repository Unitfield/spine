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
  discovery: vi.fn(async () => mocks.oidcConfiguration),
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

import {
  clearAuthServerCache,
  handleBackChannelLogout,
  handleCallback,
  login,
  logout,
} from '../../src/auth/auth.server';
import { errors as joseErrors } from 'jose';

function serializedLogCalls(): string {
  return JSON.stringify(Object.values(mocks.logger).flatMap((log) => log.mock.calls));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAuthServerCache();
  mocks.createOAuthState.mockResolvedValue('state-id');
  mocks.destroyAuthSession.mockResolvedValue(new Headers());
  mocks.destroyAuthSessionsByIdentitySession.mockResolvedValue(0);
  mocks.jwtVerify.mockReset();
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
