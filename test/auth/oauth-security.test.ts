import { afterEach, describe, expect, it } from 'vitest';

import {
  sanitizeOAuthReturnUrl,
  serializeTemporaryAuthCookie,
} from '../../src/auth/oauth-security';

const request = new Request('https://app.unitfield.com/auth/login');
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('OAuth return URL safety', () => {
  it.each([
    'https://attacker.example/steal',
    '//attacker.example/steal',
    '/\\attacker.example/steal',
    '\\\\attacker.example/steal',
    '%2F%2Fattacker.example%2Fsteal',
    '/%2Fattacker.example/steal',
    '/%5Cattacker.example/steal',
    'javascript:alert(1)',
    'dashboard',
  ])('rejects external and authority-like destination %s', (returnUrl) => {
    expect(sanitizeOAuthReturnUrl(returnUrl, request)).toBeNull();
  });

  it('preserves a safe local invitation path and its encoded query', () => {
    expect(
      sanitizeOAuthReturnUrl(
        '/invitations/accept?token=invite%26token%25&next=%2Fdashboard#details',
        request,
      ),
    ).toBe('/invitations/accept?token=invite%26token%25&next=%2Fdashboard#details');
  });

  it('normalizes a same-origin absolute URL to a local path', () => {
    expect(
      sanitizeOAuthReturnUrl(
        'https://app.unitfield.com/settings/security?enrolled=true',
        request,
      ),
    ).toBe('/settings/security?enrolled=true');
  });

  it.each([
    '/auth/login',
    '/auth/login?returnTo=/dashboard',
    '/auth/callback',
    '/auth/callback?next=/dashboard',
    '/auth/logout/',
  ])(
    'rejects an authentication loop destination %s',
    (returnUrl) => {
      expect(sanitizeOAuthReturnUrl(returnUrl, request)).toBeNull();
    },
  );
});

describe('temporary OAuth cookies', () => {
  it('sets Secure, HttpOnly, and SameSite in production', () => {
    process.env.NODE_ENV = 'production';

    expect(
      serializeTemporaryAuthCookie('oauth_state', 'state/value', { maxAge: 600 }),
    ).toBe(
      'oauth_state=state%2Fvalue; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure',
    );
  });

  it('supports local HTTP development without weakening production behavior', () => {
    process.env.NODE_ENV = 'development';

    const cookie = serializeTemporaryAuthCookie('oauth_state', 'state-id', { maxAge: 600 });

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });
});
