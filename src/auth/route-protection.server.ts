/**
 * Route Protection Server Module
 * 
 * Provides route protection utilities for different authentication levels.
 */

import { getUser, requireAuth, refreshTokens, login } from './auth.server';
import { getAuthSession } from './redis-session-storage.server';
import type { ProtectionLevel, UserInfo } from './types';
import { logger } from '../logging';
import { createRedirectResponse } from '../http/response';

// Token refresh threshold (5 minutes before expiry)
const REFRESH_THRESHOLD = 5 * 60 * 1000;

/**
 * Check if token needs refresh
 */
export async function shouldRefreshToken(request: Request): Promise<boolean> {
  try {
    const sessionData = await getAuthSession(request);

    if (!sessionData.refreshToken || sessionData.refreshToken.length === 0) {
      if (sessionData.expiresAt && Date.now() >= sessionData.expiresAt) {
        logger.info('Token expired and no refresh token, forcing app-specific logout');
        const { logout } = await import('./auth.server');
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
          logger.error('Refresh token invalid, forcing app-specific logout');
          const { logout } = await import('./auth.server');
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
 * Subscription checker configuration
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
 * Configure route protection with identity/tenant/subscription checkers
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
      return '/onboarding';
    case 'subscription-required':
      return '/subscription';
    case 'public':
      return '/';
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
  logoutUrl.searchParams.set('client_id_only', 'true');

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
 * Check user status (onboarding, subscription)
 */
async function checkUserStatus(
  request: Request, 
  user: UserInfo, 
  currentPath: string
): Promise<Response | null> {
  if (!protectionConfig.identityChecker) {
    logger.warn('Identity checker not configured, skipping status check');
    return null;
  }

  try {
    const context = await protectionConfig.identityChecker.getIdentityContext(request, user.sub);

    logger.debug('User status check', {
      userId: user.sub,
      currentPath,
      hasAnyMembership: context.hasAnyMembership,
      isOnboarded: context.isOnboarded,
      hasSubscription: context.hasSubscription,
    });

    // Check if user needs onboarding
    if (!context.hasAnyMembership) {
      if (currentPath !== '/onboarding') {
        logger.info('User has no memberships, redirecting to onboarding');
        throw createRedirectResponse('/onboarding');
      }
      return null;
    }

    // Check subscription status
    if (context.hasAnyMembership) {
      if (currentPath === '/onboarding') {
        logger.info('User has memberships, redirecting from onboarding to subscription');
        throw createRedirectResponse('/subscription');
      }

      if (currentPath === '/subscription') {
        return null;
      }

      // Check tenant subscription
      if (protectionConfig.tenantChecker && protectionConfig.subscriptionChecker) {
        let currentTenant = await protectionConfig.tenantChecker.getCurrentTenant(request);

        if (!currentTenant) {
          const initResult = await protectionConfig.tenantChecker.initializeTenant(request);
          if (initResult) {
            currentTenant = initResult.tenantId;
          }
        }

        if (currentTenant) {
          const hasSubscription = await protectionConfig.subscriptionChecker.checkTenantSubscriptionStatus(
            request,
            currentTenant
          );

          if (!hasSubscription) {
            logger.info('Tenant has no subscription, redirecting to subscription');
            throw createRedirectResponse('/subscription');
          }
        } else {
          logger.info('Could not initialize tenant, redirecting to subscription');
          throw createRedirectResponse('/subscription');
        }
      }
    }

    return null;
  } catch (error) {
    if (error instanceof Response && error.status >= 300 && error.status < 400) {
      throw error;
    }

    logger.error('Error checking user status', error instanceof Error ? error : undefined);

    if (currentPath !== '/onboarding') {
      throw createRedirectResponse('/onboarding');
    }

    return null;
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
      try {
        await autoRefreshTokens(request);
        const user = await requireAuth(request);
        const handledByConfig = await applyConfiguredRouteResolution(request, user, url.pathname, 'auth');
        if (!handledByConfig) {
          await checkUserStatus(request, user, url.pathname);
        }
        return loaderFn(user);
      } catch (error) {
        if (error instanceof Response && error.status >= 300 && error.status < 400) {
          throw error;
        }
        throw await login(request, getLoginReturnUrl(request, url.pathname, 'auth'));
      }

    case 'onboarding-required':
      try {
        await autoRefreshTokens(request);
        const user = await requireAuth(request);

        const handledByConfig = await applyConfiguredRouteResolution(
          request,
          user,
          url.pathname,
          'onboarding-required'
        );
        if (!handledByConfig && protectionConfig.identityChecker) {
          const context = await protectionConfig.identityChecker.getIdentityContext(request, user.sub);
          if (context.hasAnyMembership) {
            throw createRedirectResponse('/subscription');
          }
        }

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

        const handledByConfig = await applyConfiguredRouteResolution(
          request,
          user,
          url.pathname,
          'subscription-required'
        );
        if (!handledByConfig && protectionConfig.identityChecker) {
          const context = await protectionConfig.identityChecker.getIdentityContext(request, user.sub);
          if (!context.hasAnyMembership) {
            throw createRedirectResponse('/onboarding');
          }
        }

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
 * Onboarding route
 */
export const onboardingRoute = <T>(
  request: Request,
  loaderFn: (user: UserInfo) => Promise<T> | T
) => protectRoute(request, 'onboarding-required', loaderFn as (user?: UserInfo) => Promise<T> | T);

/**
 * Subscription route
 */
export const subscriptionRoute = <T>(
  request: Request,
  loaderFn: (user: UserInfo) => Promise<T> | T
) => protectRoute(request, 'subscription-required', loaderFn as (user?: UserInfo) => Promise<T> | T);
