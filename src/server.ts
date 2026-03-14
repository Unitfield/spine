/**
 * Mimir Core - Server Exports
 *
 * Framework-agnostic server-side exports.
 */

// Re-export everything from client
export * from './index';

// Auth (server-only)
export * from './auth/server';

// Tenant Server
export * from './tenant/server';

// Identity Server
export * from './identity/server';

// Permissions Server
export * from './permissions/route-protection.server';

// API Client Server
export * from './api-client/server';

// Explicit aliases for overlapping auth/api-client token refresh types.
export type {
  TokenRefreshResult as ApiTokenRefreshResult,
  TokenRefreshFn,
} from './api-client/types';
export type {
  TokenRefreshResult as AuthTokenRefreshResult,
} from './auth/types';
