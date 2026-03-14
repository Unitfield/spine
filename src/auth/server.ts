/**
 * Auth module server exports.
 *
 * These exports are framework-agnostic. Framework adapters can re-export
 * them from their own namespaces such as `@eminuckan/mimir-core/react-router/server`.
 */

export * from './auth.server';
export * from './redis-session-storage.server';
export * from './route-protection.server';
export * from './token-refresh.server';
export type {
  ApplicationType,
  AuthClaimMapping,
  AuthConfig,
  AuthError,
  LoginOptions,
  OAuthState,
  ProtectedLoaderFn,
  ProtectionLevel,
  SessionData,
  SessionFlashData,
  UserInfo,
} from './types';
export type {
  TokenRefreshResult as AuthTokenRefreshResult,
} from './types';
