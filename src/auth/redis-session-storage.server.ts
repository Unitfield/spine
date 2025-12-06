/**
 * Redis Session Storage Server Module
 * 
 * Redis-backed session storage for authentication.
 * Provides secure session management with automatic expiration.
 */

import { createSessionStorage } from 'react-router';
import Redis from 'ioredis';
import type { SessionData, SessionFlashData, OAuthState } from './types';
import { logger } from '../logging';

// ============================================================================
// Redis Client Setup
// ============================================================================

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

    redis.on('error', (err) => {
      logger.error('Redis Client Error', err);
    });

    redis.on('connect', () => {
      logger.info('Redis connected successfully');
    });
  }
  return redis;
}

// ============================================================================
// Redis Key Patterns
// ============================================================================

// Prefix for Redis keys - allows multiple apps to share the same Redis instance
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || '';

const REDIS_KEYS = {
  oauthState: (stateId: string) => `${KEY_PREFIX}oauth:state:${stateId}`,
  session: (sessionId: string) => `${KEY_PREFIX}session:${sessionId}`,
};

// TTL constants
const OAUTH_STATE_TTL = 10 * 60; // 10 minutes in seconds
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days in seconds

// Session cookie name - MUST be unique per application to prevent session conflicts
// When multiple apps run on the same domain (e.g., localhost), they will overwrite each other's
// session cookies if they use the same cookie name
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || '__session_id';

// Auth error cookie prefix - derived from session cookie name to prevent conflicts
// between multiple apps on the same domain
export const AUTH_ERROR_COOKIE_PREFIX = SESSION_COOKIE_NAME.replace('_session', '').replace('__', '');

// ============================================================================
// Session Storage
// ============================================================================

function createRedisSessionStorage() {
  return createSessionStorage<SessionData, SessionFlashData>({
    cookie: {
      name: SESSION_COOKIE_NAME,
      httpOnly: true,
      maxAge: SESSION_TTL,
      path: '/',
      sameSite: 'lax',
      secrets: [process.env.SESSION_SECRET || 'default-secret-change-in-production'],
      secure: process.env.NODE_ENV === 'production',
    },
    async createData(data) {
      const sessionId = crypto.randomUUID();
      const sessionData = JSON.stringify(data);
      await getRedis().setex(REDIS_KEYS.session(sessionId), SESSION_TTL, sessionData);
      logger.debug('Created Redis session', { sessionId, dataKeys: Object.keys(data) });
      return sessionId;
    },
    async readData(sessionId) {
      try {
        const sessionData = await getRedis().get(REDIS_KEYS.session(sessionId));
        if (!sessionData) {
          logger.debug('Session not found in Redis', { sessionId });
          return null;
        }
        // Extend TTL on read
        await getRedis().expire(REDIS_KEYS.session(sessionId), SESSION_TTL);
        return JSON.parse(sessionData);
      } catch (error) {
        logger.error('Failed to read session from Redis', error instanceof Error ? error : undefined);
        return null;
      }
    },
    async updateData(sessionId, data) {
      try {
        const sessionData = JSON.stringify(data);
        await getRedis().setex(REDIS_KEYS.session(sessionId), SESSION_TTL, sessionData);
        logger.debug('Updated Redis session', { sessionId });
      } catch (error) {
        logger.error('Failed to update session in Redis', error instanceof Error ? error : undefined);
        throw error;
      }
    },
    async deleteData(sessionId) {
      try {
        await getRedis().del(REDIS_KEYS.session(sessionId));
        logger.debug('Deleted Redis session', { sessionId });
      } catch (error) {
        logger.error('Failed to delete session from Redis', error instanceof Error ? error : undefined);
      }
    },
  });
}

let sessionStorage: ReturnType<typeof createRedisSessionStorage> | null = null;

function getSessionStorage() {
  if (!sessionStorage) {
    sessionStorage = createRedisSessionStorage();
  }
  return sessionStorage;
}

// ============================================================================
// Session Helper Functions
// ============================================================================

/**
 * Create a new auth session
 */
export async function createAuthSession(
  request: Request,
  sessionData: Partial<SessionData>
): Promise<Headers> {
  const { getSession, commitSession } = getSessionStorage();
  const session = await getSession(request.headers.get('Cookie'));

  logger.debug('Creating auth session', { dataKeys: Object.keys(sessionData) });

  Object.entries(sessionData).forEach(([key, value]) => {
    if (value !== undefined) {
      session.set(key as keyof SessionData, value);
    } else {
      session.unset(key as keyof SessionData);
    }
  });

  return new Headers({
    'Set-Cookie': await commitSession(session),
  });
}

/**
 * Get auth session data
 */
export async function getAuthSession(request: Request): Promise<SessionData> {
  const { getSession } = getSessionStorage();
  const session = await getSession(request.headers.get('Cookie'));

  return {
    userId: session.get('userId'),
    accessToken: session.get('accessToken'),
    refreshToken: session.get('refreshToken'),
    idToken: session.get('idToken'),
    expiresAt: session.get('expiresAt'),
    user: session.get('user'),
    lastActivity: session.get('lastActivity'),
  };
}

/**
 * Update auth session
 */
export async function updateAuthSession(
  request: Request,
  updates: Partial<SessionData>
): Promise<Headers> {
  const { getSession, commitSession } = getSessionStorage();
  const session = await getSession(request.headers.get('Cookie'));

  Object.entries(updates).forEach(([key, value]) => {
    if (value !== undefined) {
      session.set(key as keyof SessionData, value);
    } else {
      session.unset(key as keyof SessionData);
    }
  });

  return new Headers({
    'Set-Cookie': await commitSession(session),
  });
}

/**
 * Destroy auth session
 */
export async function destroyAuthSession(request: Request): Promise<Headers> {
  const { getSession, destroySession } = getSessionStorage();
  const session = await getSession(request.headers.get('Cookie'));

  return new Headers({
    'Set-Cookie': await destroySession(session),
  });
}

/**
 * Require auth session (throws 401 if not authenticated)
 */
export async function requireAuthSession(request: Request): Promise<SessionData> {
  const sessionData = await getAuthSession(request);

  if (!sessionData.userId || !sessionData.accessToken) {
    throw new Response('Unauthorized', { status: 401 });
  }

  return sessionData;
}

/**
 * Check if session is valid
 */
export async function isSessionValid(request: Request): Promise<boolean> {
  try {
    const sessionData = await getAuthSession(request);

    if (!sessionData.user || !sessionData.accessToken) {
      return false;
    }

    if (sessionData.expiresAt && Date.now() >= sessionData.expiresAt) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// OAuth State Management
// ============================================================================

/**
 * Create OAuth state in Redis
 */
export async function createOAuthState(state: OAuthState): Promise<string> {
  const stateId = crypto.randomUUID();
  const key = REDIS_KEYS.oauthState(stateId);

  await getRedis().setex(key, OAUTH_STATE_TTL, JSON.stringify(state));

  logger.debug('OAuth state created', { stateId, ttl: OAUTH_STATE_TTL });

  return stateId;
}

/**
 * Get OAuth state from Redis
 */
export async function getOAuthState(stateId: string): Promise<OAuthState | null> {
  const key = REDIS_KEYS.oauthState(stateId);
  const data = await getRedis().get(key);

  if (!data) {
    logger.warn('OAuth state not found or expired', { stateId });
    return null;
  }

  try {
    return JSON.parse(data);
  } catch (error) {
    logger.error('Failed to parse OAuth state', error instanceof Error ? error : undefined);
    return null;
  }
}

/**
 * Delete OAuth state from Redis
 */
export async function deleteOAuthState(stateId: string): Promise<void> {
  const key = REDIS_KEYS.oauthState(stateId);
  await getRedis().del(key);
  logger.debug('OAuth state deleted', { stateId });
}

/**
 * Cleanup expired OAuth states
 */
export async function cleanupExpiredOAuthStates(): Promise<number> {
  const pattern = REDIS_KEYS.oauthState('*');
  const keys = await getRedis().keys(pattern);

  let cleaned = 0;
  for (const key of keys) {
    const ttl = await getRedis().ttl(key);
    if (ttl === -1) {
      await getRedis().del(key);
      cleaned++;
    }
  }

  logger.info('OAuth state cleanup completed', { cleaned, total: keys.length });
  return cleaned;
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Close Redis connection (for graceful shutdown)
 */
export async function closeRedisConnection(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    logger.info('Redis connection closed');
  }
}
