/**
 * Auth Module - Client-side exports
 * 
 * Bu modül client-side'da kullanılacak auth utilities içerir.
 * Server-side auth için '@propmate/core/auth/server' kullanın.
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
