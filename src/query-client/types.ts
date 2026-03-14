/**
 * Query Client Types
 */

import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Logger interface for query client
 */
export interface QueryLogger {
  debug?: (message: string, context?: Record<string, unknown>) => void;
  info?: (message: string, context?: Record<string, unknown>) => void;
  error?: (message: string, error?: Error, context?: Record<string, unknown>) => void;
}

/**
 * Logout handler function type
 */
export type LogoutHandler = (returnUrl?: string) => void;

/**
 * Query client configuration options
 */
export interface QueryClientConfig {
  /**
   * How long data is considered fresh (no refetch on mount)
   * @default 300000 (5 minutes)
   */
  staleTime?: number;
  /**
   * How long unused data stays in cache
   * @default 600000 (10 minutes)
   */
  gcTime?: number;
  /**
   * Maximum number of retries for queries
   * @default 3
   */
  maxRetries?: number;
  /**
   * Maximum number of retries for mutations
   * @default 1
   */
  maxMutationRetries?: number;
  /**
   * Whether to refetch on window focus
   * @default true
   */
  refetchOnWindowFocus?: boolean;
  /**
   * Whether to refetch on reconnect
   * @default false
   */
  refetchOnReconnect?: boolean;
  /**
   * Whether to refetch on mount
   * @default false
   */
  refetchOnMount?: boolean;
  /**
   * Logger instance
   */
  logger?: QueryLogger;
  /**
   * Logout handler for session expiry
   */
  onLogout?: LogoutHandler;
}

/**
 * Cache preset configuration
 */
export interface CachePreset {
  staleTime: number;
  gcTime: number;
  refetchOnWindowFocus?: boolean;
}

/**
 * Cache presets for different data types
 */
export interface CachePresets {
  /**
   * For data that rarely changes (permissions, roles, etc.)
   */
  static: CachePreset;
  /**
   * For data that changes occasionally (properties, users, etc.)
   */
  normal: CachePreset;
  /**
   * For data that changes frequently (transactions, activities, etc.)
   */
  dynamic: CachePreset;
  /**
   * For data that needs to always be fresh (real-time status, etc.)
   */
  realtime: CachePreset;
}

/**
 * Invalidation helper for related queries
 */
export interface InvalidationHelpers {
  /**
   * Invalidate all identity-related queries
   */
  invalidateIdentity: (queryClient: QueryClient) => Promise<void>;
  /**
   * Invalidate all property-related queries
   */
  invalidateProperties: (queryClient: QueryClient) => Promise<void>;
  /**
   * Invalidate all accounting-related queries
   */
  invalidateAccounting: (queryClient: QueryClient) => Promise<void>;
  /**
   * Invalidate specific query by key
   */
  invalidateByKey: (queryClient: QueryClient, queryKey: QueryKey) => Promise<void>;
}
