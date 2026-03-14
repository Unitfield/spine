/**
 * Axios Interceptor Setup for Auto-Generated API Clients
 *
 * This module enhances auto-generated Axios-based API clients with:
 * - Automatic token refresh on 401 (serialized to prevent race conditions)
 * - Retry logic with exponential backoff
 * - ProblemDetails error parsing
 * - Timeout management
 * - Comprehensive logging
 *
 * CRITICAL: Token refresh is serialized using a global promise queue.
 * This prevents race conditions when multiple concurrent requests get 401
 * and all try to refresh the token simultaneously (which would fail due
 * to refresh token rotation - the second refresh would use an invalid token).
 */

import type { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import type { ProblemDetails, RetryConfig, APILogger, TokenRefreshFn, TokenRefreshResult } from './types';
import { calculateBackoffDelay, isRetryableError } from './retry-handler';

/**
 * Global token refresh queue - prevents concurrent refresh attempts
 * 
 * When multiple requests get 401 simultaneously:
 * 1. First request starts the refresh, creates a promise
 * 2. Other requests wait for the same promise
 * 3. When refresh completes, all waiting requests get the new token
 * 4. This prevents refresh token rotation race conditions
 */
const refreshPromiseMap = new Map<string, Promise<TokenRefreshResult>>();

/**
 * Get or create a token refresh promise for a session
 * Ensures only one refresh happens at a time per session
 */
function getOrCreateRefreshPromise(
  sessionKey: string,
  refreshFn: () => Promise<TokenRefreshResult>,
  logger?: APILogger
): Promise<TokenRefreshResult> {
  // Check if there's already a refresh in progress for this session
  const existingPromise = refreshPromiseMap.get(sessionKey);
  if (existingPromise) {
    logger?.info?.('Token refresh already in progress, waiting for existing refresh');
    return existingPromise;
  }

  // Create new refresh promise
  logger?.info?.('Starting new token refresh');
  const refreshPromise = refreshFn().finally(() => {
    // Clean up after refresh completes (success or failure)
    refreshPromiseMap.delete(sessionKey);
  });

  refreshPromiseMap.set(sessionKey, refreshPromise);
  return refreshPromise;
}

/**
 * Extract session key from request for refresh deduplication
 */
function getSessionKeyFromRequest(request: Request): string {
  // Use cookie header as session identifier (contains session ID)
  const cookie = request.headers.get('cookie') || '';
  // Use first 50 chars of cookie as key
  return `session:${cookie.slice(0, 50)}`;
}

/**
 * Axios Setup Options
 */
export interface AxiosSetupOptions {
  /**
   * Logger instance for logging
   */
  logger?: APILogger;
  /**
   * Token refresh function
   */
  attemptTokenRefresh?: TokenRefreshFn;
  /**
   * Retry configuration
   */
  retryConfig?: RetryConfig;
  /**
   * Whether to add request ID header
   */
  addRequestId?: boolean;
}

/**
 * Setup Axios interceptors for auto-generated clients
 *
 * Features:
 * - Automatic token refresh on 401
 * - Retry logic with exponential backoff
 * - ProblemDetails error parsing
 * - Timeout management
 * - Comprehensive logging
 *
 * @param axiosInstance - The Axios instance from auto-generated client
 * @param request - The incoming request object (for token refresh)
 * @param options - Configuration options
 *
 * @example
 * `	ypescript
 * const config = await createAPIConfig(request);
 * const api = new IdentityApi(config);
 * setupAxiosInterceptors(api.axios, request, { logger, attemptTokenRefresh });
 *
 * // Now all API calls have automatic retry, token refresh, error handling
 * const users = await api.getUsers(tenantId);
 * `
 */
export function setupAxiosInterceptors(
  axiosInstance: AxiosInstance,
  request: Request,
  options: AxiosSetupOptions = {}
): void {
  const {
    logger,
    attemptTokenRefresh,
    retryConfig = {},
    addRequestId = true,
  } = options;

  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 10000,
  } = retryConfig;

  // CRITICAL: Check if interceptors are already setup to prevent duplicate interceptors
  // Multiple interceptors cause exponential request multiplication
  if ((axiosInstance as any)._interceptorsSetup) {
    logger?.debug?.('Interceptors already setup, skipping');
    return;
  }
  (axiosInstance as any)._interceptorsSetup = true;

  // Request interceptor: Add request ID for tracing
  if (addRequestId) {
    axiosInstance.interceptors.request.use(
      (config: InternalAxiosRequestConfig) => {
        config.headers['X-Request-Id'] = crypto.randomUUID();

        logger?.debug?.('Axios request initiated', {
          method: config.method,
          url: config.url,
          requestId: config.headers['X-Request-Id'] as string,
        });

        return config;
      },
      (error) => {
        logger?.error?.('Axios request setup failed', error);
        return Promise.reject(error);
      }
    );
  }

  // Response interceptor: Token refresh on 401
  if (attemptTokenRefresh) {
    axiosInstance.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

        // Check if 401 and should attempt token refresh
        if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
          originalRequest._retry = true;

          logger?.info?.('Received 401 from backend, attempting token refresh');

          // CRITICAL: Use serialized token refresh to prevent race conditions
          // Multiple concurrent 401s will share the same refresh promise
          const sessionKey = getSessionKeyFromRequest(request);
          const refreshResult = await getOrCreateRefreshPromise(
            sessionKey,
            () => attemptTokenRefresh(request),
            logger
          );

          if (refreshResult.success && refreshResult.newAccessToken) {
            logger?.info?.('Token refresh successful, retrying original request');

            // Update authorization header with new token
            originalRequest.headers.Authorization = `Bearer ${refreshResult.newAccessToken}`;

            // Retry the original request with new token
            return axiosInstance(originalRequest);
          } else if (refreshResult.shouldLogout) {
            logger?.error?.('Token refresh failed - refresh token expired or invalid');

            // Enhance error with logout flag for API route to handle
            const logoutError = new Error('REFRESH_TOKEN_EXPIRED') as any;
            logoutError.shouldLogout = true;
            logoutError.originalError = error;

            return Promise.reject(logoutError);
          } else {
            logger?.error?.('Token refresh failed but not requiring logout', undefined, {
              error: refreshResult.error,
            });
          }
        }

        return Promise.reject(error);
      }
    );
  }

  // Response interceptor: Retry logic with exponential backoff
  axiosInstance.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const config = error.config as InternalAxiosRequestConfig & { _retryCount?: number };

      if (!config) {
        return Promise.reject(error);
      }

      // CRITICAL: Never retry 401 errors - they're handled by token refresh interceptor
      if (error.response?.status === 401) {
        logger?.debug?.('401 detected, not retrying (handled by token refresh interceptor)');
        return Promise.reject(error);
      }

      // CRITICAL: Never retry 409 Conflict errors (concurrent modification)
      // These indicate a business logic conflict that won't be resolved by retrying
      if (error.response?.status === 409) {
        logger?.debug?.('409 Conflict detected, will not retry');
        return Promise.reject(error);
      }

      if (config._retryCount === undefined) {
        config._retryCount = 0;
      }

      const shouldRetry = isRetryableError(error) && config._retryCount < maxRetries;

      if (shouldRetry) {
        config._retryCount++;

        const delay = calculateBackoffDelay(config._retryCount, baseDelay, maxDelay);

        logger?.info?.('Retrying request', {
          attempt: config._retryCount,
          maxRetries,
          delay,
          error: error.message,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));

        return axiosInstance(config);
      }

      return Promise.reject(error);
    }
  );

  // Response interceptor: Error handling with ProblemDetails parsing
  axiosInstance.interceptors.response.use(
    (response) => response,
    (error: AxiosError<ProblemDetails>) => {
      if (error.response?.data) {
        const problemDetails = error.response.data;

        logger?.error?.('API error (ProblemDetails)', undefined, {
          code: problemDetails.title,
          status: problemDetails.status,
          detail: problemDetails.detail,
          traceId: problemDetails.traceId,
        });

        // Enhance error with parsed ProblemDetails
        (error as any).problemDetails = problemDetails;
      }

      return Promise.reject(error);
    }
  );
}

/**
 * Create Enhanced Client Options
 */
export interface CreateEnhancedClientOptions extends AxiosSetupOptions {
  /**
   * Whether tenant is required
   */
  requireTenant?: boolean;
  /**
   * Whether to include auth
   */
  includeAuth?: boolean;
  /**
   * Explicit tenant ID override
   */
  tenantId?: string;
  /**
   * Custom headers
   */
  customHeaders?: Record<string, string>;
}

/**
 * Helper to create and setup an API client in one call
 *
 * @param request - The incoming request object
 * @param ClientClass - The auto-generated API client class
 * @param createAPIConfig - Function to create API configuration
 * @param ConfigurationClass - The Configuration class from generated API
 * @param options - Configuration options
 * @returns Configured API client instance with interceptors
 *
 * @example
 * `	ypescript
 * import { IdentityApi, Configuration } from './generated-api';
 *
 * const { client: api, tenantId } = await createEnhancedClient(
 *   request,
 *   IdentityApi,
 *   createAPIConfig,
 *   Configuration,
 *   { logger, attemptTokenRefresh }
 * );
 * const users = await api.getUsers(tenantId);
 * `
 */
export async function createEnhancedClient<T>(
  request: Request,
  ClientClass: new (configuration?: any, basePath?: string, axios?: AxiosInstance) => T,
  createAPIConfig: (request: Request, options?: any) => Promise<any>,
  ConfigurationClass: new (params?: any) => any,
  options: CreateEnhancedClientOptions = {}
): Promise<{ client: T; tenantId: string }> {
  const { requireTenant, includeAuth, tenantId, customHeaders, ...axiosOptions } = options;

  const config = await createAPIConfig(request, {
    requireTenant,
    includeAuth,
    tenantId,
    customHeaders,
  });

  // Create Configuration object for auto-generated clients
  const configuration = new ConfigurationClass({
    basePath: config.basePath,
    accessToken: config.accessToken,
    baseOptions: {
      headers: config.headers,
    },
  });

  const client = new ClientClass(configuration);

  // Access protected axios instance via type assertion
  const axiosInstance = (client as any).axios as AxiosInstance | undefined;

  // Setup interceptors for token refresh and retry logic
  // IMPORTANT: Only setup once per instance to prevent duplication
  if (axiosInstance) {
    setupAxiosInterceptors(axiosInstance, request, axiosOptions);
  }

  return { client, tenantId: config.tenantId };
}
