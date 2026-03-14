/**
 * Tenant Server Module
 * 
 * Server-side tenant management.
 */

import { getAuthSession } from '../auth/redis-session-storage.server';
import { getActiveTenant, setActiveTenant, clearActiveTenant } from './tenant-cookie.server';

/**
 * Identity context fetcher type (to avoid circular dependency)
 */
export type IdentityContextFetcher = (request: Request) => Promise<{
  memberships?: Array<{ tenantId: string }>;
} | null>;

let identityContextFetcher: IdentityContextFetcher | null = null;

/**
 * Configure identity context fetcher
 */
export function configureIdentityContextFetcher(fetcher: IdentityContextFetcher): void {
  identityContextFetcher = fetcher;
}

/**
 * Get current active tenant from cookie
 */
export async function getCurrentTenant(request: Request): Promise<string | null> {
  try {
    const tenantFromCookie = await getActiveTenant(request);
    if (tenantFromCookie) {
      return tenantFromCookie;
    }
    return null;
  } catch (error) {
    console.error('Error getting current tenant:', error);
    return null;
  }
}

/**
 * Get tenant from identity context
 */
export async function getTenantFromIdentityContext(request: Request): Promise<string | null> {
  try {
    const sessionData = await getAuthSession(request);
    if (!sessionData?.user?.sub) {
      return null;
    }

    if (!identityContextFetcher) {
      console.warn('Identity context fetcher not configured');
      return null;
    }

    const context = await identityContextFetcher(request);

    if (context?.memberships && context.memberships.length > 0) {
      return context.memberships[0].tenantId;
    }

    return null;
  } catch (error) {
    console.error('Error getting tenant from identity context:', error);
    return null;
  }
}

/**
 * Get available tenants from identity context
 */
export async function getAvailableTenants(request: Request): Promise<string[]> {
  try {
    const sessionData = await getAuthSession(request);
    if (!sessionData?.user?.sub) {
      return [];
    }

    if (!identityContextFetcher) {
      console.warn('Identity context fetcher not configured');
      return [];
    }

    const context = await identityContextFetcher(request);

    if (context?.memberships && context.memberships.length > 0) {
      return context.memberships.map((m) => m.tenantId);
    }

    return [];
  } catch (error) {
    console.error('Error getting available tenants:', error);
    return [];
  }
}

/**
 * Set current active tenant
 */
export async function setCurrentTenant(
  request: Request,
  tenantId: string
): Promise<{ headers: Headers; success: boolean; error?: string }> {
  try {
    const sessionData = await getAuthSession(request);

    if (!sessionData.user) {
      return { headers: new Headers(), success: false, error: 'No active session' };
    }

    const cookieValue = await setActiveTenant(tenantId);
    const headers = new Headers();
    headers.append('Set-Cookie', cookieValue);

    return { headers, success: true };
  } catch (error) {
    console.error('Failed to set current tenant:', error);
    return {
      headers: new Headers(),
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Initialize tenant on first login
 */
export async function initializeTenant(
  request: Request
): Promise<{ headers: Headers; tenantId: string } | null> {
  try {
    const sessionData = await getAuthSession(request);
    if (!sessionData?.user) {
      return null;
    }

    // Check if tenant is already set in cookie
    const currentTenant = await getCurrentTenant(request);
    if (currentTenant) {
      return null;
    }

    // Get tenant from identity context
    const tenantId = await getTenantFromIdentityContext(request);

    if (tenantId) {
      const cookieValue = await setActiveTenant(tenantId);
      const headers = new Headers();
      headers.append('Set-Cookie', cookieValue);
      return { headers, tenantId };
    }

    return null;
  } catch (error) {
    console.error('Failed to initialize tenant:', error);
    return null;
  }
}

/**
 * Clear current tenant
 */
export async function clearCurrentTenant(): Promise<Headers> {
  const cookieValue = await clearActiveTenant();
  const headers = new Headers();
  headers.append('Set-Cookie', cookieValue);
  return headers;
}
