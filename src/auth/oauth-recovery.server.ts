/**
 * Server-only recovery intent for stale OAuth callbacks.
 *
 * A recovery intent is an opaque, HttpOnly cookie backed by a separate Redis
 * record. Consumers must atomically consume it with the typed stale callback
 * error; the client never supplies a boolean budget or a return URL.
 */

import {
  consumeOAuthRecoveryRecord,
  createOAuthRecoveryRecord,
  deleteOAuthRecoveryRecord,
  AUTH_ERROR_COOKIE_PREFIX,
} from './redis-session-storage.server';
import {
  isRecoverableOAuthCallbackError,
} from './callback-errors';
import { sanitizeOAuthReturnUrl } from './oauth-security';
import {
  OAUTH_RECOVERY_TTL_MS,
  OAUTH_RECOVERY_TTL_SECONDS,
} from './oauth-state-config';
import type { OAuthState } from './types';
import { logger } from '../logging';

export const OAUTH_RECOVERY_COOKIE_NAME = `${AUTH_ERROR_COOKIE_PREFIX}_oauth_recovery`;
export { OAUTH_RECOVERY_TTL_SECONDS };

export interface OAuthRecoveryIntent {
  /** The sanitized destination originally supplied to login(). */
  readonly returnUrl: string;
}

export interface OAuthRecoveryConsumeResult {
  /** A server-record-backed destination, or null when recovery is unavailable. */
  readonly intent: OAuthRecoveryIntent | null;
  /** Always clear the one-shot ticket cookie in the adapter response. */
  readonly cleanupHeaders: Headers;
  /** Lossless repeated Set-Cookie values for runtimes without getSetCookie(). */
  readonly cleanupSetCookies: readonly string[];
}

export interface OAuthRecoveryLoginResult {
  readonly ticket: string;
  readonly cookie: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getCookieValue(request: Request): string | null {
  const cookies = request.headers.get('Cookie');
  if (!cookies) {
    return null;
  }

  const cookieRegex = new RegExp(
    `(?:^|;\\s*)${escapeRegExp(OAUTH_RECOVERY_COOKIE_NAME)}=([^;]*)`,
  );
  const rawValue = cookies.match(cookieRegex)?.[1];
  if (!rawValue) {
    return null;
  }

  try {
    const value = decodeURIComponent(rawValue);
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function hasCookie(request: Request): boolean {
  const cookies = request.headers.get('Cookie');
  if (!cookies) {
    return false;
  }

  return cookies.split(';').some((part) => {
    const separator = part.indexOf('=');
    return separator > 0 &&
      part.slice(0, separator).trim() === OAUTH_RECOVERY_COOKIE_NAME;
  });
}

const SAFE_FALLBACK_COOKIE_PATH = '/';

function normalizeCookiePath(pathname: string): string {
  const candidate = pathname.trim();
  const hasUnsafeCharacter = Array.from(candidate).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || character === ';';
  });
  if (
    candidate.length === 0 ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    hasUnsafeCharacter
  ) {
    return SAFE_FALLBACK_COOKIE_PATH;
  }

  return candidate;
}

/**
 * Resolve the callback cookie path from a configured redirect URI or the
 * actual callback request. Unsafe path values fall back to `/` rather than
 * being interpolated into a Set-Cookie header.
 */
export function getOAuthRecoveryCookiePath(
  source: Request | URL | string,
): string {
  try {
    const url = source instanceof Request
      ? new URL(source.url)
      : source instanceof URL
        ? source
        : new URL(
          source,
          source.startsWith('/') ? 'http://spine.local' : undefined,
        );
    return normalizeCookiePath(url.pathname);
  } catch {
    return SAFE_FALLBACK_COOKIE_PATH;
  }
}

function serializeRecoveryCookie(
  ticket: string,
  maxAge: number,
  callbackPath: string,
): string {
  const segments = [
    `${OAUTH_RECOVERY_COOKIE_NAME}=${encodeURIComponent(ticket)}`,
    `Path=${callbackPath}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];

  if (process.env.NODE_ENV === 'production') {
    segments.push('Secure');
  }

  return segments.join('; ');
}

function appendRecoveryCookieClear(headers: Headers, callbackPath: string): void {
  headers.append(
    'Set-Cookie',
    serializeRecoveryCookie('', 0, callbackPath),
  );
}

function getSetCookieValues(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & {
    getSetCookie?: () => string[];
  }).getSetCookie;
  if (getSetCookie) {
    return getSetCookie.call(headers);
  }

  return Array.from(headers)
    .filter(([name]) => name.toLowerCase() === 'set-cookie')
    .map(([, value]) => value);
}

/**
 * Build a lossless ticket-clear header using a callback request, URL, or
 * configured redirect URI as the cookie-path source.
 */
export function clearOAuthRecoveryIntentHeaders(
  source: Request | URL | string,
): Headers {
  const headers = new Headers();
  appendRecoveryCookieClear(headers, getOAuthRecoveryCookiePath(source));
  return headers;
}

function hasNonEmptyParam(url: URL, name: string): boolean {
  return url.searchParams.get(name)?.trim().length ? true : false;
}

/**
 * This check is intentionally stricter than the callback error code.  It
 * prevents recovery for provider errors, malformed callbacks, and account
 * actions even if an adapter accidentally calls the consume helper there.
 */
export function isOAuthRecoveryEligibleCallback(request: Request): boolean {
  const url = new URL(request.url);
  return hasNonEmptyParam(url, 'code') &&
    hasNonEmptyParam(url, 'state') &&
    !url.searchParams.has('error') &&
    !url.searchParams.has('kc_action') &&
    !url.searchParams.has('kc_action_status');
}

function isRecoveryRecord(value: unknown): value is {
  state: string;
  returnUrl: string;
  createdAt: number;
} {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const record = value as Partial<OAuthState>;
  return typeof record.state === 'string' &&
    record.state.length > 0 &&
    typeof record.returnUrl === 'string' &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt);
}

function getCallbackState(request: Request): string | null {
  const value = new URL(request.url).searchParams.get('state');
  return value && value.trim().length > 0 ? value : null;
}

/**
 * Create the opaque ticket cookie for an ordinary login transaction.
 * Application-action transactions deliberately do not receive a recovery
 * ticket and therefore cannot enter the automatic recovery path.
 */
export async function createOAuthRecoveryForLogin(
  request: Request,
  state: Pick<OAuthState, 'state' | 'returnUrl'>,
  redirectUri: string,
): Promise<OAuthRecoveryLoginResult> {
  const returnUrl = sanitizeOAuthReturnUrl(state.returnUrl, request) ?? '/';
  const callbackPath = getOAuthRecoveryCookiePath(redirectUri);
  const ticket = await createOAuthRecoveryRecord({
    state: state.state,
    returnUrl,
    createdAt: Date.now(),
  });

  return {
    ticket,
    cookie: serializeRecoveryCookie(
      ticket,
      OAUTH_RECOVERY_TTL_SECONDS,
      callbackPath,
    ),
  };
}

/**
 * Delete an unconsumed ticket during terminal/successful callback cleanup.
 * The caller owns error classification and should still clear the browser
 * cookie if deletion fails.
 */
export async function discardOAuthRecoveryForRequest(request: Request): Promise<Headers> {
  const ticket = getCookieValue(request);
  const headers = new Headers();
  if (!hasCookie(request)) {
    return headers;
  }

  if (ticket) {
    await deleteOAuthRecoveryRecord(ticket);
  }
  appendRecoveryCookieClear(headers, getOAuthRecoveryCookiePath(request));
  return headers;
}

/**
 * Atomically consume a stale-flow recovery intent.
 *
 * The typed error and the callback shape are both checked server-side.  Redis
 * compares the callback state and deletes only on an exact match, so a
 * mismatch cannot burn a valid ticket while a replay or concurrent loser
 * cannot retry.
 */
export async function consumeOAuthRecoveryIntent(
  request: Request,
  callbackError: unknown,
): Promise<OAuthRecoveryConsumeResult> {
  const cleanupHeaders = clearOAuthRecoveryIntentHeaders(request);
  const cleanupSetCookies = getSetCookieValues(cleanupHeaders);

  if (
    !isRecoverableOAuthCallbackError(callbackError) ||
    !isOAuthRecoveryEligibleCallback(request)
  ) {
    return { intent: null, cleanupHeaders, cleanupSetCookies };
  }

  const ticket = getCookieValue(request);
  const callbackState = getCallbackState(request);
  if (!ticket || !callbackState) {
    return { intent: null, cleanupHeaders, cleanupSetCookies };
  }

  let record: unknown;
  try {
    record = await consumeOAuthRecoveryRecord(ticket, callbackState);
  } catch (error) {
    logger.warn('OAuth recovery record could not be consumed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return { intent: null, cleanupHeaders, cleanupSetCookies };
  }

  if (!isRecoveryRecord(record)) {
    return { intent: null, cleanupHeaders, cleanupSetCookies };
  }

  const age = Date.now() - record.createdAt;
  if (age < 0 || age > OAUTH_RECOVERY_TTL_MS) {
    return { intent: null, cleanupHeaders, cleanupSetCookies };
  }

  const returnUrl = sanitizeOAuthReturnUrl(record.returnUrl, request);
  if (!returnUrl) {
    return { intent: null, cleanupHeaders, cleanupSetCookies };
  }

  return {
    intent: { returnUrl },
    cleanupHeaders,
    cleanupSetCookies,
  };
}
