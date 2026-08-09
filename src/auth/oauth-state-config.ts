const DEFAULT_OAUTH_STATE_TTL_SECONDS = 10 * 60;
const DEFAULT_OAUTH_RECOVERY_TTL_SECONDS = 30 * 60;

function resolvePositiveIntegerEnv(name: string, defaultValue: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

/**
 * OAuth state lifetime shared by Redis expiry and callback age validation.
 * This module is internal and is not part of a package export entry point.
 */
export const OAUTH_STATE_TTL_SECONDS = resolvePositiveIntegerEnv(
  'OAUTH_STATE_TTL',
  DEFAULT_OAUTH_STATE_TTL_SECONDS,
);

export const OAUTH_STATE_TTL_MS = OAUTH_STATE_TTL_SECONDS * 1000;

/**
 * Lifetime for the server-side recovery ticket.  It deliberately outlives
 * the primary OAuth transaction so an IdP callback that arrives after state
 * expiry can still recover once, while remaining short-lived.
 */
export const OAUTH_RECOVERY_TTL_SECONDS = Math.max(
  DEFAULT_OAUTH_RECOVERY_TTL_SECONDS,
  OAUTH_STATE_TTL_SECONDS + 60,
);

export const OAUTH_RECOVERY_TTL_MS = OAUTH_RECOVERY_TTL_SECONDS * 1000;
