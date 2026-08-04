/**
 * Token Refresh Server Module
 */

import { refreshTokens } from './auth.server';
import { getAuthSession } from './redis-session-storage.server';
import type { TokenRefreshResult } from './types';
import { logger } from '../logging';

/**
 * Attempt to refresh the access token
 */
export async function attemptTokenRefresh(request: Request): Promise<TokenRefreshResult> {
  try {
    logger.info('Attempting token refresh due to 401 response');

    const sessionData = await getAuthSession(request);

    if (!sessionData.refreshToken) {
      logger.warn('No refresh token available in session');
      return {
        success: false,
        error: 'No refresh token available',
        shouldLogout: true,
      };
    }

    const refreshResult = await refreshTokens(request, sessionData.refreshToken);

    if (!refreshResult.success) {
      logger.error('Token refresh failed', undefined, {
        error: refreshResult.error,
        shouldLogout: refreshResult.shouldLogout,
      });

      return {
        success: false,
        error: refreshResult.error,
        // A failed provider refresh must never leave the caller authorized by
        // the stale access token, even when the provider error was not marked
        // as a permanent logout condition.
        shouldLogout: true,
      };
    }

    const tokens = refreshResult.tokens;
    if (!tokens || !tokens.access_token) {
      logger.error('Token refresh succeeded but no access token returned');
      return {
        success: false,
        error: 'No access token in refresh response',
        shouldLogout: true,
      };
    }

    logger.info('Token refresh successful');

    return {
      success: true,
      newAccessToken: tokens.access_token,
    };
  } catch (error) {
    logger.error('Token refresh attempt failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldLogout: true,
    };
  }
}

/**
 * Check if a response indicates token expiration
 */
export function isTokenExpiredResponse(response: Response): boolean {
  return response.status === 401;
}

/**
 * Check if token refresh should be attempted
 */
export function shouldAttemptTokenRefresh(response: Response, hasAuth: boolean): boolean {
  return hasAuth && isTokenExpiredResponse(response);
}
