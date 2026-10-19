import { env as spineRuntimeEnv } from 'node:process';
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
import {
  getOAuthCallbackState,
  getScopedOAuthCookieName,
  OAUTH_RECOVERY_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  readOAuthTransactionCookie,
} from './oauth-transaction-cookies.server';

export { OAUTH_RECOVERY_COOKIE_NAME };
export { OAUTH_RECOVERY_TTL_SECONDS };

export interface OAuthRecoveryIntent {
  /** The sanitized destination originally supplied to login(). */
  readonly returnUrl: string;
}

export interface OAuthRecoveryConsumeResult {
  /** A server-record-backed destination, or null when recovery is unavailable. */
  readonly intent: OAuthRecoveryIntent | null;
  /** Clear this callback's ticket; preserve a legacy pointer of unknown ownership. */
  readonly cleanupHeaders: Headers;
  /** Lossless repeated Set-Cookie values for runtimes without getSetCookie(). */
  readonly cleanupSetCookies: readonly string[];
}

export interface OAuthRecoveryLoginResult {
  readonly ticket: string;
  readonly cookie: string;
}

function getRecoveryCookie(request: Request, state = getOAuthCallbackState(request)) {
  const stateCookie = readOAuthTransactionCookie(request, OAUTH_STATE_COOKIE_NAME, state);
  return readOAuthTransactionCookie(
    request,
    OAUTH_RECOVERY_COOKIE_NAME,
    state,
    !(stateCookie.present && stateCookie.scoped),
  );
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
  cookieName = OAUTH_RECOVERY_COOKIE_NAME,
): string {
  const segments = [
    `${cookieName}=${encodeURIComponent(ticket)}`,
    `Path=${callbackPath}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];

  if (spineRuntimeEnv.NODE_ENV === 'production') {
    segments.push('Secure');
  }

  return segments.join('; ');
}

function appendRecoveryCookieClear(
  headers: Headers,
  callbackPath: string,
  cookieName: string | null = OAUTH_RECOVERY_COOKIE_NAME,
): void {
  if (!cookieName) return;
  headers.append(
    'Set-Cookie',
    serializeRecoveryCookie('', 0, callbackPath, cookieName),
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
  state?: string,
): Headers {
  const headers = new Headers();
  const requestCookie = source instanceof Request ? getRecoveryCookie(source) : null;
  const cookieName = state !== undefined
    ? getScopedOAuthCookieName(OAUTH_RECOVERY_COOKIE_NAME, state)
    : requestCookie
      ? requestCookie.scoped ? requestCookie.name : null
      : OAUTH_RECOVERY_COOKIE_NAME;
  appendRecoveryCookieClear(headers, getOAuthRecoveryCookiePath(source), cookieName);
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
  const state = getOAuthCallbackState(request);
  return hasNonEmptyParam(url, 'code') &&
    state !== null &&
    !readOAuthTransactionCookie(request, OAUTH_STATE_COOKIE_NAME, state).malformed &&
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

/**
 * Create the opaque ticket cookie for an ordinary login transaction.
 * Application-action transactions deliberately do not receive a recovery
 * ticket and therefore cannot enter the automatic recovery path.
 */
export async function createOAuthRecoveryForLogin(
  request: Request,
  state: Pick<OAuthState, 'state' | 'returnUrl'>,
  redirectUri: string,
  cookieState?: string,
): Promise<OAuthRecoveryLoginResult> {
  const returnUrl = sanitizeOAuthReturnUrl(state.returnUrl, request) ?? '/';
  const callbackPath = getOAuthRecoveryCookiePath(redirectUri);
  const cookieName = cookieState === undefined
    ? OAUTH_RECOVERY_COOKIE_NAME
    : getScopedOAuthCookieName(OAUTH_RECOVERY_COOKIE_NAME, cookieState);
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
      cookieName,
    ),
  };
}

/**
 * Delete an unconsumed ticket during terminal/successful callback cleanup.
 * The caller owns error classification and should still clear the browser
 * cookie if deletion fails.
 */
export async function discardOAuthRecoveryForRequest(request: Request): Promise<Headers> {
  const state = getOAuthCallbackState(request);
  const cookie = getRecoveryCookie(request, state);
  const headers = new Headers();
  if (!cookie.present || !state) {
    return headers;
  }

  if (cookie.value) {
    // Terminal cleanup consumes only this exact state, without issuing a retry.
    const record = await consumeOAuthRecoveryRecord(cookie.value, state);
    // A legacy singleton may belong to another pending transaction. Keep its
    // browser pointer whenever exact-state ownership could not be established.
    if (!record && !cookie.scoped) return headers;
  }
  appendRecoveryCookieClear(headers, getOAuthRecoveryCookiePath(request), cookie.name);
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
  const cookie = getRecoveryCookie(request);
  const result = (intent: OAuthRecoveryIntent | null = null, ownsLegacy = false): OAuthRecoveryConsumeResult => {
    const cleanupHeaders = new Headers();
    appendRecoveryCookieClear(
      cleanupHeaders,
      getOAuthRecoveryCookiePath(request),
      cookie.scoped || ownsLegacy ? cookie.name : null,
    );
    return { intent, cleanupHeaders, cleanupSetCookies: getSetCookieValues(cleanupHeaders) };
  };

  if (
    !isRecoverableOAuthCallbackError(callbackError) ||
    !isOAuthRecoveryEligibleCallback(request)
  ) {
    return result();
  }

  const ticket = cookie.value;
  const callbackState = getOAuthCallbackState(request);
  if (!ticket || !callbackState) {
    return result();
  }

  let record: unknown;
  try {
    record = await consumeOAuthRecoveryRecord(ticket, callbackState);
  } catch (error) {
    logger.warn('OAuth recovery record could not be consumed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return result();
  }

  if (!isRecoveryRecord(record) || record.state !== callbackState) {
    return result();
  }

  const age = Date.now() - record.createdAt;
  if (age < 0 || age > OAUTH_RECOVERY_TTL_MS) {
    return result(null, true);
  }

  const returnUrl = sanitizeOAuthReturnUrl(record.returnUrl, request);
  if (!returnUrl) {
    return result(null, true);
  }

  return result({ returnUrl }, true);
}
