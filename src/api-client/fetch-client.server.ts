/**
 * Fetch-native API client setup for generated OpenAPI clients.
 *
 * This module preserves the shared request behaviors we need around fetch:
 * - request ID enrichment
 * - serialized token refresh on 401
 * - retry with exponential backoff
 * - ProblemDetails-aware error shaping
 *
 * It gives downstream apps a single fetch-native entry point for generated clients.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type {
  APIClientError,
  APIConfig,
  APIResponse,
  APILogger,
  CreateAPIConfigOptions,
  EnhancedAPIClient,
  FetchErrorContext,
  FetchMiddleware,
  FetchResponseContext,
  ProblemDetails,
  RetryConfig,
  TokenRefreshFn,
  TokenRefreshResult,
} from './types';
import { isApiClientError } from './types';
import { calculateBackoffDelay, fetchWithTimeout, isRetryableError } from './retry-handler';

type RuntimeApiResponse<T> = {
  raw: Response;
  value(): Promise<T>;
};

type GeneratedFetchClient = object;

type SpineRequestInit = RequestInit & {
  __spineMeta?: {
    requestId?: string;
    retryCount?: number;
    refreshed?: boolean;
  };
};

type ResponseRequestMeta = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

const refreshPromiseMap = new Map<string, Promise<TokenRefreshResult>>();
const responseRequestMeta = new WeakMap<Response, ResponseRequestMeta>();
const rawResponseStore = new AsyncLocalStorage<Map<string, RuntimeApiResponse<unknown>>>();

function getSessionKeyFromRequest(request: Request): string {
  const cookie = request.headers.get('cookie')?.trim() || '';

  // A missing cookie does not identify a Redis session. Never put all such
  // requests into the same process-wide refresh flight, or one request can
  // receive another request's newly issued access token. The caller creates a
  // fresh key per middleware instance, so even two clients built from the same
  // cookie-less Request cannot share a token accidentally.
  if (!cookie) {
    return `request:${crypto.randomUUID()}`;
  }

  const fingerprint = createHash('sha256').update(cookie).digest('hex');
  return `session:${fingerprint}`;
}

function getOrCreateRefreshPromise(
  sessionKey: string,
  refreshFn: () => Promise<TokenRefreshResult>,
  logger?: APILogger
): Promise<TokenRefreshResult> {
  const existingPromise = refreshPromiseMap.get(sessionKey);
  if (existingPromise) {
    logger?.info?.('Token refresh already in progress, waiting for existing refresh');
    return existingPromise;
  }

  logger?.info?.('Starting new token refresh');

  const refreshPromise = refreshFn().finally(() => {
    refreshPromiseMap.delete(sessionKey);
  });

  refreshPromiseMap.set(sessionKey, refreshPromise);
  return refreshPromise;
}

function ensureRequestMeta(init: SpineRequestInit): NonNullable<SpineRequestInit['__spineMeta']> {
  if (!init.__spineMeta) {
    init.__spineMeta = {};
  }

  return init.__spineMeta;
}

function headersToRecord(headersInit?: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(headersInit).entries());
}

function cloneInit(init: RequestInit): SpineRequestInit {
  const source = init as SpineRequestInit;

  return {
    ...source,
    headers: headersToRecord(source.headers),
    __spineMeta: source.__spineMeta ? { ...source.__spineMeta } : undefined,
  };
}

function createTimeoutFetch(timeout?: number): typeof fetch | undefined {
  if (!timeout) {
    return undefined;
  }

  return (input, init) => fetchWithTimeout(input, { ...init, timeout });
}

function isProblemDetails(value: unknown): value is ProblemDetails {
  return (
    typeof value === 'object' &&
    value !== null &&
    'title' in value &&
    'status' in value &&
    'detail' in value
  );
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const clone = response.clone();
  const contentType = clone.headers.get('content-type') || '';

  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return await clone.json();
    } catch {
      return undefined;
    }
  }

  try {
    const text = await clone.text();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function createClientError<T = unknown>(params: {
  message: string;
  response?: APIResponse<T>;
  config?: ResponseRequestMeta;
  problemDetails?: ProblemDetails;
  shouldLogout?: boolean;
  originalError?: unknown;
  cause?: unknown;
}): APIClientError<T> {
  const error = new Error(params.message) as APIClientError<T>;

  error.name = 'APIClientError';
  error.isApiClientError = true;
  error.response = params.response;
  error.config = params.config;
  error.problemDetails = params.problemDetails;
  error.shouldLogout = params.shouldLogout;
  error.originalError = params.originalError;
  error.cause = params.cause;

  return error;
}

async function toAPIResponse<T>(
  rawResponse: Response,
  resolvedData?: T
): Promise<APIResponse<T>> {
  const data = resolvedData === undefined ? ((await parseResponseBody(rawResponse)) as T) : resolvedData;

  return {
    data,
    status: rawResponse.status,
    statusText: rawResponse.statusText,
    headers: headersToRecord(rawResponse.headers),
    raw: rawResponse,
  };
}

async function normalizeClientError(error: unknown): Promise<APIClientError> {
  if (isApiClientError(error)) {
    return error;
  }

  if (error && typeof error === 'object' && 'response' in error && (error as { response?: unknown }).response instanceof Response) {
    const response = (error as { response: Response }).response;
    const responseData = await parseResponseBody(response);
    const problemDetails = isProblemDetails(responseData) ? responseData : undefined;

    return createClientError({
      message:
        problemDetails?.detail ||
        problemDetails?.title ||
        response.statusText ||
        'API request failed',
      response: await toAPIResponse(response, responseData),
      config: responseRequestMeta.get(response),
      problemDetails,
      cause: error,
    });
  }

  return createClientError({
    message: error instanceof Error ? error.message : 'API request failed',
    cause: error,
  });
}

function isRetryableFetchError(error: unknown): boolean {
  if (isRetryableError(error)) {
    return true;
  }

  if (error && typeof error === 'object' && 'cause' in error) {
    return isRetryableError((error as { cause?: unknown }).cause);
  }

  return false;
}

async function maybeRetryResponse(
  context: FetchResponseContext,
  retryConfig: Required<Pick<RetryConfig, 'maxRetries' | 'baseDelay' | 'maxDelay'>>,
  logger?: APILogger
): Promise<Response | undefined> {
  const init = cloneInit(context.init);
  const meta = ensureRequestMeta(init);

  if (context.response.status === 401 || context.response.status === 409) {
    return undefined;
  }

  if (!isRetryableError(context.response)) {
    return undefined;
  }

  const retryCount = meta.retryCount ?? 0;
  if (retryCount >= retryConfig.maxRetries) {
    return undefined;
  }

  meta.retryCount = retryCount + 1;

  const delay = calculateBackoffDelay(meta.retryCount, retryConfig.baseDelay, retryConfig.maxDelay);
  logger?.info?.('Retrying request', {
    url: context.url,
    method: (init.method ?? 'GET').toUpperCase(),
    attempt: meta.retryCount,
    maxRetries: retryConfig.maxRetries,
    delay,
    status: context.response.status,
  });

  await new Promise((resolve) => setTimeout(resolve, delay));

  return context.fetch(context.url, init);
}

async function maybeRetryError(
  context: FetchErrorContext,
  retryConfig: Required<Pick<RetryConfig, 'maxRetries' | 'baseDelay' | 'maxDelay'>>,
  logger?: APILogger
): Promise<Response | undefined> {
  const init = cloneInit(context.init);
  const meta = ensureRequestMeta(init);
  const retryCount = meta.retryCount ?? 0;

  if (!isRetryableFetchError(context.error) || retryCount >= retryConfig.maxRetries) {
    return undefined;
  }

  meta.retryCount = retryCount + 1;

  const delay = calculateBackoffDelay(meta.retryCount, retryConfig.baseDelay, retryConfig.maxDelay);
  logger?.info?.('Retrying request after fetch failure', {
    url: context.url,
    method: (init.method ?? 'GET').toUpperCase(),
    attempt: meta.retryCount,
    maxRetries: retryConfig.maxRetries,
    delay,
  });

  await new Promise((resolve) => setTimeout(resolve, delay));

  return context.fetch(context.url, init);
}

export interface FetchSetupOptions {
  logger?: APILogger;
  attemptTokenRefresh?: TokenRefreshFn;
  retryConfig?: RetryConfig;
  addRequestId?: boolean;
}

export function createFetchMiddleware(
  request: Request,
  options: FetchSetupOptions = {}
): FetchMiddleware[] {
  const {
    logger,
    attemptTokenRefresh,
    retryConfig = {},
    addRequestId = true,
  } = options;
  const refreshSessionKey = getSessionKeyFromRequest(request);

  const normalizedRetryConfig = {
    maxRetries: retryConfig.maxRetries ?? 3,
    baseDelay: retryConfig.baseDelay ?? 1000,
    maxDelay: retryConfig.maxDelay ?? 10000,
  };

  return [
    {
      async pre(context) {
        const init = cloneInit(context.init);
        const meta = ensureRequestMeta(init);
        const headers = new Headers(init.headers);

        if (addRequestId) {
          const requestId = headers.get('X-Request-Id') || crypto.randomUUID();
          headers.set('X-Request-Id', requestId);
          meta.requestId = requestId;
        }

        init.headers = headersToRecord(headers);

        logger?.debug?.('API request initiated', {
          method: (init.method ?? 'GET').toUpperCase(),
          url: context.url,
          requestId: meta.requestId,
        });

        return {
          url: context.url,
          init,
        };
      },

      async post(context) {
        const init = cloneInit(context.init);
        const meta = ensureRequestMeta(init);

        responseRequestMeta.set(context.response, {
          url: context.url,
          method: (init.method ?? 'GET').toUpperCase(),
          headers: headersToRecord(init.headers),
        });

        if (context.response.status === 401 && attemptTokenRefresh && !meta.refreshed) {
          meta.refreshed = true;

          logger?.info?.('Received 401 from backend, attempting token refresh', {
            url: context.url,
            method: (init.method ?? 'GET').toUpperCase(),
          });

          const refreshResult = await getOrCreateRefreshPromise(
            refreshSessionKey,
            () => attemptTokenRefresh(request),
            logger
          );

          if (refreshResult.success && refreshResult.newAccessToken) {
            const headers = new Headers(init.headers);
            headers.set('Authorization', `Bearer ${refreshResult.newAccessToken}`);
            init.headers = headersToRecord(headers);

            logger?.info?.('Token refresh successful, retrying original request');

            return context.fetch(context.url, init);
          }

          // A failed or malformed refresh must not fall through to the stale
          // 401 response. Treat every unsuccessful refresh as a terminal auth
          // failure so callers can clear their local session.
          throw createClientError({
            message: 'REFRESH_TOKEN_EXPIRED',
            response: await toAPIResponse(context.response),
            config: responseRequestMeta.get(context.response),
            shouldLogout: true,
            originalError: refreshResult,
            cause: refreshResult,
          });
        }

        const retryResponse = await maybeRetryResponse(context, normalizedRetryConfig, logger);
        if (retryResponse) {
          return retryResponse;
        }

        if (context.response.status >= 400) {
          const responseData = await parseResponseBody(context.response);
          const problemDetails = isProblemDetails(responseData) ? responseData : undefined;

          logger?.error?.('API error response received', undefined, {
            url: context.url,
            method: (init.method ?? 'GET').toUpperCase(),
            status: context.response.status,
            code: problemDetails?.title,
            detail: problemDetails?.detail,
            traceId: problemDetails?.traceId,
          });
        }

        return context.response;
      },

      async onError(context) {
        const retryResponse = await maybeRetryError(context, normalizedRetryConfig, logger);
        if (retryResponse) {
          return retryResponse;
        }

        return undefined;
      },
    },
  ];
}

export interface CreateApiClientOptions extends FetchSetupOptions, CreateAPIConfigOptions {
  credentials?: RequestCredentials;
}

function instrumentRawMethods<T extends GeneratedFetchClient>(client: T): void {
  if ((client as { __spineRawMethodsInstrumented?: boolean }).__spineRawMethodsInstrumented) {
    return;
  }

  const prototype = Object.getPrototypeOf(client) as Record<string, unknown>;

  for (const key of Object.getOwnPropertyNames(prototype)) {
    if (!key.endsWith('Raw')) {
      continue;
    }

    const original = prototype[key];
    if (typeof original !== 'function') {
      continue;
    }

    Object.defineProperty(client, key, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: async (...args: unknown[]) => {
        const result = await (original as (...innerArgs: unknown[]) => Promise<RuntimeApiResponse<unknown>>).apply(client, args);
        rawResponseStore.getStore()?.set(key, result);
        return result;
      },
    });
  }

  (client as { __spineRawMethodsInstrumented?: boolean }).__spineRawMethodsInstrumented = true;
}

function wrapClient<T extends GeneratedFetchClient>(client: T): EnhancedAPIClient<T> {
  instrumentRawMethods(client);

  const methodCache = new Map<PropertyKey, unknown>();

  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (typeof prop !== 'string' || typeof value !== 'function' || prop.endsWith('Raw')) {
        return typeof value === 'function' ? value.bind(target) : value;
      }

      if (methodCache.has(prop)) {
        return methodCache.get(prop);
      }

      const wrapped = async (...args: unknown[]) =>
        rawResponseStore.run(new Map(), async () => {
          try {
            const resolvedData = await (value as (...innerArgs: unknown[]) => Promise<unknown>).apply(target, args);
            const rawResponse = rawResponseStore.getStore()?.get(`${prop}Raw`);

            if (rawResponse) {
              return toAPIResponse(rawResponse.raw, resolvedData);
            }

            return {
              data: resolvedData,
              status: 200,
              statusText: 'OK',
              headers: {},
            };
          } catch (error) {
            throw await normalizeClientError(error);
          }
        });

      methodCache.set(prop, wrapped);
      return wrapped;
    },
  }) as EnhancedAPIClient<T>;
}

export async function createApiClient<T extends GeneratedFetchClient>(
  request: Request,
  ClientClass: new (configuration?: unknown) => T,
  createAPIConfig: (request: Request, options?: CreateAPIConfigOptions) => Promise<APIConfig>,
  ConfigurationClass: new (params?: Record<string, unknown>) => unknown,
  options: CreateApiClientOptions = {}
): Promise<{ client: EnhancedAPIClient<T>; tenantId: string }> {
  const {
    requireTenant,
    includeAuth,
    tenantId,
    customHeaders,
    credentials,
    ...fetchOptions
  } = options;

  const config = await createAPIConfig(request, {
    requireTenant,
    includeAuth,
    tenantId,
    customHeaders,
  });

  const configuration = new ConfigurationClass({
    basePath: config.basePath,
    accessToken: config.accessToken,
    headers: config.headers,
    credentials: credentials ?? config.credentials,
    middleware: createFetchMiddleware(request, fetchOptions),
    fetchApi: createTimeoutFetch(config.baseOptions?.timeout),
  });

  const client = new ClientClass(configuration);

  return {
    client: wrapClient(client),
    tenantId: config.tenantId,
  };
}
