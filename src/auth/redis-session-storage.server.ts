/**
 * Redis Session Storage Server Module
 *
 * Redis-backed session storage for authentication.
 * Provides secure session management with automatic expiration,
 * without depending on a framework-specific session implementation.
 */

import Redis from 'ioredis';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthSessionSummary, SessionData, OAuthState } from './types';
import { OAUTH_STATE_TTL_SECONDS } from './oauth-state-config';
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
  sessionByUser: (userId: string) => `${KEY_PREFIX}session:index:user:${userId}`,
  sessionBySid: (sid: string) => `${KEY_PREFIX}session:index:sid:${sid}`,
  sessionBySessionState: (sessionState: string) => `${KEY_PREFIX}session:index:session_state:${sessionState}`,
};

const DEFAULT_SESSION_SECRET = 'default-secret-change-in-production';
const DEFAULT_SESSION_TTL = 60 * 60 * 24 * 7;

const SESSION_TTL = resolvePositiveIntegerEnv('SESSION_DEFAULT_TTL', resolvePositiveIntegerEnv('SESSION_TTL', DEFAULT_SESSION_TTL));

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || '__session_id';
const SESSION_SECRET = resolveSessionSecret();
const SESSION_COOKIE_SECURE = resolveCookieSecure();
const SESSION_COOKIE_PATH = '/';
const SESSION_COOKIE_SAME_SITE = resolveCookieSameSite();
const SESSION_COOKIE_DOMAIN = process.env.SESSION_COOKIE_DOMAIN?.trim();
const SESSION_ENCRYPTION_ENABLED = resolveSessionEncryptionEnabled();
const SESSION_ENCRYPTION_KEY = resolveSessionEncryptionKey(SESSION_ENCRYPTION_ENABLED);

export const AUTH_ERROR_COOKIE_PREFIX = SESSION_COOKIE_NAME.replace('_session', '').replace('__', '');

function resolveBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }

  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }

  throw new Error(`${name} must be a boolean value.`);
}

function resolvePositiveIntegerEnv(name: string, defaultValue: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function resolveSessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret === DEFAULT_SESSION_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET must be set to a unique random value in production.');
    }

    return DEFAULT_SESSION_SECRET;
  }

  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters long.');
  }

  return secret;
}

function resolveCookieSecure(): boolean {
  return resolveBooleanEnv('SESSION_COOKIE_SECURE', process.env.NODE_ENV === 'production');
}

function resolveCookieSameSite(): 'Lax' | 'Strict' | 'None' {
  const value = process.env.SESSION_COOKIE_SAME_SITE?.trim().toLowerCase();
  const sameSite = value === 'strict' ? 'Strict' : value === 'none' ? 'None' : 'Lax';

  if (sameSite === 'None' && !SESSION_COOKIE_SECURE) {
    throw new Error('SESSION_COOKIE_SAME_SITE=None requires SESSION_COOKIE_SECURE=true.');
  }

  return sameSite;
}

function resolveSessionEncryptionEnabled(): boolean {
  const enabled = resolveBooleanEnv('SESSION_ENCRYPTION', process.env.NODE_ENV === 'production');
  if (process.env.NODE_ENV === 'production' && !enabled) {
    throw new Error('SESSION_ENCRYPTION cannot be disabled in production.');
  }

  return enabled;
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function resolveSessionEncryptionKey(enabled: boolean): Buffer | null {
  if (!enabled) {
    return null;
  }

  const value = process.env.SESSION_ENCRYPTION_KEY?.trim();
  if (!value) {
    throw new Error('SESSION_ENCRYPTION_KEY is required when session encryption is enabled.');
  }

  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : decodeBase64Url(value);

  if (key.length !== 32) {
    throw new Error('SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes. Generate one with: openssl rand -base64 32');
  }

  return key;
}

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

  if (SESSION_COOKIE_DOMAIN) {
    segments.push(`Domain=${SESSION_COOKIE_DOMAIN}`);
  }

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

  if (SESSION_COOKIE_DOMAIN) {
    segments.push(`Domain=${SESSION_COOKIE_DOMAIN}`);
  }

  if (SESSION_COOKIE_SECURE) {
    segments.push('Secure');
  }

  return segments.join('; ');
}

async function getSessionIdFromRequest(request: Request): Promise<string | null> {
  const cookies = parseCookieHeader(request.headers.get('Cookie'));
  return unsignSessionId(cookies[SESSION_COOKIE_NAME]);
}

function getSessionIndexKeys(data: SessionData): string[] {
  const keys = new Set<string>();

  if (data.userId) {
    keys.add(REDIS_KEYS.sessionByUser(data.userId));
  }

  if (data.sid) {
    keys.add(REDIS_KEYS.sessionBySid(data.sid));
  }

  if (data.sessionState) {
    keys.add(REDIS_KEYS.sessionBySessionState(data.sessionState));
  }

  return Array.from(keys);
}

async function registerSessionIndexes(sessionId: string, data: SessionData): Promise<void> {
  const indexKeys = getSessionIndexKeys(data);
  if (indexKeys.length === 0) {
    return;
  }

  const redisClient = getRedis();
  const pipeline = redisClient.pipeline();

  for (const indexKey of indexKeys) {
    pipeline.sadd(indexKey, sessionId);
    pipeline.expire(indexKey, SESSION_TTL);
  }

  await pipeline.exec();
}

async function unregisterSessionIndexes(sessionId: string, data: SessionData): Promise<void> {
  const indexKeys = getSessionIndexKeys(data);
  if (indexKeys.length === 0) {
    return;
  }

  const redisClient = getRedis();
  const pipeline = redisClient.pipeline();

  for (const indexKey of indexKeys) {
    pipeline.srem(indexKey, sessionId);
  }

  await pipeline.exec();
}

function parseSessionData(sessionData: string | null): SessionData | null {
  if (!sessionData) {
    return null;
  }

  try {
    return JSON.parse(decodeSessionData(sessionData)) as SessionData;
  } catch (error) {
    logger.error('Failed to parse session data', error instanceof Error ? error : undefined);
    return null;
  }
}

function encodeSessionData(data: SessionData): string {
  const plaintext = JSON.stringify(data);
  if (!SESSION_ENCRYPTION_KEY) {
    return plaintext;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', SESSION_ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    'enc:v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

function decodeSessionData(value: string): string {
  if (!value.startsWith('enc:v1:')) {
    if (SESSION_ENCRYPTION_ENABLED) {
      logger.warn('Reading legacy plaintext auth session payload while session encryption is enabled.');
    }

    return value;
  }

  if (!SESSION_ENCRYPTION_KEY) {
    throw new Error('Cannot decrypt auth session payload because SESSION_ENCRYPTION_KEY is not configured.');
  }

  const [, version, ivValue, tagValue, ciphertextValue] = value.split(':');
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('Invalid encrypted auth session payload format.');
  }

  const decipher = createDecipheriv('aes-256-gcm', SESSION_ENCRYPTION_KEY, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

async function readSessionData(sessionId: string): Promise<SessionData | null> {
  try {
    const sessionData = await getRedis().get(REDIS_KEYS.session(sessionId));
    if (!sessionData) {
      logger.debug('Session not found in Redis', { sessionId });
      return null;
    }

    await getRedis().expire(REDIS_KEYS.session(sessionId), SESSION_TTL);
    return parseSessionData(sessionData);
  } catch (error) {
    logger.error('Failed to read session from Redis', error instanceof Error ? error : undefined);
    return null;
  }
}

async function writeSessionData(sessionId: string, data: SessionData): Promise<void> {
  try {
    const existingSessionData = parseSessionData(await getRedis().get(REDIS_KEYS.session(sessionId)));
    if (existingSessionData) {
      await unregisterSessionIndexes(sessionId, existingSessionData);
    }

    await getRedis().setex(REDIS_KEYS.session(sessionId), SESSION_TTL, encodeSessionData(data));
    await registerSessionIndexes(sessionId, data);
    logger.debug('Updated Redis session', { sessionId });
  } catch (error) {
    logger.error('Failed to update session in Redis', error instanceof Error ? error : undefined);
    throw error;
  }
}

async function deleteSessionData(sessionId: string): Promise<void> {
  try {
    const existingSessionData = parseSessionData(await getRedis().get(REDIS_KEYS.session(sessionId)));
    if (existingSessionData) {
      await unregisterSessionIndexes(sessionId, existingSessionData);
    }

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

async function getSessionIdsFromIndex(indexKey: string): Promise<string[]> {
  const sessionIds = await getRedis().smembers(indexKey);
  const activeSessionIds: string[] = [];
  const staleSessionIds: string[] = [];

  for (const sessionId of sessionIds) {
    const exists = await getRedis().exists(REDIS_KEYS.session(sessionId));
    if (exists) {
      activeSessionIds.push(sessionId);
    } else {
      staleSessionIds.push(sessionId);
    }
  }

  if (staleSessionIds.length > 0) {
    await getRedis().srem(indexKey, ...staleSessionIds);
  }

  return activeSessionIds;
}

function toAuthSessionSummary(
  sessionId: string,
  session: SessionData,
  currentSessionId?: string | null
): AuthSessionSummary {
  return {
    sessionId,
    userId: session.userId,
    email: session.user?.email,
    name: session.user?.name,
    issuer: session.issuer,
    sid: session.sid,
    sessionState: session.sessionState,
    clientId: session.clientId,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    expiresAt: session.expiresAt,
    isCurrent: currentSessionId ? sessionId === currentSessionId : undefined,
  };
}

async function listSessionDataByIds(sessionIds: string[]): Promise<Array<{ sessionId: string; data: SessionData }>> {
  const sessions: Array<{ sessionId: string; data: SessionData }> = [];

  for (const sessionId of sessionIds) {
    const data = await readSessionData(sessionId);
    if (data) {
      sessions.push({ sessionId, data });
    }
  }

  return sessions;
}

function getRequestIpAddress(request: Request): string | undefined {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (
    forwardedFor ||
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    undefined
  );
}

// ============================================================================
// Session Helper Functions
// ============================================================================

export async function createAuthSession(
  request: Request,
  sessionData: Partial<SessionData>
): Promise<Headers> {
  const currentSessionId = await getSessionIdFromRequest(request);
  const nextSessionId = crypto.randomUUID();
  const nextSessionData = mergeSessionData({}, {
    ...sessionData,
    sessionId: nextSessionId,
    ipAddress: sessionData.ipAddress ?? getRequestIpAddress(request),
    userAgent: sessionData.userAgent ?? request.headers.get('user-agent') ?? undefined,
  });

  logger.debug('Creating auth session', { dataKeys: Object.keys(sessionData) });

  if (currentSessionId) {
    await deleteSessionData(currentSessionId);
  }

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
    sessionId,
    userId: session.userId,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    idToken: session.idToken,
    expiresAt: session.expiresAt,
    issuer: session.issuer,
    sid: session.sid,
    sessionState: session.sessionState,
    clientId: session.clientId,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    user: session.user,
    createdAt: session.createdAt,
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
  const nextSessionData = mergeSessionData(currentSessionData, {
    ...updates,
    sessionId: nextSessionId,
  });

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

export async function getCurrentAuthSessionId(request: Request): Promise<string | null> {
  return await getSessionIdFromRequest(request);
}

export async function getAuthSessionById(sessionId: string): Promise<SessionData | null> {
  const session = await readSessionData(sessionId);
  return session ? { ...session, sessionId } : null;
}

export async function listAuthSessionDataForUser(
  userId: string
): Promise<Array<{ sessionId: string; data: SessionData }>> {
  const sessionIds = await getSessionIdsFromIndex(REDIS_KEYS.sessionByUser(userId));
  return await listSessionDataByIds(sessionIds);
}

export async function listAuthSessionsForUser(
  userId: string,
  currentSessionId?: string | null
): Promise<AuthSessionSummary[]> {
  const sessions = await listAuthSessionDataForUser(userId);

  return sessions
    .map(({ sessionId, data }) => toAuthSessionSummary(sessionId, data, currentSessionId))
    .sort((left, right) => (right.lastActivity ?? right.createdAt ?? 0) - (left.lastActivity ?? left.createdAt ?? 0));
}

export async function listCurrentUserAuthSessions(request: Request): Promise<AuthSessionSummary[]> {
  const currentSession = await getAuthSession(request);
  if (!currentSession.userId) {
    return [];
  }

  return await listAuthSessionsForUser(currentSession.userId, currentSession.sessionId);
}

export async function destroyAuthSessionById(sessionId: string): Promise<boolean> {
  const session = await readSessionData(sessionId);
  if (!session) {
    return false;
  }

  await deleteSessionData(sessionId);
  return true;
}

export async function destroyAuthSessionsForUser(userId: string): Promise<number> {
  const sessionIds = await getSessionIdsFromIndex(REDIS_KEYS.sessionByUser(userId));
  let destroyedSessions = 0;

  for (const sessionId of sessionIds) {
    if (await destroyAuthSessionById(sessionId)) {
      destroyedSessions += 1;
    }
  }

  return destroyedSessions;
}

export async function destroyAuthSessionsBySid(sid: string): Promise<number> {
  const sessionIds = await getSessionIdsFromIndex(REDIS_KEYS.sessionBySid(sid));
  let destroyedSessions = 0;

  for (const sessionId of sessionIds) {
    if (await destroyAuthSessionById(sessionId)) {
      destroyedSessions += 1;
    }
  }

  return destroyedSessions;
}

export async function destroyAuthSessionsBySessionState(sessionState: string): Promise<number> {
  const sessionIds = await getSessionIdsFromIndex(REDIS_KEYS.sessionBySessionState(sessionState));
  let destroyedSessions = 0;

  for (const sessionId of sessionIds) {
    if (await destroyAuthSessionById(sessionId)) {
      destroyedSessions += 1;
    }
  }

  return destroyedSessions;
}

export async function destroyAuthSessionsByIdentitySession(params: {
  sid?: string;
  sessionState?: string;
  userId?: string;
}): Promise<number> {
  if (params.sid) {
    return await destroyAuthSessionsBySid(params.sid);
  }

  if (params.sessionState) {
    return await destroyAuthSessionsBySessionState(params.sessionState);
  }

  if (params.userId) {
    return await destroyAuthSessionsForUser(params.userId);
  }

  return 0;
}

export async function requireAuthSession(request: Request): Promise<SessionData> {
  const sessionData = await getAuthSession(request);

  if (!sessionData.userId || !sessionData.user || !sessionData.accessToken || isSessionDataExpired(sessionData)) {
    throw new Response('Unauthorized', { status: 401 });
  }

  return sessionData;
}

function getJwtExpiry(accessToken: string | undefined): number | null {
  if (!accessToken) {
    return null;
  }

  try {
    const [, encodedPayload] = accessToken.split('.');
    if (!encodedPayload) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as { exp?: unknown };

    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

function isSessionDataExpired(sessionData: SessionData): boolean {
  const now = Date.now();
  if (
    typeof sessionData.expiresAt === 'number' &&
    (!Number.isFinite(sessionData.expiresAt) || now >= sessionData.expiresAt)
  ) {
    return true;
  }

  const jwtExpiry = getJwtExpiry(sessionData.accessToken);
  return jwtExpiry !== null && now >= jwtExpiry;
}

export async function isSessionValid(request: Request): Promise<boolean> {
  try {
    const sessionData = await getAuthSession(request);

    if (!sessionData.user || !sessionData.accessToken || isSessionDataExpired(sessionData)) {
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

  await getRedis().setex(key, OAUTH_STATE_TTL_SECONDS, JSON.stringify(state));

  logger.debug('OAuth state created', { hasStateId: true, ttl: OAUTH_STATE_TTL_SECONDS });

  return stateId;
}

export async function getOAuthState(
  stateId: string,
  options?: { readonly throwOnMalformed?: boolean },
): Promise<OAuthState | null> {
  const key = REDIS_KEYS.oauthState(stateId);
  const data = await getRedis().get(key);

  if (!data) {
    logger.warn('OAuth state not found or expired', { hasStateId: true });
    return null;
  }

  try {
    return JSON.parse(data);
  } catch (error) {
    logger.error('Failed to parse OAuth state', undefined, {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    if (options?.throwOnMalformed) {
      throw new Error('OAuth state storage failure');
    }
    return null;
  }
}

export async function deleteOAuthState(stateId: string): Promise<void> {
  const key = REDIS_KEYS.oauthState(stateId);
  await getRedis().del(key);
  logger.debug('OAuth state deleted', { hasStateId: true });
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
