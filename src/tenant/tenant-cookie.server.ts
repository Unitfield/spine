/**
 * Tenant Cookie Server Module
 * 
 * Cookie-based tenant storage.
 */

export type TenantCookieSameSite = 'Strict' | 'Lax' | 'None';

export interface TenantCookieConfig {
  name?: string;
  maxAge?: number;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: TenantCookieSameSite;
}

const DEFAULT_TENANT_COOKIE_CONFIG: Required<TenantCookieConfig> = {
  name: '__active-org',
  maxAge: 60 * 60 * 24 * 365,
  path: '/',
  secure: process.env.NODE_ENV === 'production',
  httpOnly: false,
  sameSite: 'Lax',
};

let tenantCookieConfig: Required<TenantCookieConfig> = {
  ...DEFAULT_TENANT_COOKIE_CONFIG,
};

function getTenantCookieConfig(): Required<TenantCookieConfig> {
  return tenantCookieConfig;
}

/**
 * Get active tenant from cookie
 */
export async function getActiveTenant(request: Request): Promise<string | null> {
  const config = getTenantCookieConfig();
  const cookies = request.headers.get('Cookie');
  if (!cookies) return null;

  const match = cookies.match(new RegExp(`${config.name}=([^;]+)`));
  if (!match) return null;

  return decodeURIComponent(match[1]);
}

/**
 * Set active tenant cookie value
 */
export async function setActiveTenant(tenantId: string): Promise<string> {
  const config = getTenantCookieConfig();
  const secure = config.secure ? '; Secure' : '';
  const httpOnly = config.httpOnly ? '; HttpOnly' : '';
  return `${config.name}=${encodeURIComponent(tenantId)}; Path=${config.path}${httpOnly}; SameSite=${config.sameSite}; Max-Age=${config.maxAge}${secure}`;
}

/**
 * Clear active tenant cookie value
 */
export async function clearActiveTenant(): Promise<string> {
  const config = getTenantCookieConfig();
  const secure = config.secure ? '; Secure' : '';
  const httpOnly = config.httpOnly ? '; HttpOnly' : '';
  return `${config.name}=; Path=${config.path}${httpOnly}; SameSite=${config.sameSite}; Max-Age=0${secure}`;
}

/**
 * Configure tenant cookie name
 */
export function configureTenantCookie(config: TenantCookieConfig): void {
  tenantCookieConfig = {
    ...tenantCookieConfig,
    ...config,
  };
}

/**
 * Reset tenant cookie config back to defaults.
 */
export function resetTenantCookieConfig(): void {
  tenantCookieConfig = {
    ...DEFAULT_TENANT_COOKIE_CONFIG,
  };
}
