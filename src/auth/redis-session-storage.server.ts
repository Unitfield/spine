/**
 * Redis Session Storage Server Module
 *
 * Redis-backed session storage for authentication.
 * Provides secure session management with automatic expiration,
 * without depending on a framework-specific session implementation.
 */

import Redis from 'ioredis';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SessionData, OAuthState } from './types';
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

const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || '';

const REDIS_KEYS = {
  oauthState: (stateId: string) => `${KEY_PREFIX}oauth:state:${stateId}`,
  session: (sessionId: string) => `${KEY_PREFIX}session:${sessionId}`,
};

const OAUTH_STATE_TTL = 10 * 60;
const SESSION_TTL = 60 * 60 * 24 * 7;

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || '__session_id';
const SESSION_SECRET = process.env.SESSION_SECRET || 'default-secret-change-in-production';
const SESSION_COOKIE_SECURE = process.env.NODE_ENV === 'production';
const SESSION_COOKIE_PATH = '/';
const SESSION_COOKIE_SAME_SITE = 'Lax';

export const AUTH_ERROR_COOKIE_PREFIX = SESSION_COOKIE_NAME.replace('_session', '').replace('__', '');

type SessionCookieOptions = {
  maxAge: number;
};

function parseCookieHeader(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookies, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex <= 0) {
        return cookies;
      }

      const name = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      if (!name) {
        return cookies;
      }

      cookies[name] = value;
      return cookies;
    }, {});
}

function createCookieSignature(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safelyCompareValues(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function signSessionId(sessionId: string): string {
  const signature = createCookieSignature(sessionId, SESSION_SECRET);
  return `${sessionId}.${signature}`;
}

function unsignSessionId(cookieValue: string | undefined): string | null {
  if (!cookieValue) {
    return null;
  }

  let decodedValue: string;
  try {
    decodedValue = decodeURIComponent(cookieValue);
  } catch {
    return null;
  }

  const separatorIndex = decodedValue.lastIndexOf('.');
  if (separatorIndex <= 0 || separatorIndex === decodedValue.length - 1) {
    return null;
  }

  const sessionId = decodedValue.slice(0, separatorIndex);
  const signature = decodedValue.slice(separatorIndex + 1);
  const expectedSignature = createCookieSignature(sessionId, SESSION_SECRET);

  return safelyCompareValues(signature, expectedSignature) ? sessionId : null;
}

function serializeSessionCookieValue(sessionId: string, options: SessionCookieOptions): string {
  const signedValue = encodeURIComponent(signSessionId(sessionId));
  const segments = [
    `${SESSION_COOKIE_NAME}=${signedValue}`,
    `Max-Age=${options.maxAge}`,
    `Path=${SESSION_COOKIE_PATH}`,
    `SameSite=${SESSION_COOKIE_SAME_SITE}`,
    'HttpOnly',
  ];

  if (SESSION_COOKIE_SECURE) {
    segments.push('Secure');
  }

  return segments.join('; ');
}

function serializeExpiredSessionCookie(): string {
  const segments = [
    `${SESSION_COOKIE_NAME}=`,
    'Max-Age=0',
    `Path=${SESSION_COOKIE_PATH}`,
    `SameSite=${SESSION_COOKIE_SAME_SITE}`,
    'HttpOnly',
  ];

  if (SESSION_COOKIE_SECURE) {
    segments.push('Secure');
  }

  return segments.join('; ');
}

async function getSessionIdFromRequest(request: Request): Promise<string | null> {
  const cookies = parseCookieHeader(request.headers.get('Cookie'));
  return unsignSessionId(cookies[SESSION_COOKIE_NAME]);
}

async function readSessionData(sessionId: string): Promise<SessionData | null> {
  try {
    const sessionData = await getRedis().get(REDIS_KEYS.session(sessionId));
    if (!sessionData) {
      logger.debug('Session not found in Redis', { sessionId });
      return null;
    }

    await getRedis().expire(REDIS_KEYS.session(sessionId), SESSION_TTL);
    return JSON.parse(sessionData) as SessionData;
  } catch (error) {
    logger.error('Failed to read session from Redis', error instanceof Error ? error : undefined);
    return null;
  }
}

async function writeSessionData(sessionId: string, data: SessionData): Promise<void> {
  try {
    const sessionData = JSON.stringify(data);
    await getRedis().setex(REDIS_KEYS.session(sessionId), SESSION_TTL, sessionData);
    logger.debug('Updated Redis session', { sessionId });
  } catch (error) {
    logger.error('Failed to update session in Redis', error instanceof Error ? error : undefined);
    throw error;
  }
}

async function deleteSessionData(sessionId: string): Promise<void> {
  try {
    await getRedis().del(REDIS_KEYS.session(sessionId));
    logger.debug('Deleted Redis session', { sessionId });
  } catch (error) {
    logger.error('Failed to delete session from Redis', error instanceof Error ? error : undefined);
  }
}

function mergeSessionData(existingData: SessionData, updates: Partial<SessionData>): SessionData {
  const nextData = { ...existingData } as Record<string, unknown>;

  Object.entries(updates).forEach(([key, value]) => {
    if (value === undefined) {
      delete nextData[key];
      return;
    }

    nextData[key] = value;
  });

  return nextData as SessionData;
}

// ============================================================================
// Session Helper Functions
// ============================================================================

export async function createAuthSession(
  request: Request,
  sessionData: Partial<SessionData>
): Promise<Headers> {
  const currentSessionId = await getSessionIdFromRequest(request);
  const currentSessionData = currentSessionId
    ? (await readSessionData(currentSessionId)) ?? {}
    : {};
  const nextSessionId = currentSessionId ?? crypto.randomUUID();
  const nextSessionData = mergeSessionData(currentSessionData, sessionData);

  logger.debug('Creating auth session', { dataKeys: Object.keys(sessionData) });

  await writeSessionData(nextSessionId, nextSessionData);

  return new Headers({
    'Set-Cookie': serializeSessionCookieValue(nextSessionId, { maxAge: SESSION_TTL }),
  });
}

export async function getAuthSession(request: Request): Promise<SessionData> {
  const sessionId = await getSessionIdFromRequest(request);
  if (!sessionId) {
    return {};
  }

  const session = await readSessionData(sessionId);
  if (!session) {
    return {};
  }

  return {
    userId: session.userId,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    idToken: session.idToken,
    expiresAt: session.expiresAt,
    user: session.user,
    lastActivity: session.lastActivity,
  };
}

export async function updateAuthSession(
  request: Request,
  updates: Partial<SessionData>
): Promise<Headers> {
  const currentSessionId = await getSessionIdFromRequest(request);
  const currentSessionData = currentSessionId
    ? (await readSessionData(currentSessionId)) ?? {}
    : {};
  const nextSessionId = currentSessionId ?? crypto.randomUUID();
  const nextSessionData = mergeSessionData(currentSessionData, updates);

  await writeSessionData(nextSessionId, nextSessionData);

  return new Headers({
    'Set-Cookie': serializeSessionCookieValue(nextSessionId, { maxAge: SESSION_TTL }),
  });
}

export async function destroyAuthSession(request: Request): Promise<Headers> {
  const sessionId = await getSessionIdFromRequest(request);
  if (sessionId) {
    await deleteSessionData(sessionId);
  }

  return new Headers({
    'Set-Cookie': serializeExpiredSessionCookie(),
  });
}

export async function requireAuthSession(request: Request): Promise<SessionData> {
  const sessionData = await getAuthSession(request);

  if (!sessionData.userId || !sessionData.accessToken) {
    throw new Response('Unauthorized', { status: 401 });
  }

  return sessionData;
}

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

export async function createOAuthState(state: OAuthState): Promise<string> {
  const stateId = crypto.randomUUID();
  const key = REDIS_KEYS.oauthState(stateId);

  await getRedis().setex(key, OAUTH_STATE_TTL, JSON.stringify(state));

  logger.debug('OAuth state created', { stateId, ttl: OAUTH_STATE_TTL });

  return stateId;
}

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

export async function deleteOAuthState(stateId: string): Promise<void> {
  const key = REDIS_KEYS.oauthState(stateId);
  await getRedis().del(key);
  logger.debug('OAuth state deleted', { stateId });
}

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

export async function closeRedisConnection(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    logger.info('Redis connection closed');
  }
}
