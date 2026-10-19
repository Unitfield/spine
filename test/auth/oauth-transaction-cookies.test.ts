import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../../src/auth/redis-session-storage.server', () => ({ AUTH_ERROR_COOKIE_PREFIX: 'unitfield' }));

import {
  assertOAuthTransactionCapacity,
  getOAuthCallbackState,
  getScopedOAuthCookieName,
  MAX_PENDING_OAUTH_TRANSACTIONS,
  OAUTH_STATE_COOKIE_NAME,
  readOAuthTransactionCookie,
} from '../../src/auth/oauth-transaction-cookies.server';

function request(cookie: string, state = 'exact-state'): Request {
  return new Request(`https://app.test/auth/callback?code=code&state=${encodeURIComponent(state)}`, {
    headers: { Cookie: cookie },
  });
}

describe('bounded per-state OAuth transaction cookies', () => {
  it('hashes the complete state including public context without normalizing it', () => {
    const state = 'opaque-state.eyJzb3VyY2UiOiJzaWdudXAifQ';
    const hash = createHash('sha256').update(state).digest('hex');
    expect(getScopedOAuthCookieName(OAUTH_STATE_COOKIE_NAME, state)).toBe(`${OAUTH_STATE_COOKIE_NAME}_${hash}`);
    expect(getScopedOAuthCookieName(OAUTH_STATE_COOKIE_NAME, `${state} `)).not.toBe(`${OAUTH_STATE_COOKIE_NAME}_${hash}`);
    expect(getScopedOAuthCookieName('app.name_oauth_state_id', state)).toBe(`app.name_oauth_state_id_${hash}`);
  });

  it('uses exact cookie-name boundaries and scoped precedence', () => {
    const scoped = getScopedOAuthCookieName(OAUTH_STATE_COOKIE_NAME, 'exact-state');
    expect(readOAuthTransactionCookie(
      request(`prefix_${scoped}=wrong; ${scoped}=correct; ${OAUTH_STATE_COOKIE_NAME}=legacy`),
      OAUTH_STATE_COOKIE_NAME, 'exact-state',
    )).toMatchObject({ name: scoped, value: 'correct', scoped: true });
  });

  it('retains legacy compatibility only when the matching scoped cookie is absent', () => {
    expect(readOAuthTransactionCookie(
      request(`${OAUTH_STATE_COOKIE_NAME}=legacy-id`), OAUTH_STATE_COOKIE_NAME, 'exact-state',
    )).toMatchObject({ name: OAUTH_STATE_COOKIE_NAME, value: 'legacy-id', scoped: false });
    expect(readOAuthTransactionCookie(
      request(`${OAUTH_STATE_COOKIE_NAME}=%`), OAUTH_STATE_COOKIE_NAME, 'exact-state',
    )).toMatchObject({ value: null, malformed: true });
  });

  it.each(['unrelated=' + 'a'.repeat(32768), Array.from({ length: 257 }, (_, i) => `name${i}=value`).join('; '), `${'a'.repeat(257)}=value`])('fails closed on excessive cookie parsing input', (cookie) => {
    expect(() => assertOAuthTransactionCapacity(request(cookie))).toThrow('Invalid OAuth cookie header');
    expect(readOAuthTransactionCookie(request(cookie), OAUTH_STATE_COOKIE_NAME, 'exact-state')).toMatchObject({ value: null, malformed: true });
  });

  it('counts only this app state cookies and rejects the limit without deleting flows', () => {
    const pending = Array.from({ length: MAX_PENDING_OAUTH_TRANSACTIONS }, (_, i) =>
      `${getScopedOAuthCookieName(OAUTH_STATE_COOKIE_NAME, `state-${i}`)}=id-${i}`,
    );
    expect(() => assertOAuthTransactionCapacity(request(pending.slice(1).join('; ')))).not.toThrow();
    expect(() => assertOAuthTransactionCapacity(request(pending.join('; ')))).toThrow('Too many pending OAuth transactions');
    expect(() => assertOAuthTransactionCapacity(request(pending.map((cookie) => `other_${cookie}`).join('; ')))).not.toThrow();
  });

  it('bounds state and name lengths before hashing or serializing them', () => {
    expect(() => getScopedOAuthCookieName(OAUTH_STATE_COOKIE_NAME, 'a'.repeat(4097))).toThrow();
    expect(() => getScopedOAuthCookieName('a'.repeat(192), 'state')).toThrow();
    expect(() => getScopedOAuthCookieName('unsafe;name', 'state')).toThrow();
    expect(getOAuthCallbackState(request('', 'a'.repeat(4097)))).toBeNull();
  });
});
