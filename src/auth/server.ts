/**
 * Auth module server exports.
 *
 * These exports are framework-agnostic. Framework adapters can re-export
 * them from their own namespaces such as `@eminuckan/spine/react-router/server`.
 */

export * from './auth.server';
export * from './callback-errors';
export * from './redis-session-storage.server';
export {
  clearOAuthRecoveryIntentHeaders,
  consumeOAuthRecoveryIntent,
  getOAuthRecoveryCookiePath,
  OAUTH_RECOVERY_COOKIE_NAME,
  OAUTH_RECOVERY_TTL_SECONDS,
} from './oauth-recovery.server';
export type {
  OAuthRecoveryConsumeResult,
  OAuthRecoveryIntent,
} from './oauth-recovery.server';
export * from './route-protection.server';
export * from './token-refresh.server';
export type {
  ApplicationType,
  AuthSessionSummary,
  AuthClaimMapping,
  AuthConfig,
  AuthError,
  BackChannelLogoutResult,
  FrontChannelLogoutResult,
  LoginOptions,
  OAuthState,
  OidcClientAuthMethod,
  ProtectedLoaderFn,
  ProtectionLevel,
  PublicAuthorizationStateContext,
  SessionData,
  SessionFlashData,
  UserInfo,
} from './types';
export type {
  TokenRefreshResult as AuthTokenRefreshResult,
} from './types';
