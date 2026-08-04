/**
 * API Client Module - Client Exports
 *
 * Client-side exports for API client module.
 */

// Types
export type {
  APIConfig,
  APIRequestConfig,
  APIResponse,
  APIClientError,
  CreateAPIConfigOptions,
  ProblemDetails,
  ValidationError,
  RetryConfig,
  APILogger,
  GetAccessTokenFn,
  GetAvailableTenantsFn,
  GetCurrentTenantFn,
  ValidateTenantFn,
  TokenRefreshResult,
  TokenRefreshFn,
  FetchAPI,
  FetchMiddleware,
  FetchRequestContext,
  FetchResponseContext,
  FetchErrorContext,
  EnhancedAPIClient,
} from './types';

export { isApiClientError } from './types';

// Error Codes
export { ErrorCodes } from './error-codes';

// Error Handler
export { ApiError, ErrorHandler, handleApiError } from './error-handler';

// Retry Handler (client-safe)
export {
  calculateBackoffDelay,
  isRetryableError,
  withRetry,
  fetchWithTimeout,
  createRetryFetch
} from './retry-handler';
