import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  getUser: vi.fn(),
  requireAuth: vi.fn(),
  refreshTokens: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../../src/auth/redis-session-storage.server', () => ({
  getAuthSession: mocks.getAuthSession,
}));

vi.mock('../../src/auth/auth.server', () => ({
  getUser: mocks.getUser,
  requireAuth: mocks.requireAuth,
  refreshTokens: mocks.refreshTokens,
  login: mocks.login,
  logout: mocks.logout,
}));

import {
  configureRouteProtection,
  protectRoute,
  resetRouteProtectionConfig,
  shouldRefreshToken,
} from '../../src/auth/route-protection.server';

const request = new Request('https://app.example.test/protected');
const user = { sub: 'user-1' };

function localLogoutResponse(): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: '/auth/logout?logout=local' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRouteProtectionConfig();
  mocks.getAuthSession.mockResolvedValue({});
  mocks.getUser.mockResolvedValue(user);
  mocks.requireAuth.mockResolvedValue(user);
  mocks.refreshTokens.mockResolvedValue({ success: true });
  mocks.login.mockResolvedValue(new Response(null, {
    status: 302,
    headers: { Location: '/auth/login' },
  }));
  mocks.logout.mockImplementation(async () => localLogoutResponse());
});

describe('route protection session fail-closed behavior', () => {
  it('does not swallow the logout redirect for an expired session without refresh', async () => {
    mocks.getAuthSession.mockResolvedValue({
      user,
      accessToken: 'expired-access-token',
      expiresAt: Date.now() - 1,
    });

    await expect(shouldRefreshToken(request)).rejects.toMatchObject({ status: 302 });
    expect(mocks.logout).toHaveBeenCalledOnce();

    await expect(protectRoute(request, 'auth', async () => 'loaded')).rejects.toMatchObject({
      status: 302,
    });
    expect(mocks.requireAuth).not.toHaveBeenCalled();
  });

  it('logs out when a refresh fails even without a provider logout hint', async () => {
    mocks.getAuthSession.mockResolvedValue({
      user,
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 1,
    });
    mocks.refreshTokens.mockResolvedValue({
      success: false,
      error: 'temporarily unavailable',
      shouldLogout: false,
    });

    await expect(protectRoute(request, 'auth', async () => 'loaded')).rejects.toMatchObject({
      status: 302,
    });
    expect(mocks.refreshTokens).toHaveBeenCalledOnce();
    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.requireAuth).not.toHaveBeenCalled();
  });

  it('keeps the logout redirect visible on optional-auth routes', async () => {
    mocks.getAuthSession.mockResolvedValue({
      user,
      accessToken: 'expired-access-token',
      expiresAt: Date.now() - 1,
    });

    await expect(protectRoute(request, 'public', async () => 'anonymous')).rejects.toMatchObject({
      status: 302,
    });
  });

  it('continues with an authorized user when the session is not near expiry', async () => {
    mocks.getAuthSession.mockResolvedValue({
      user,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    await expect(protectRoute(request, 'auth', async (resolvedUser) => resolvedUser?.sub)).resolves.toBe('user-1');
    expect(mocks.refreshTokens).not.toHaveBeenCalled();
    expect(mocks.requireAuth).toHaveBeenCalledOnce();
  });

  it('fails closed when session lookup itself fails', async () => {
    const storageError = new Error('Redis unavailable');
    mocks.getAuthSession.mockRejectedValue(storageError);

    await expect(shouldRefreshToken(request)).rejects.toBe(storageError);
    await expect(protectRoute(request, 'auth', async () => 'loaded')).rejects.toMatchObject({
      status: 302,
    });
    expect(mocks.login).toHaveBeenCalledOnce();
  });
});

describe('configured route protection redirects', () => {
  it('preserves policy redirects after refresh checks', async () => {
    mocks.getAuthSession.mockResolvedValue({
      user,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    configureRouteProtection({
      resolveRoute: () => ({ location: '/setup' }),
    });

    await expect(protectRoute(request, 'policy', async () => 'loaded')).rejects.toMatchObject({
      status: 302,
    });
    expect(mocks.requireAuth).toHaveBeenCalledOnce();
  });
});
