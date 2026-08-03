/**
 * API Configuration Server Module
 *
 * Centralized configuration for all API clients,
 * automatically handling authentication tokens and tenant context.
 */

import type {
  APIConfig,
  CreateAPIConfigOptions,
  GetAccessTokenFn,
  GetAvailableTenantsFn,
  GetCurrentTenantFn,
  APILogger,
  ValidateTenantFn,
} from './types';

/**
 * Base URL Configuration
 * Single unified base URL for all API operations
 */
const DEFAULT_API_BASE_URL = process.env.API_BASE_URL || '';

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
  /**
   * Header name used for bearer-style auth. Set to null when buildHeaders owns auth.
   * @default 'Authorization'
   */
  authHeaderName?: string | null;
  /**
   * Build an auth header value from the resolved access token.
   * @default token => `Bearer ${token}`
   */
  authHeaderValue?: (accessToken: string) => string;
  /**
   * Header name used for tenant context. Set to null when buildHeaders owns tenancy.
   * @default 'X-Tenant-Id'
   */
  tenantHeaderName?: string | null;
  /**
   * Validate a resolved tenant selector against current server-side
   * membership before it is placed in an API configuration.
   */
  validateTenant?: ValidateTenantFn;
  /**
   * Optional membership resolver shorthand. `validateTenant` takes
   * precedence when both are provided.
   */
  getAvailableTenants?: GetAvailableTenantsFn;
  /**
   * Final app-specific header hook. Returned headers are merged last.
   */
  buildHeaders?: (context: APIHeaderStrategyContext) => Record<string, string>;
}

export interface APIHeaderStrategyContext {
  request: Request;
  options: CreateAPIConfigOptions;
  accessToken?: string;
  tenantId: string | null;
  includeAuth: boolean;
  requireTenant: boolean;
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
    userAgent = 'Spine/1.0',
    timeout = 30000,
    authHeaderName = 'Authorization',
    authHeaderValue = (token: string) => `Bearer ${token}`,
    tenantHeaderName = 'X-Tenant-Id',
    validateTenant,
    getAvailableTenants,
    buildHeaders,
  } = factoryOptions;

  const isTenantAuthorized: ValidateTenantFn | undefined = validateTenant ?? (
    getAvailableTenants
      ? async (request, tenantId) => (await getAvailableTenants(request)).includes(tenantId)
      : undefined
  );

  /**
   * Resolve tenant ID from request or options
   */
  async function resolveTenantId(
    request: Request,
    options: CreateAPIConfigOptions
  ): Promise<string | null> {
    // Use explicit tenant ID if provided
    if (options.tenantId) {
      const requestedTenantId = options.tenantId;

      if (!isTenantAuthorized) {
        // An explicit override is a selector, not proof of membership. When a
        // caller has not supplied a membership validator, only an already
        // resolved current tenant may be reused.
        const currentTenant = await getCurrentTenant(request, requestedTenantId);
        if (currentTenant !== requestedTenantId) {
          logger?.warn?.('Rejected explicit tenant override without membership validation');
          return null;
        }
      } else {
        try {
          const authorized = await isTenantAuthorized(request, requestedTenantId);
          if (!authorized) {
            logger?.warn?.('Rejected explicit tenant override outside current membership');
            return null;
          }
        } catch (error) {
          logger?.warn?.('Failed to validate explicit tenant override', error instanceof Error ? error : undefined);
          return null;
        }
      }

      logger?.debug?.('Using validated explicit tenant ID', { tenantId: requestedTenantId });
      return requestedTenantId;
    }

    // Resolve from current tenant context
    try {
      const tenantId = await getCurrentTenant(request);
      if (tenantId) {
        if (isTenantAuthorized) {
          let authorized = false;
          try {
            authorized = await isTenantAuthorized(request, tenantId);
          } catch (error) {
            logger?.warn?.('Failed to validate current tenant', error instanceof Error ? error : undefined);
          }

          if (!authorized) {
            logger?.warn?.('Rejected current tenant outside current membership');
            return null;
          }
        }

        logger?.debug?.('Resolved validated tenant from context', { tenantId });
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
   * - Adds authentication token using the configured auth header strategy
   * - Injects tenant context using the configured tenant header strategy
   * - Configures base URL from options or environment
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
      if (authHeaderName) {
        headers[authHeaderName] = authHeaderValue(token);
      }
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

      if (tenantHeaderName) {
        headers[tenantHeaderName] = tenantId;
      }
      logger?.debug?.('Added tenant context header', { tenantId });
    } else if (tenantHeaderName && options.tenantId) {
      // Do not let a raw custom header preserve an unvalidated selector after
      // tenant resolution failed.
      delete headers[tenantHeaderName];
    }

    if (buildHeaders) {
      const headerOptions: CreateAPIConfigOptions = tenantId
        ? options
        : { ...options, tenantId: undefined };

      Object.assign(headers, buildHeaders({
        request,
        options: headerOptions,
        accessToken,
        tenantId,
        includeAuth,
        requireTenant,
      }));
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
