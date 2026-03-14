/**
 * API Configuration Server Module
 *
 * Centralized configuration for all API clients,
 * automatically handling authentication tokens and tenant context.
 */

import type { APIConfig, CreateAPIConfigOptions, GetAccessTokenFn, GetCurrentTenantFn, APILogger } from './types';

/**
 * Base URL Configuration
 * Single unified base URL for all API operations
 */
const DEFAULT_API_BASE_URL = process.env.API_BASE_URL || 'https://localhost:5001';

/**
 * Default Headers
 * Applied to all API requests
 */
const DEFAULT_HEADERS: Record<string, string> = {
  Accept: 'application/json, application/problem+json',
  'Content-Type': 'application/json',
};

/**
 * API Config Factory Options
 */
export interface APIConfigFactoryOptions {
  /**
   * Base URL for API requests
   */
  baseURL?: string;
  /**
   * Default headers applied to all requests
   */
  defaultHeaders?: Record<string, string>;
  /**
   * User agent string
   */
  userAgent?: string;
  /**
   * Default timeout in milliseconds
   */
  timeout?: number;
}

/**
 * Create API Config Factory
 *
 * Creates a factory function that generates API configurations
 * with the provided auth and tenant resolvers.
 */
export function createAPIConfigFactory(
  getAccessToken: GetAccessTokenFn,
  getCurrentTenant: GetCurrentTenantFn,
  logger?: APILogger,
  factoryOptions: APIConfigFactoryOptions = {}
) {
  const {
    baseURL = DEFAULT_API_BASE_URL,
    defaultHeaders = DEFAULT_HEADERS,
    userAgent = 'MimirCore/1.0',
    timeout = 30000,
  } = factoryOptions;

  /**
   * Resolve tenant ID from request or options
   */
  async function resolveTenantId(
    request: Request,
    options: CreateAPIConfigOptions
  ): Promise<string | null> {
    // Use explicit tenant ID if provided
    if (options.tenantId) {
      logger?.debug?.('Using explicit tenant ID', { tenantId: options.tenantId });
      return options.tenantId;
    }

    // Resolve from current tenant context
    try {
      const tenantId = await getCurrentTenant(request);
      if (tenantId) {
        logger?.debug?.('Resolved tenant from context', { tenantId });
      }
      return tenantId;
    } catch (error) {
      logger?.warn?.('Failed to resolve current tenant', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * Creates unified API configuration for all services.
   *
   * This function automatically:
   * - Adds authentication token to Authorization header
   * - Injects tenant context as X-Tenant-Id header
   * - Configures base URL from environment
   * - Applies default headers
   *
   * @param request - The incoming request object
   * @param options - Configuration options
   * @returns API configuration object
   * @throws Error if required authentication or tenant context is missing
   *
   * @example
   * `	ypescript
   * // Standard usage with auth and tenant
   * const config = await createAPIConfig(request);
   * const api = new IdentityApi(config);
   *
   * // Without tenant requirement
   * const config = await createAPIConfig(request, { requireTenant: false });
   *
   * // With explicit tenant override
   * const config = await createAPIConfig(request, { tenantId: 'specific-tenant-id' });
   * `
   */
  async function createAPIConfig(
    request: Request,
    options: CreateAPIConfigOptions = {}
  ): Promise<APIConfig> {
    const {
      requireTenant = true,
      includeAuth = true,
      customHeaders = {},
    } = options;

    // Start with default headers
    const headers: Record<string, string> = {
      ...defaultHeaders,
      'User-Agent': userAgent,
      ...customHeaders,
    };

    let accessToken: string | undefined;

    // Add authentication if required
    if (includeAuth) {
      const token = await getAccessToken(request);
      if (!token) {
        logger?.error?.('No access token available for API request');
        throw new Error('No access token available');
      }

      accessToken = token;
      headers.Authorization = `Bearer ${token}`;
      logger?.debug?.('Added authorization header to API config');
    }

    // Resolve tenant context
    const tenantId = await resolveTenantId(request, options);

    // Add tenant header if required
    if (requireTenant) {
      if (!tenantId) {
        logger?.error?.('Tenant context required but not available');
        throw new Error('Tenant context is required for this operation');
      }

      headers['X-Tenant-Id'] = tenantId;
      logger?.debug?.('Added tenant context header', { tenantId });
    }

    logger?.debug?.('API config created', {
      basePath: baseURL,
      hasAuth: includeAuth,
      hasTenant: !!tenantId,
      requireTenant,
    });

    return {
      basePath: baseURL,
      accessToken,
      headers,
      tenantId: tenantId || '',
      baseOptions: {
        timeout,
      },
    };
  }

  /**
   * Get the configured API base URL
   */
  function getAPIBaseURL(): string {
    return baseURL;
  }

  return {
    createAPIConfig,
    getAPIBaseURL,
  };
}

export type APIConfigFactory = ReturnType<typeof createAPIConfigFactory>;
