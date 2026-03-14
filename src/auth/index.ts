/**
 * Auth Module - Client-side exports
 *
 * Client-side auth types live here.
 * For server-side auth primitives, use `@eminuckan/mimir-core/auth/server`.
 */

// Types
export type {
  UserInfo,
  AuthConfig,
  SessionData,
  OAuthState,
  LoginOptions,
  AuthError,
  ApplicationType,
} from './types';

// Client-side hooks (if any future hooks are added)
// Currently auth is mostly server-side
