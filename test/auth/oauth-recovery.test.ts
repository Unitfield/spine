import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.NODE_ENV = 'production';
  process.env.OAUTH_STATE_TTL = '600';

  return {
    createOAuthRecoveryRecord: vi.fn(async () => 'opaque-ticket'),
    consumeOAuthRecoveryRecord: vi.fn(),
    deleteOAuthRecoveryRecord: vi.fn(async () => undefined),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock('../../src/auth/redis-session-storage.server', () => ({
  AUTH_ERROR_COOKIE_PREFIX: 'unitfield',
  createOAuthRecoveryRecord: mocks.createOAuthRecoveryRecord,
  consumeOAuthRecoveryRecord: mocks.consumeOAuthRecoveryRecord,
  deleteOAuthRecoveryRecord: mocks.deleteOAuthRecoveryRecord,
}));

vi.mock('../../src/logging', () => ({ logger: mocks.logger }));

import {
  clearOAuthRecoveryIntentHeaders,
  consumeOAuthRecoveryIntent,
  createOAuthRecoveryForLogin,
  getOAuthRecoveryCookiePath,
  OAUTH_RECOVERY_COOKIE_NAME,
  OAUTH_RECOVERY_TTL_SECONDS,
} from '../../src/auth/oauth-recovery.server';
import { OAuthCallbackError } from '../../src/auth/callback-errors';

function staleError(): OAuthCallbackError {
  return new OAuthCallbackError('stale_transaction');
}

function callbackRequest(
  query = 'code=stale-code&state=expected-state',
  ticket = 'opaque-ticket',
  callbackPath = '/auth/callback',
): Request {
  return new Request(`https://app.unitfield.test${callbackPath}?${query}`, {
    headers: {
      Cookie: `${OAUTH_RECOVERY_COOKIE_NAME}=${ticket}`,
    },
  });
}

function setCookies(headers: Headers): string[] {
  return headers.getSetCookie?.() ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createOAuthRecoveryRecord.mockReset();
  mocks.createOAuthRecoveryRecord.mockResolvedValue('opaque-ticket');
  mocks.consumeOAuthRecoveryRecord.mockReset();
  mocks.consumeOAuthRecoveryRecord.mockResolvedValue(null);
  mocks.deleteOAuthRecoveryRecord.mockReset();
  mocks.deleteOAuthRecoveryRecord.mockResolvedValue(undefined);
});

describe('server-owned OAuth recovery intent', () => {
  it('stores only a sanitized return URL behind an opaque ticket cookie', async () => {
    const recovery = await createOAuthRecoveryForLogin(
      new Request('https://app.unitfield.test/auth/login'),
      {
        state: 'expected-state',
        returnUrl: 'https://app.unitfield.test/invitations/accept?token=secret',
      },
      'https://app.unitfield.test/auth/callback',
    );

    expect(mocks.createOAuthRecoveryRecord).toHaveBeenCalledWith({
      state: 'expected-state',
      returnUrl: '/invitations/accept?token=secret',
      createdAt: expect.any(Number),
    });
    expect(recovery.cookie).toContain(`${OAUTH_RECOVERY_COOKIE_NAME}=opaque-ticket`);
    expect(recovery.cookie).toContain(`Max-Age=${OAUTH_RECOVERY_TTL_SECONDS}`);
    expect(recovery.cookie).toContain('HttpOnly');
    expect(recovery.cookie).toContain('Secure');
    expect(recovery.cookie).not.toContain('=1;');
    expect(recovery.cookie).not.toContain('invitations');
    expect(recovery.cookie).not.toContain('secret');
  });

  it('uses the configured non-default callback path for creation, consume, and clear', async () => {
    const redirectUri = 'https://app.unitfield.test/oidc/return/callback';
    const recovery = await createOAuthRecoveryForLogin(
      new Request('https://app.unitfield.test/auth/login'),
      { state: 'expected-state', returnUrl: '/dashboard' },
      redirectUri,
    );

    expect(getOAuthRecoveryCookiePath(redirectUri)).toBe('/oidc/return/callback');
    expect(recovery.cookie).toContain('Path=/oidc/return/callback');

    mocks.consumeOAuthRecoveryRecord.mockResolvedValue({
      state: 'expected-state',
      returnUrl: '/dashboard',
      createdAt: Date.now(),
    });
    const result = await consumeOAuthRecoveryIntent(
      callbackRequest(
        'code=stale-code&state=expected-state',
        'opaque-ticket',
        '/oidc/return/callback',
      ),
      staleError(),
    );

    expect(result.intent).toEqual({ returnUrl: '/dashboard' });
    expect(setCookies(result.cleanupHeaders)).toEqual([
      `${OAUTH_RECOVERY_COOKIE_NAME}=; Path=/oidc/return/callback; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    ]);
    expect(setCookies(clearOAuthRecoveryIntentHeaders(
      new Request('https://app.unitfield.test/oidc/return/callback'),
    ))).toEqual([
      `${OAUTH_RECOVERY_COOKIE_NAME}=; Path=/oidc/return/callback; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    ]);
  });

  it('falls back to a safe cookie path for malformed path input', () => {
    expect(getOAuthRecoveryCookiePath('/oidc/callback;bad')).toBe('/');
    expect(setCookies(clearOAuthRecoveryIntentHeaders('/oidc/callback;bad'))).toEqual([
      `${OAUTH_RECOVERY_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    ]);
  });

  it('returns the stored return URL only after exact-state atomic consumption', async () => {
    mocks.consumeOAuthRecoveryRecord.mockResolvedValue({
      state: 'expected-state',
      returnUrl: '/invitations/accept?token=secret',
      createdAt: Date.now(),
    });

    const result = await consumeOAuthRecoveryIntent(
      callbackRequest(),
      staleError(),
    );

    expect(result.intent).toEqual({
      returnUrl: '/invitations/accept?token=secret',
    });
    expect(mocks.consumeOAuthRecoveryRecord).toHaveBeenCalledWith(
      'opaque-ticket',
      'expected-state',
    );
    expect(setCookies(result.cleanupHeaders)).toEqual([
      `${OAUTH_RECOVERY_COOKIE_NAME}=; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    ]);
    expect(result.cleanupSetCookies).toEqual(setCookies(result.cleanupHeaders));
  });

  it('does not consume when the ticket cookie is omitted or the callback is not ordinary', async () => {
    const error = staleError();

    const omitted = await consumeOAuthRecoveryIntent(
      new Request('https://app.unitfield.test/auth/callback?code=code&state=state'),
      error,
    );
    const provider = await consumeOAuthRecoveryIntent(
      callbackRequest('error=access_denied&state=expected-state'),
      error,
    );
    const action = await consumeOAuthRecoveryIntent(
      callbackRequest('code=code&state=expected-state&kc_action_status=success'),
      error,
    );

    expect(omitted.intent).toBeNull();
    expect(provider.intent).toBeNull();
    expect(action.intent).toBeNull();
    expect(mocks.consumeOAuthRecoveryRecord).not.toHaveBeenCalled();
  });

  it('uses the atomic result as a one-shot race budget', async () => {
    let consumed = false;
    mocks.consumeOAuthRecoveryRecord.mockImplementation(async () => {
      if (consumed) return null;
      consumed = true;
      return {
        state: 'expected-state',
        returnUrl: '/dashboard',
        createdAt: Date.now(),
      };
    });

    const [first, second] = await Promise.all([
      consumeOAuthRecoveryIntent(callbackRequest(), staleError()),
      consumeOAuthRecoveryIntent(callbackRequest(), staleError()),
    ]);

    expect([first.intent, second.intent].filter(Boolean)).toHaveLength(1);
    expect([first.intent, second.intent].filter((intent) => intent === null)).toHaveLength(1);
  });

  it('does not consume a ticket for terminal callback errors', async () => {
    const result = await consumeOAuthRecoveryIntent(
      callbackRequest(),
      new OAuthCallbackError('state_mismatch'),
    );

    expect(result.intent).toBeNull();
    expect(mocks.consumeOAuthRecoveryRecord).not.toHaveBeenCalled();
  });

  it('rejects unsafe or expired records after atomic consumption', async () => {
    mocks.consumeOAuthRecoveryRecord
      .mockResolvedValueOnce({
        state: 'expected-state',
        returnUrl: 'https://attacker.example/steal',
        createdAt: Date.now(),
      })
      .mockResolvedValueOnce({
        state: 'expected-state',
        returnUrl: '/dashboard',
        createdAt: Date.now() - OAUTH_RECOVERY_TTL_SECONDS * 1000 - 1,
      });

    const unsafe = await consumeOAuthRecoveryIntent(callbackRequest(), staleError());
    const expired = await consumeOAuthRecoveryIntent(callbackRequest(), staleError());

    expect(unsafe.intent).toBeNull();
    expect(expired.intent).toBeNull();
  });

  it('provides a lossless ticket-clear header for terminal adapters', () => {
    expect(setCookies(clearOAuthRecoveryIntentHeaders('/auth/callback'))).toEqual([
      `${OAUTH_RECOVERY_COOKIE_NAME}=; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    ]);
  });
});
