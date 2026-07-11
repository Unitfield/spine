/**
 * Route Protection Server Module
 * 
 * Provides route protection utilities for different authentication levels.
 */

import { getUser, requireAuth, refreshTokens, login, logout } from './auth.server';
import { getAuthSession } from './redis-session-storage.server';
import type { ProtectionLevel, UserInfo } from './types';
import { logger } from '../logging';
import { createRedirectResponse } from '../http/response';

// Refresh shortly before expiry. Keep this below common 5-minute access-token
// lifetimes so a freshly issued token does not refresh again immediately.
const REFRESH_THRESHOLD = resolveRefreshThreshold();

function resolveRefreshThreshold(): number {
  const configured = Number(process.env.OIDC_REFRESH_THRESHOLD_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
}

/**
 * Check if token needs refresh
 */
export async function shouldRefreshToken(request: Request): Promise<boolean> {
  try {
    const sessionData = await getAuthSession(request);

    if (!sessionData.refreshToken || sessionData.refreshToken.length === 0) {
      if (sessionData.expiresAt && Date.now() >= sessionData.expiresAt) {
        logger.info('Token expired and no refresh token, forcing local application logout');
        const logoutRequest = await createAutomaticLogoutRequest(request, 'expired-no-refresh-token');
        throw await logout(logoutRequest);
      }
      return false;
    }

    if (!sessionData.expiresAt || !sessionData.accessToken) {
      return false;
    }

    const now = Date.now();

    // Check JWT expiry
    let jwtExpiry: number | null = null;
    try {
      const tokenParts = sessionData.accessToken.split('.');
      if (tokenParts.length === 3) {
        const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
        if (payload.exp) {
          jwtExpiry = payload.exp * 1000;
        }
      }
    } catch {
      // Ignore JWT decode errors
    }

    const earliestExpiry = jwtExpiry && jwtExpiry < sessionData.expiresAt 
      ? jwtExpiry 
      : sessionData.expiresAt;
    const timeUntilEarliestExpiry = earliestExpiry - now;

    return timeUntilEarliestExpiry <= REFRESH_THRESHOLD;
  } catch (error) {
    logger.error('Error checking token refresh', error instanceof Error ? error : undefined);
    return false;
  }
}

/**
 * Auto-refresh tokens if needed
 */
async function autoRefreshTokens(request: Request): Promise<void> {
  try {
    const needsRefresh = await shouldRefreshToken(request);

    if (needsRefresh) {
      logger.info('Auto-refreshing tokens due to expiry');
      const result = await refreshTokens(request);

      if (result.success) {
        logger.info('Auto-refresh completed successfully');
      } else {
        logger.error('Auto-refresh failed', undefined, { error: result.error });

        if (result.shouldLogout) {
          logger.error('Refresh token invalid, forcing local application logout');
          const logoutRequest = await createAutomaticLogoutRequest(request, 'refresh-failed');
          throw await logout(logoutRequest);
        }
      }
    }
  } catch (error) {
    if (error instanceof Response && error.status >= 300 && error.status < 400) {
      throw error;
    }
    throw error;
  }
}

/**
 * Identity context check configuration
 */
export interface DefaultRouteIdentityContext {
  hasAnyMembership: boolean;
  hasEntitlement?: boolean;
  /** @deprecated Use hasEntitlement or app-specific fields instead. */
  hasSubscription: boolean;
  isOnboarded: boolean;
}

export interface IdentityContextChecker<TIdentityContext = DefaultRouteIdentityContext> {
  getIdentityContext: (
    request: Request,
    userId: string,
    forceRefresh?: boolean
  ) => Promise<DefaultRouteIdentityContext & TIdentityContext>;
}

/**
 * Tenant checker configuration
 */
export interface TenantChecker {
  getCurrentTenant: (request: Request) => Promise<string | null>;
  initializeTenant: (request: Request) => Promise<{ headers: Headers; tenantId: string } | null>;
}

/**
 * Legacy subscription checker configuration
 *
 * @deprecated Put entitlement policy in resolveRoute or app-level route loaders.
 */
export interface SubscriptionChecker {
  checkTenantSubscriptionStatus: (request: Request, tenantId: string) => Promise<boolean>;
}

export interface RouteProtectionRedirect {
  location: string;
  headers?: HeadersInit;
  status?: number;
}

export interface AutomaticLogoutRequestContext {
  request: Request;
  reason: 'expired-no-refresh-token' | 'refresh-failed';
}

export interface LoginReturnUrlContext {
  request: Request;
  currentPath: string;
  protection: ProtectionLevel;
}

export interface RouteProtectionResolverContext<TIdentityContext = DefaultRouteIdentityContext> {
  request: Request;
  user: UserInfo;
  currentPath: string;
  protection: ProtectionLevel;
  getIdentityContext: (forceRefresh?: boolean) => Promise<TIdentityContext | null>;
  getCurrentTenant: () => Promise<string | null>;
  initializeTenant: () => Promise<{ headers: Headers; tenantId: string } | null>;
}

export interface RouteProtectionErrorHandlerContext<TIdentityContext = DefaultRouteIdentityContext>
  extends RouteProtectionResolverContext<TIdentityContext> {
  error: unknown;
}

/**
 * Route protection configuration
 */
export interface RouteProtectionConfig<TIdentityContext = DefaultRouteIdentityContext> {
  identityChecker?: IdentityContextChecker<TIdentityContext>;
  tenantChecker?: TenantChecker;
  subscriptionChecker?: SubscriptionChecker;
  resolveRoute?: (
    context: RouteProtectionResolverContext<TIdentityContext>
  ) => Promise<RouteProtectionRedirect | null | void> | RouteProtectionRedirect | null | void;
  handleRouteError?: (
    context: RouteProtectionErrorHandlerContext<TIdentityContext>
  ) => Promise<RouteProtectionRedirect | null | void> | RouteProtectionRedirect | null | void;
  getLoginReturnUrl?: (context: LoginReturnUrlContext) => string;
  createAutomaticLogoutRequest?: (
    context: AutomaticLogoutRequestContext
  ) => Promise<Request> | Request;
}

let protectionConfig: RouteProtectionConfig<any> = {};

/**
 * Configure route protection with identity, tenant, and app policy checkers
 */
export function configureRouteProtection<TIdentityContext = DefaultRouteIdentityContext>(
  config: RouteProtectionConfig<TIdentityContext>
): void {
  protectionConfig = config;
}

/**
 * Reset route protection to its built-in defaults.
 */
export function resetRouteProtectionConfig(): void {
  protectionConfig = {};
}

function createRedirectFromConfig(redirect: RouteProtectionRedirect): Response {
  return createRedirectResponse(redirect.location, {
    headers: redirect.headers,
    status: redirect.status,
  });
}

function getLoginReturnUrl(
  request: Request,
  currentPath: string,
  protection: ProtectionLevel
): string {
  if (protectionConfig.getLoginReturnUrl) {
    return protectionConfig.getLoginReturnUrl({
      request,
      currentPath,
      protection,
    });
  }

  switch (protection) {
    case 'onboarding-required':
    case 'subscription-required':
    case 'public':
    case 'auth':
    default: {
      const url = new URL(request.url);
      return url.pathname === '/' ? '/' : `${url.pathname}${url.search}`;
    }
  }
}

async function createAutomaticLogoutRequest(
  request: Request,
  reason: AutomaticLogoutRequestContext['reason']
): Promise<Request> {
  if (protectionConfig.createAutomaticLogoutRequest) {
    return protectionConfig.createAutomaticLogoutRequest({ request, reason });
  }

  const logoutUrl = new URL(request.url);
  logoutUrl.pathname = '/auth/logout';
  logoutUrl.searchParams.set('logout', 'local');

  return new Request(logoutUrl.toString(), {
    headers: request.headers,
  });
}

function createRouteResolverContext(
  request: Request,
  user: UserInfo,
  currentPath: string,
  protection: ProtectionLevel
): RouteProtectionResolverContext<any> {
  let identityContextPromise: Promise<any | null> | null = null;
  let currentTenantPromise: Promise<string | null> | null = null;
  let initializeTenantPromise: Promise<{ headers: Headers; tenantId: string } | null> | null = null;

  return {
    request,
    user,
    currentPath,
    protection,
    getIdentityContext: async (forceRefresh = false) => {
      if (!protectionConfig.identityChecker) {
        return null;
      }

      if (forceRefresh) {
        return protectionConfig.identityChecker.getIdentityContext(request, user.sub, true);
      }

      if (!identityContextPromise) {
        identityContextPromise = protectionConfig.identityChecker.getIdentityContext(request, user.sub);
      }

      return identityContextPromise;
    },
    getCurrentTenant: async () => {
      if (!protectionConfig.tenantChecker) {
        return null;
      }

      if (!currentTenantPromise) {
        currentTenantPromise = protectionConfig.tenantChecker.getCurrentTenant(request);
      }

      return currentTenantPromise;
    },
    initializeTenant: async () => {
      if (!protectionConfig.tenantChecker) {
        return null;
      }

      if (!initializeTenantPromise) {
        initializeTenantPromise = protectionConfig.tenantChecker.initializeTenant(request);
      }

      return initializeTenantPromise;
    },
  };
}

async function applyConfiguredRouteResolution(
  request: Request,
  user: UserInfo,
  currentPath: string,
  protection: ProtectionLevel
): Promise<boolean> {
  if (!protectionConfig.resolveRoute) {
    return false;
  }

  const context = createRouteResolverContext(request, user, currentPath, protection);

  try {
    const result = await protectionConfig.resolveRoute(context);
    if (result) {
      throw createRedirectFromConfig(result);
    }

    return true;
  } catch (error) {
    if (error instanceof Response && error.status >= 300 && error.status < 400) {
      throw error;
    }

    if (!protectionConfig.handleRouteError) {
      throw error;
    }

    const recovery = await protectionConfig.handleRouteError({
      ...context,
      error,
    });

    if (recovery) {
      throw createRedirectFromConfig(recovery);
    }

    throw error;
  }
}

/**
 * Main route protection function
 */
export async function protectRoute<T>(
  request: Request,
  protection: ProtectionLevel,
  loaderFn: (user?: UserInfo) => Promise<T> | T
): Promise<T> {
  const url = new URL(request.url);

  switch (protection) {
    case 'public':
      try {
        await autoRefreshTokens(request);
        const user = await getUser(request);
        return loaderFn(user ?? undefined);
      } catch {
        return loaderFn(undefined);
      }

    case 'auth':
    case 'policy':
      try {
        await autoRefreshTokens(request);
        const user = await requireAuth(request);
        await applyConfiguredRouteResolution(request, user, url.pathname, protection);
        return loaderFn(user);
      } catch (error) {
        if (error instanceof Response && error.status >= 300 && error.status < 400) {
          throw error;
        }
        throw await login(request, getLoginReturnUrl(request, url.pathname, protection));
      }

    case 'onboarding-required':
      try {
        await autoRefreshTokens(request);
        const user = await requireAuth(request);

        await applyConfiguredRouteResolution(
          request,
          user,
          url.pathname,
          'onboarding-required'
        );

        return loaderFn(user);
      } catch (error) {
        if (error instanceof Response && error.status >= 300 && error.status < 400) {
          throw error;
        }
        throw await login(request, getLoginReturnUrl(request, url.pathname, 'onboarding-required'));
      }

    case 'subscription-required':
      try {
        await autoRefreshTokens(request);
        const user = await requireAuth(request);

        await applyConfiguredRouteResolution(
          request,
          user,
          url.pathname,
          'subscription-required'
        );

        // Initialize tenant if needed
        if (protectionConfig.tenantChecker) {
          const currentTenant = await protectionConfig.tenantChecker.getCurrentTenant(request);
          if (!currentTenant) {
            await protectionConfig.tenantChecker.initializeTenant(request);
          }
        }

        return loaderFn(user);
      } catch (error) {
        if (error instanceof Response && error.status >= 300 && error.status < 400) {
          throw error;
        }
        throw await login(request, getLoginReturnUrl(request, url.pathname, 'subscription-required'));
      }

    default:
      throw new Error(`Unknown protection level: ${protection}`);
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Public route (optional auth)
 */
export const publicRoute = <T>(
  request: Request,
  loaderFn: (user?: UserInfo) => Promise<T> | T
) => protectRoute(request, 'public', loaderFn);

/**
 * Auth-protected route
 */
export const authRoute = <T>(
  request: Request,
  loaderFn: (user: UserInfo) => Promise<T> | T
) => protectRoute(request, 'auth', loaderFn as (user?: UserInfo) => Promise<T> | T);

/**
 * Generic policy-protected route. Apps define policy in configureRouteProtection.
 */
export const policyRoute = <T>(
  request: Request,
  loaderFn: (user: UserInfo) => Promise<T> | T
) => protectRoute(request, 'policy', loaderFn as (user?: UserInfo) => Promise<T> | T);

/**
 * Alias for auth-protected routes.
 */
export const protectedRoute = authRoute;

/**
 * Setup policy route
 *
 * @deprecated Use policyRoute with configureRouteProtection instead.
 */
export const onboardingRoute = <T>(
  request: Request,
  loaderFn: (user: UserInfo) => Promise<T> | T
) => protectRoute(request, 'onboarding-required', loaderFn as (user?: UserInfo) => Promise<T> | T);

/**
 * Entitlement policy route
 *
 * @deprecated Use policyRoute with configureRouteProtection instead.
 */
export const subscriptionRoute = <T>(
  request: Request,
  loaderFn: (user: UserInfo) => Promise<T> | T
) => protectRoute(request, 'subscription-required', loaderFn as (user?: UserInfo) => Promise<T> | T);
