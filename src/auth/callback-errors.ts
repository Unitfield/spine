/**
 * Public, framework-neutral OAuth callback failure contract.
 *
 * This module is server-only.  The callback error deliberately exposes a
 * stable code and cleanup headers, but never exposes callback parameters,
 * provider descriptions, or an underlying error message.
 */

export type OAuthCallbackFailureCode =
  | 'stale_transaction'
  | 'state_mismatch'
  | 'malformed_callback'
  | 'application_action_failed'
  | 'token_exchange_failed'
  | 'session_creation_failed'
  | 'storage_error'
  | 'configuration_error';

export const OAuthCallbackFailureCodes = {
  StaleTransaction: 'stale_transaction',
  StateMismatch: 'state_mismatch',
  MalformedCallback: 'malformed_callback',
  ApplicationActionFailed: 'application_action_failed',
  TokenExchangeFailed: 'token_exchange_failed',
  SessionCreationFailed: 'session_creation_failed',
  StorageError: 'storage_error',
  ConfigurationError: 'configuration_error',
} as const satisfies Record<
  string,
  OAuthCallbackFailureCode
>;

const OAUTH_CALLBACK_ERROR_BRAND = Symbol.for(
  '@eminuckan/spine/OAuthCallbackError',
);

function isOAuthCallbackFailureCode(value: unknown): value is OAuthCallbackFailureCode {
  return typeof value === 'string' && Object.values(OAuthCallbackFailureCodes).includes(
    value as OAuthCallbackFailureCode,
  );
}

function isHeadersLike(value: unknown): value is Headers {
  return value !== null && typeof value === 'object' &&
    typeof (value as Headers).get === 'function' &&
    typeof (value as Headers).append === 'function';
}

function getSetCookieValues(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & {
    getSetCookie?: () => string[];
  }).getSetCookie;
  if (getSetCookie) {
    return getSetCookie.call(headers);
  }

  return Array.from(headers).reduce<string[]>((cookies, [name, value]) => {
    if (name.toLowerCase() === 'set-cookie') {
      cookies.push(value);
    }
    return cookies;
  }, []);
}

/**
 * A callback failure that consumers can classify without parsing messages.
 *
 * The message is intentionally constant.  Consumers should branch on
 * `code`, not on `message`, and should merge `cleanupHeaders` (or the
 * lossless `cleanupSetCookies` values) with any response they create using
 * repeated `Set-Cookie` appends.
 */
export class OAuthCallbackError extends Error {
  readonly code: OAuthCallbackFailureCode;
  readonly cleanupHeaders: Headers;
  readonly cleanupSetCookies: readonly string[];

  constructor(
    code: OAuthCallbackFailureCode,
    cleanupHeaders: HeadersInit = {},
  ) {
    super('Authentication failed');
    this.name = 'OAuthCallbackError';
    this.code = code;
    this.cleanupHeaders = new Headers(cleanupHeaders);
    this.cleanupSetCookies = getSetCookieValues(this.cleanupHeaders);

    Object.defineProperty(this, OAUTH_CALLBACK_ERROR_BRAND, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
  }
}

/**
 * Cross-package-copy safe type guard for callback failures.
 */
export function isOAuthCallbackError(error: unknown): error is OAuthCallbackError {
  if (error instanceof OAuthCallbackError) {
    return true;
  }

  if (error === null || typeof error !== 'object') {
    return false;
  }

  const candidate = error as Record<PropertyKey, unknown>;
  return candidate[OAUTH_CALLBACK_ERROR_BRAND] === true &&
    isOAuthCallbackFailureCode(candidate.code) &&
    isHeadersLike(candidate.cleanupHeaders);
}

/**
 * Only a normal authorization callback whose local transaction is absent or
 * expired may be retried.  All other callback failures fail closed.
 */
export function isRecoverableOAuthCallbackError(error: unknown): boolean {
  return isOAuthCallbackError(error) && error.code === 'stale_transaction';
}
