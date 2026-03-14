/**
 * Query Client Configuration
 * 
 * Optimized caching strategy for different types of data:
 * - Static data (rarely changes): Long staleTime and gcTime
 * - Dynamic data (changes frequently): Short staleTime
 * - Critical data (needs to be fresh): Very short staleTime with prefetching
 */

import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';
import type { QueryClientConfig, CachePresets } from './types';

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<Omit<QueryClientConfig, 'logger' | 'onLogout'>> = {
  staleTime: 5 * 60 * 1000, // 5 minutes
  gcTime: 10 * 60 * 1000, // 10 minutes
  maxRetries: 3,
  maxMutationRetries: 1,
  refetchOnWindowFocus: true,
  refetchOnReconnect: false,
  refetchOnMount: false,
};

/**
 * Check if error is a 401 Unauthorized error
 */
function is401Error(error: unknown): boolean {
  if (error instanceof Response) {
    return error.status === 401;
  }

  if (error && typeof error === 'object' && 'status' in error) {
    return (error as any).status === 401;
  }

  return false;
}

/**
 * Check if error requires logout (refresh token expired)
 */
function shouldLogout(error: unknown): boolean {
  if (error && typeof error === 'object') {
    // Check for shouldLogout flag from server
    if ('shouldLogout' in error && (error as any).shouldLogout === true) {
      return true;
    }

    // Check for SESSION_EXPIRED code
    if ('code' in error && (error as any).code === 'SESSION_EXPIRED') {
      return true;
    }
  }

  return false;
}

/**
 * Create default logout handler
 */
function createDefaultLogoutHandler(): (returnUrl?: string) => void {
  return (returnUrl?: string) => {
    if (typeof window !== 'undefined') {
      const currentUrl = returnUrl || window.location.pathname + window.location.search;
      window.location.href = `/auth/logout?returnUrl=${encodeURIComponent(currentUrl)}`;
    }
  };
}

/**
 * Create optimized QueryClient instance
 * 
 * @param config - Configuration options
 * @returns Configured QueryClient with optimized defaults
 */
export function createQueryClient(config: QueryClientConfig = {}): QueryClient {
  const {
    staleTime,
    gcTime,
    maxRetries,
    maxMutationRetries,
    refetchOnWindowFocus,
    refetchOnReconnect,
    refetchOnMount,
    logger,
    onLogout,
  } = { ...DEFAULT_CONFIG, ...config };

  const handleLogout = onLogout || createDefaultLogoutHandler();

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime,
        gcTime,
        retry: (failureCount, error) => {
          // Don't retry 401 errors - they're handled by Axios interceptor
          if (is401Error(error)) {
            logger?.debug?.('Query failed with 401, not retrying');
            return false;
          }
          return failureCount < maxRetries;
        },
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
        refetchOnWindowFocus,
        refetchOnReconnect,
        refetchOnMount,
      },
      mutations: {
        retry: (failureCount, error) => {
          if (is401Error(error)) {
            logger?.debug?.('Mutation failed with 401, not retrying');
            return false;
          }
          return failureCount < maxMutationRetries;
        },
        retryDelay: 1000,
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        if (shouldLogout(error)) {
          handleLogout();
          return;
        }
        logger?.error?.('Query error', error instanceof Error ? error : undefined, {
          is401: is401Error(error),
        });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        if (shouldLogout(error)) {
          handleLogout();
          return;
        }
        logger?.error?.('Mutation error', error instanceof Error ? error : undefined, {
          is401: is401Error(error),
        });
      },
    }),
  });

  return queryClient;
}

/**
 * Cache Presets for different data types
 * 
 * Use these presets for consistent caching across the application.
 */
export const cachePresets: CachePresets = {
  /**
   * Static data - rarely changes
   * Good for: permissions, roles, system settings
   */
  static: {
    staleTime: 30 * 60 * 1000, // 30 minutes
    gcTime: 60 * 60 * 1000, // 1 hour
    refetchOnWindowFocus: false,
  },

  /**
   * Normal data - changes occasionally
   * Good for: properties, users, organizations
   */
  normal: {
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: true,
  },

  /**
   * Dynamic data - changes frequently
   * Good for: transactions, activities, notifications
   */
  dynamic: {
    staleTime: 1 * 60 * 1000, // 1 minute
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
  },

  /**
   * Realtime data - always fresh
   * Good for: live status, counters, dashboards
   */
  realtime: {
    staleTime: 0, // Always stale
    gcTime: 1 * 60 * 1000, // 1 minute
    refetchOnWindowFocus: true,
  },
};

/**
 * Create base query keys for a module
 */
export function createQueryKeyFactory<T extends string>(
  module: T
): {
  all: readonly [T];
  lists: () => readonly [T, 'list'];
  list: (filters?: Record<string, unknown>) => readonly [T, 'list', Record<string, unknown>?];
  details: () => readonly [T, 'detail'];
  detail: (id: string) => readonly [T, 'detail', string];
} {
  return {
    all: [module] as const,
    lists: () => [module, 'list'] as const,
    list: (filters?: Record<string, unknown>) => [module, 'list', filters] as const,
    details: () => [module, 'detail'] as const,
    detail: (id: string) => [module, 'detail', id] as const,
  };
}

/**
 * Invalidation helpers for common patterns
 */
export const invalidationHelpers = {
  /**
   * Invalidate all queries for a module
   */
  invalidateModule: async (queryClient: QueryClient, module: string): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: [module] });
  },

  /**
   * Invalidate all list queries for a module
   */
  invalidateLists: async (queryClient: QueryClient, module: string): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: [module, 'list'] });
  },

  /**
   * Invalidate a specific detail query
   */
  invalidateDetail: async (
    queryClient: QueryClient,
    module: string,
    id: string
  ): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: [module, 'detail', id] });
  },

  /**
   * Invalidate and refetch (useful for critical data)
   */
  invalidateAndRefetch: async (queryClient: QueryClient, queryKey: readonly unknown[]): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.refetchQueries({ queryKey });
  },
};
