import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  updateAuthSession: vi.fn(async () => new Headers()),
}));

vi.mock('../../src/auth/redis-session-storage.server', () => ({
  createAuthSession: vi.fn(async () => new Headers()),
  getAuthSession: mocks.getAuthSession,
  updateAuthSession: mocks.updateAuthSession,
  destroyAuthSession: vi.fn(async () => new Headers()),
  isSessionValid: vi.fn(async () => false),
  listAuthSessionDataForUser: vi.fn(async () => []),
  destroyAuthSessionsByIdentitySession: vi.fn(async () => 0),
  destroyAuthSessionsBySid: vi.fn(async () => 0),
  destroyAuthSessionsForUser: vi.fn(async () => 0),
  createOAuthState: vi.fn(async () => 'state-id'),
  getOAuthState: vi.fn(),
  deleteOAuthState: vi.fn(async () => undefined),
  AUTH_ERROR_COOKIE_PREFIX: 'spine',
}));

import { getUser, refreshTokens } from '../../src/auth/auth.server';

const request = new Request('https://app.example.test/protected');
const user = { sub: 'user-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthSession.mockResolvedValue({});
});

describe('Redis-authoritative session checks', () => {
  it('does not return a user from an expired Redis session', async () => {
    mocks.getAuthSession.mockResolvedValue({
      sessionId: 'session-1',
      user,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 1,
    });

    await expect(getUser(request)).resolves.toBeNull();
  });

  it('does not return a user from a session missing its access token', async () => {
    mocks.getAuthSession.mockResolvedValue({
      sessionId: 'session-1',
      user,
      expiresAt: Date.now() + 60_000,
    });

    await expect(getUser(request)).resolves.toBeNull();
  });

  it('does not trust an access token whose JWT expiry predates the Redis session expiry', async () => {
    const expiredPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 })).toString('base64url');
    mocks.getAuthSession.mockResolvedValue({
      sessionId: 'session-1',
      user,
      accessToken: `header.${expiredPayload}.signature`,
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
    });

    await expect(getUser(request)).resolves.toBeNull();
  });

  it('refuses to refresh when the signed Redis session is absent', async () => {
    await expect(refreshTokens(request, 'refresh-token')).resolves.toEqual({
      success: false,
      error: 'No active session',
      shouldLogout: true,
    });
    expect(mocks.updateAuthSession).not.toHaveBeenCalled();
  });

  it('rejects a refresh token that does not match the Redis session token', async () => {
    mocks.getAuthSession.mockResolvedValue({
      sessionId: 'session-1',
      user,
      accessToken: 'access-token',
      refreshToken: 'session-refresh-token',
      expiresAt: Date.now() + 60_000,
    });

    await expect(refreshTokens(request, 'attacker-refresh-token')).resolves.toEqual({
      success: false,
      error: 'Refresh token does not match active session',
      shouldLogout: true,
    });
  });
});
