/**
 * API Client Types
 */

// Re-export Logger from logging to avoid duplication
export type { LoggerConfig as Logger } from '../logging/types';

export interface APIConfig {
  basePath: string;
  accessToken?: string;
  headers: Record<string, string>;
  tenantId: string;
  credentials?: RequestCredentials;
  baseOptions?: {
    timeout?: number;
  };
}

export interface CreateAPIConfigOptions {
  requireTenant?: boolean;
  includeAuth?: boolean;
  tenantId?: string;
  customHeaders?: Record<string, string>;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  traceId: string;
  requestId?: string;
  instance?: string;
  meta?: {
    errors?: ValidationError[];
    [key: string]: unknown;
  };
}

export interface ValidationError {
  field: string;
  message: string;
  code?: string;
}

export interface RetryConfig {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  retryCondition?: (error: unknown) => boolean;
}

export interface APIRequestConfig {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
}

export interface APIResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  raw?: Response;
}

export interface APIClientError<T = unknown> extends Error {
  isApiClientError: true;
  response?: APIResponse<T>;
  config?: APIRequestConfig;
  problemDetails?: ProblemDetails;
  shouldLogout?: boolean;
  originalError?: unknown;
  cause?: unknown;
}

export function isApiClientError(error: unknown): error is APIClientError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'isApiClientError' in error &&
    (error as { isApiClientError?: boolean }).isApiClientError === true
  );
}

export type FetchAPI = typeof fetch;

export interface FetchRequestContext {
  fetch: FetchAPI;
  url: string;
  init: RequestInit;
}

export interface FetchResponseContext extends FetchRequestContext {
  response: Response;
}

export interface FetchErrorContext extends FetchRequestContext {
  error: unknown;
  response?: Response;
}

export interface FetchMiddleware {
  pre?: (context: FetchRequestContext) => Promise<{ url: string; init: RequestInit } | void>;
  post?: (context: FetchResponseContext) => Promise<Response | void>;
  onError?: (context: FetchErrorContext) => Promise<Response | void>;
}

export type EnhancedAPIClient<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? K extends `${string}Raw`
      ? T[K]
      : (...args: A) => Promise<APIResponse<R>>
    : T[K];
};

/**
 * API Logger interface for dependency injection (simplified)
 */
export interface APILogger {
  debug?: (message: string, context?: Record<string, unknown>) => void;
  info?: (message: string, context?: Record<string, unknown>) => void;
  warn?: (message: string, error?: Error, context?: Record<string, unknown>) => void;
  error?: (message: string, error?: Error, context?: Record<string, unknown>) => void;
}

/**
 * Function type for getting access token from request
 */
export type GetAccessTokenFn = (request: Request) => Promise<string | null>;

/**
 * Function type for getting current tenant from request
 */
export type GetCurrentTenantFn = (
  request: Request,
  requestedTenantId?: string,
) => Promise<string | null>;

/**
 * Validate a tenant selector against the current server-side membership set.
 * Tenant cookies and explicit request overrides must not be treated as
 * authorization evidence by themselves.
 */
export type ValidateTenantFn = (request: Request, tenantId: string) => Promise<boolean> | boolean;

/** Resolve the current server-side membership IDs for a request. */
export type GetAvailableTenantsFn = (request: Request) => Promise<readonly string[]> | readonly string[];

/**
 * Token refresh result
 */
export interface TokenRefreshResult {
  success: boolean;
  newAccessToken?: string;
  shouldLogout?: boolean;
  error?: string;
}

/**
 * Function type for attempting token refresh
 */
export type TokenRefreshFn = (request: Request) => Promise<TokenRefreshResult>;
