const DEFAULT_OAUTH_STATE_TTL_SECONDS = 10 * 60;

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
