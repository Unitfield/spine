/**
 * Route Protection Server Module
 * 
 * Provides route protection utilities for different authentication levels.
 */

import { redirect } from 'react-router';
import { getUser, requireAuth, refreshTokens, login } from './auth.server';
import { getAuthSession } from './redis-session-storage.server';
import type { ProtectionLevel, UserInfo } from './types';
import { logger } from '../logging';

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
        // Use client_id_only=true for automatic logout (app-specific)
        const logoutUrl = new URL(request.url);
        logoutUrl.pathname = '/auth/logout';
        logoutUrl.searchParams.set('client_id_only', 'true');
        const logoutRequest = new Request(logoutUrl.toString(), {
          headers: request.headers,
        });
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
          // Use client_id_only=true for automatic logout (app-specific)
          const logoutUrl = new URL(request.url);
          logoutUrl.pathname = '/auth/logout';
          logoutUrl.searchParams.set('client_id_only', 'true');
          const logoutRequest = new Request(logoutUrl.toString(), {
            headers: request.headers,
          });
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
export interface IdentityContextChecker {
  getIdentityContext: (request: Request, userId: string, forceRefresh?: boolean) => Promise<{
    hasAnyMembership: boolean;
    hasSubscription: boolean;
    isOnboarded: boolean;
  }>;
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

/**
 * Route protection configuration
 */
export interface RouteProtectionConfig {
  identityChecker?: IdentityContextChecker;
  tenantChecker?: TenantChecker;
  subscriptionChecker?: SubscriptionChecker;
}

let protectionConfig: RouteProtectionConfig = {};

/**
 * Configure route protection with identity/tenant/subscription checkers
 */
export function configureRouteProtection(config: RouteProtectionConfig): void {
  protectionConfig = config;
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
        throw redirect('/onboarding');
      }
      return null;
    }

    // Check subscription status
    if (context.hasAnyMembership) {
      if (currentPath === '/onboarding') {
        logger.info('User has memberships, redirecting from onboarding to subscription');
        throw redirect('/subscription');
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
            throw redirect('/subscription');
          }
        } else {
          logger.info('Could not initialize tenant, redirecting to subscription');
          throw redirect('/subscription');
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
      throw redirect('/onboarding');
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
        await checkUserStatus(request, user, url.pathname);
        return loaderFn(user);
      } catch (error) {
        if (error instanceof Response && error.status >= 300 && error.status < 400) {
          throw error;
        }
        const returnUrl = url.pathname === '/' ? '/' : `${url.pathname}${url.search}`;
        throw await login(request, returnUrl);
      }

    case 'onboarding-required':
      try {
        await autoRefreshTokens(request);
        const user = await requireAuth(request);

        if (protectionConfig.identityChecker) {
          const context = await protectionConfig.identityChecker.getIdentityContext(request, user.sub);
          if (context.hasAnyMembership) {
            throw redirect('/subscription');
          }
        }

        return loaderFn(user);
      } catch (error) {
        if (error instanceof Response && error.status >= 300 && error.status < 400) {
          throw error;
        }
        throw await login(request, '/onboarding');
      }

    case 'subscription-required':
      try {
        await autoRefreshTokens(request);
        const user = await requireAuth(request);

        if (protectionConfig.identityChecker) {
          const context = await protectionConfig.identityChecker.getIdentityContext(request, user.sub);
          if (!context.hasAnyMembership) {
            throw redirect('/onboarding');
          }
        }

        // Initialize tenant if needed
        if (protectionConfig.tenantChecker) {
          let currentTenant = await protectionConfig.tenantChecker.getCurrentTenant(request);
          if (!currentTenant) {
            await protectionConfig.tenantChecker.initializeTenant(request);
          }
        }

        return loaderFn(user);
      } catch (error) {
        if (error instanceof Response && error.status >= 300 && error.status < 400) {
          throw error;
        }
        throw await login(request, '/subscription');
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
