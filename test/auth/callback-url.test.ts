import { describe, expect, it } from 'vitest';

import { createAuthorizationResponseUrl } from '../../src/auth/auth.server';

describe('authorization callback URL', () => {
  it('uses the registered HTTPS redirect URI behind a TLS-terminating proxy', () => {
    const result = createAuthorizationResponseUrl(
      'http://dashboard:3000/auth/callback?code=abc&state=state-1',
      'https://app.unitfield.com/auth/callback',
    );

    expect(result.toString()).toBe(
      'https://app.unitfield.com/auth/callback?code=abc&state=state-1',
    );
  });

  it('preserves every authorization response parameter and drops fragments', () => {
    const result = createAuthorizationResponseUrl(
      'http://resident:3000/auth/callback?error=access_denied&error_description=No+access#ignored',
      'https://resident.unitfield.com/auth/callback',
    );

    expect(result.origin).toBe('https://resident.unitfield.com');
    expect(result.pathname).toBe('/auth/callback');
    expect(result.searchParams.get('error')).toBe('access_denied');
    expect(result.searchParams.get('error_description')).toBe('No access');
    expect(result.hash).toBe('');
  });
});
