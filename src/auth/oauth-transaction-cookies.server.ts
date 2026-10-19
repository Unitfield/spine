import { createHash } from 'node:crypto';
import { AUTH_ERROR_COOKIE_PREFIX } from './redis-session-storage.server';

export const OAUTH_STATE_COOKIE_NAME = `${AUTH_ERROR_COOKIE_PREFIX}_oauth_state_id`;
export const OAUTH_RECOVERY_COOKIE_NAME = `${AUTH_ERROR_COOKIE_PREFIX}_oauth_recovery`;
export const MAX_PENDING_OAUTH_TRANSACTIONS = 8;

const MAX_COOKIE_HEADER_LENGTH = 32 * 1024;
const MAX_COOKIE_PARTS = 256;
const MAX_COOKIE_NAME_LENGTH = 256;
const MAX_COOKIE_VALUE_LENGTH = 768;
const MAX_CALLBACK_STATE_LENGTH = 4096;

export interface OAuthTransactionCookie {
  readonly name: string | null;
  readonly value: string | null;
  readonly present: boolean;
  readonly malformed: boolean;
  readonly scoped: boolean;
}

/** Hash the exact wire state so public context never becomes a cookie name. */
export function getScopedOAuthCookieName(baseName: string, state: string): string {
  if (
    !isUsableCallbackState(state) ||
    !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(baseName) ||
    baseName.length + 65 > MAX_COOKIE_NAME_LENGTH
  ) {
    throw new Error('Invalid OAuth transaction cookie scope');
  }
  return `${baseName}_${createHash('sha256').update(state, 'utf8').digest('hex')}`;
}

function isUsableCallbackState(state: string | null): state is string {
  return state !== null && state.trim().length > 0 &&
    state.length <= MAX_CALLBACK_STATE_LENGTH;
}

export function getOAuthCallbackState(request: Request): string | null {
  const states = new URL(request.url).searchParams.getAll('state');
  return states.length === 1 && isUsableCallbackState(states[0]) ? states[0] : null;
}

function parseCookies(request: Request): Map<string, string[]> | null {
  const header = request.headers.get('Cookie') ?? '';
  if (header.length > MAX_COOKIE_HEADER_LENGTH) return null;
  const parts = header.split(';');
  if (parts.length > MAX_COOKIE_PARTS) return null;
  const cookies = new Map<string, string[]>();
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name.length > MAX_COOKIE_NAME_LENGTH) return null;
    const values = cookies.get(name) ?? [];
    values.push(part.slice(separator + 1).trim());
    cookies.set(name, values);
  }
  return cookies;
}

/** A present but invalid scoped cookie must never fall back to the singleton. */
export function readOAuthTransactionCookie(
  request: Request,
  baseName: string,
  state: string | null,
  allowLegacy = true,
): OAuthTransactionCookie {
  if (!isUsableCallbackState(state)) {
    return { name: null, value: null, present: false, malformed: false, scoped: false };
  }
  const scopedName = getScopedOAuthCookieName(baseName, state);
  const cookies = parseCookies(request);
  if (!cookies) {
    return { name: scopedName, value: null, present: false, malformed: true, scoped: true };
  }
  const scoped = cookies.has(scopedName);
  const name = scoped || !allowLegacy || !cookies.has(baseName) ? scopedName : baseName;
  const values = cookies.get(name);
  let value: string | null = null;
  if (values?.length === 1 && values[0].length <= MAX_COOKIE_VALUE_LENGTH) {
    try {
      const decoded = decodeURIComponent(values[0]);
      if (/^[A-Za-z0-9_-]{1,256}$/.test(decoded)) value = decoded;
    } catch {
      // An invalid encoding is an invalid cookie, never a legacy fallback.
    }
  }
  return {
    name,
    value,
    present: values !== undefined,
    malformed: values !== undefined && value === null,
    scoped: name === scopedName,
  };
}

/** Bound browser growth without evicting another tab's pending transaction. */
export function assertOAuthTransactionCapacity(request: Request): void {
  const cookies = parseCookies(request);
  if (!cookies) throw new Error('Invalid OAuth cookie header');
  const prefix = `${OAUTH_STATE_COOKIE_NAME}_`;
  const pending = Array.from(cookies.keys()).filter((name) =>
    name.startsWith(prefix) && /^[a-f0-9]{64}$/.test(name.slice(prefix.length)),
  ).length;
  if (pending >= MAX_PENDING_OAUTH_TRANSACTIONS) {
    throw new Error('Too many pending OAuth transactions');
  }
}
