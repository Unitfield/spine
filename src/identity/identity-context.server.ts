/**
 * Identity Context Server Module
 * 
 * Server-side identity context management.
 */

import type { AddressData, IdentityContextData, TenantMembership } from './types';
import { logger } from '../logging';

/**
 * Identity API fetcher type (to avoid coupling with specific API client)
 */
export type IdentityAPIFetcher = (request: Request) => Promise<IdentityContextData>;

let identityAPIFetcher: IdentityAPIFetcher | null = null;

/**
 * Configure identity API fetcher
 */
export function configureIdentityAPIFetcher(fetcher: IdentityAPIFetcher): void {
  identityAPIFetcher = fetcher;
}

// In-memory cache for identity context
const contextCache = new Map<
  string,
  {
    context: IdentityContextData;
    timestamp: number;
    version: number;
  }
>();

const CONTEXT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch identity context from backend
 */
export async function fetchIdentityContext(request: Request): Promise<IdentityContextData> {
  if (!identityAPIFetcher) {
    throw new Error('Identity API fetcher not configured. Call configureIdentityAPIFetcher first.');
  }

  try {
    logger.info('Fetching identity context');
    const context = await identityAPIFetcher(request);
    
    logger.debug('Identity context fetched', {
      hasAnyMembership: context.hasAnyMembership,
      hasSubscription: context.hasSubscription,
      isOnboarded: context.isOnboarded,
      membershipCount: context.memberships?.length || 0,
    });

    return context;
  } catch (error: unknown) {
    logger.error('Failed to fetch identity context', error instanceof Error ? error : undefined);

    // Check if this is a CurrentUserMissing error
    if (
      error &&
      typeof error === 'object' &&
      'response' in error &&
      (error as { response?: { status?: number; data?: { title?: string } } }).response?.status === 404 &&
      (error as { response?: { data?: { title?: string } } }).response?.data?.title === 'CurrentUserMissing'
    ) {
      logger.error('CurrentUserMissing error detected - session is invalid');
      const invalidSessionError = new Error('INVALID_SESSION');
      (invalidSessionError as Error & { isInvalidSession: boolean }).isInvalidSession = true;
      throw invalidSessionError;
    }

    throw error;
  }
}

/**
 * Get cached identity context or fetch fresh if needed
 */
export async function getIdentityContext(
  request: Request,
  userId: string,
  forceRefresh = false
): Promise<IdentityContextData> {
  const cacheKey = userId;
  const cached = contextCache.get(cacheKey);
  const now = Date.now();

  // Return cached if valid and not forcing refresh
  if (!forceRefresh && cached && now - cached.timestamp < CONTEXT_CACHE_TTL) {
    logger.debug('Using cached identity context for user', { userId });
    return cached.context;
  }

  // Fetch fresh context
  const context = await fetchIdentityContext(request);

  // Cache the result
  contextCache.set(cacheKey, {
    context,
    timestamp: now,
    version: context.contextVersion ?? 0,
  });

  logger.debug('Cached fresh identity context for user', { userId });
  return context;
}

/**
 * Clear identity context cache for user
 */
export function clearIdentityContextCache(userId?: string): void {
  if (userId) {
    contextCache.delete(userId);
    logger.debug('Cleared identity context cache for user', { userId });
  } else {
    contextCache.clear();
    logger.debug('Cleared all identity context cache');
  }
}

/**
 * Permission fetcher type
 */
export type PermissionFetcher = (request: Request, tenantId: string) => Promise<string[]>;

let permissionFetcher: PermissionFetcher | null = null;

/**
 * Configure permission fetcher
 */
export function configurePermissionFetcher(fetcher: PermissionFetcher): void {
  permissionFetcher = fetcher;
}

/**
 * Fetch user permissions for a specific tenant
 */
export async function fetchUserPermissions(request: Request, tenantId: string): Promise<string[]> {
  if (!tenantId) {
    logger.warn('No tenant ID provided, skipping permission fetch');
    return [];
  }

  if (!permissionFetcher) {
    throw new Error('Permission fetcher not configured. Call configurePermissionFetcher first.');
  }

  try {
    return await permissionFetcher(request, tenantId);
  } catch (error) {
    logger.error('Failed to fetch user permissions', error instanceof Error ? error : undefined);
    return [];
  }
}

export interface UserContextInfo {
  tenants: string[];
  memberships: TenantMembership[];
  currentTenant?: string;
  isOnboarded: boolean;
  permissions: string[];
  hasSubscription: boolean;
  userId?: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  profileImageUrl?: string | null;
  phoneNumber?: string | null;
  timeZone?: string;
  addresses?: AddressData[];
  hasOwnerMembership: boolean;
}

export interface ContextToUserInfoOptions {
  currentTenant?: string | null;
  request?: Request;
}

/**
 * Convert raw identity context into a tenant-aware user info shape.
 */
export async function contextToUserInfo(
  context: IdentityContextData,
  options: ContextToUserInfoOptions = {}
): Promise<UserContextInfo> {
  const memberships = context.memberships || [];
  const tenants = memberships.map((membership) => membership.tenantId);
  const resolvedCurrentTenant =
    options.currentTenant && tenants.includes(options.currentTenant)
      ? options.currentTenant
      : tenants[0] || undefined;

  let permissions: string[] = [];
  if (resolvedCurrentTenant && options.request) {
    permissions = await fetchUserPermissions(options.request, resolvedCurrentTenant);
  }

  return {
    tenants,
    memberships,
    currentTenant: resolvedCurrentTenant,
    isOnboarded: context.isOnboarded ?? false,
    permissions,
    hasSubscription: context.hasSubscription ?? false,
    userId: context.userId,
    email: context.email,
    firstName: context.firstName,
    lastName: context.lastName,
    displayName: context.displayName,
    profileImageUrl: context.profileImageUrl,
    phoneNumber: context.phoneNumber,
    timeZone: context.timeZone,
    addresses: context.addresses,
    hasOwnerMembership: context.hasOwnerMembership ?? false,
  };
}

/**
 * Check if a cached context version differs from the latest version.
 */
export function hasContextVersionChanged(userId: string, newVersion: number): boolean {
  const cached = contextCache.get(userId);
  return !cached || cached.version !== newVersion;
}

/**
 * Mark a cached identity context as stale after a version change.
 */
export function updateContextVersion(userId: string, newVersion: number): void {
  const cached = contextCache.get(userId);
  if (!cached) return;

  cached.version = newVersion;
  cached.timestamp = 0;
  logger.debug('Marked identity context as stale for user', {
    userId,
    version: newVersion,
  });
}
