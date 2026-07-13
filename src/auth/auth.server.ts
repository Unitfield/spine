/**
 * OpenID Connect Authentication Server Module
 *
 * Handles:
 * - Login flow (PKCE)
 * - Token exchange
 * - Token refresh
 * - Logout
 * - Session management
 */

import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import {
  createAuthSession,
  getAuthSession,
  updateAuthSession,
  destroyAuthSession,
  isSessionValid,
  listAuthSessionDataForUser,
  destroyAuthSessionsByIdentitySession,
  destroyAuthSessionsBySid,
  destroyAuthSessionsForUser,
  createOAuthState,
  getOAuthState,
  deleteOAuthState,
  AUTH_ERROR_COOKIE_PREFIX,
} from './redis-session-storage.server';
import type { 
  AuthConfig, 
  AuthClaimMapping,
  UserInfo, 
  SessionData, 
  OAuthState,
  TokenRefreshResult,
  LoginOptions,
  ApplicationType,
  OidcClientAuthMethod,
  BackChannelLogoutResult,
  FrontChannelLogoutResult,
  AuthError
} from './types';
import { logger } from '../logging';
import { createRedirectResponse } from '../http/response';
import {
  buildAuthorizationState,
  sanitizeExtraAuthorizationParameters,
} from './authorization-parameters';
import {
  sanitizeOAuthReturnUrl,
  serializeTemporaryAuthCookie,
} from './oauth-security';

type OidcTokenResponse = oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
type LogoutScope = 'identity' | 'local' | 'all';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Get effective hasLandingPage setting based on config
 */
function getEffectiveHasLandingPage(config: AuthConfig): boolean {
  // Explicit setting takes precedence
  if (config.hasLandingPage !== undefined) {
    return config.hasLandingPage;
  }
  
  // Determine by application type
  switch (config.applicationType) {
    case 'no-landing-page':
    case 'dashboard':
      return false; // Dashboard has no landing page
    case 'landing-page':
    case 'tenant-app':
      return true; // Tenant app has landing page
    default:
      return true; // Default to having a landing page
  }
}

/**
 * Create OAuth configuration from environment variables
 */
function createAuthConfig(): AuthConfig {
  const requiredEnvVars = {
    authority: process.env.OIDC_AUTHORITY,
    clientId: process.env.OIDC_CLIENT_ID,
    redirectUri: process.env.OIDC_REDIRECT_URI,
  };

  for (const [key, value] of Object.entries(requiredEnvVars)) {
    if (!value) {
      throw new Error(`Missing required environment variable: OIDC_${key.toUpperCase()}`);
    }
  }

  // Parse application type from env
  const appTypeEnv = process.env.OIDC_APPLICATION_TYPE?.toLowerCase();
  let applicationType: ApplicationType = 'custom';
  if (appTypeEnv === 'no-landing-page' || appTypeEnv === 'no_landing_page') {
    applicationType = 'no-landing-page';
  } else if (appTypeEnv === 'landing-page' || appTypeEnv === 'landing_page') {
    applicationType = 'landing-page';
  } else if (appTypeEnv === 'dashboard') {
    applicationType = 'dashboard';
  } else if (appTypeEnv === 'tenant-app' || appTypeEnv === 'tenant_app') {
    applicationType = 'tenant-app';
  }

  const clientAuthMethod = parseOidcClientAuthMethod(
    process.env.OIDC_CLIENT_AUTH_METHOD,
    process.env.OIDC_CLIENT_SECRET ? 'client_secret_post' : 'none'
  );

  const hasLandingPage = process.env.OIDC_HAS_LANDING_PAGE !== undefined
    ? process.env.OIDC_HAS_LANDING_PAGE === 'true'
    : undefined;

  return {
    authority: requiredEnvVars.authority!,
    clientId: requiredEnvVars.clientId!,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    clientAuthMethod,
    redirectUri: requiredEnvVars.redirectUri!,
    scope: process.env.OIDC_SCOPE || 'openid profile email api',
    postLogoutRedirectUri: process.env.OIDC_POST_LOGOUT_REDIRECT_URI,
    applicationType,
    hasLandingPage,
  };
}

function parseOidcClientAuthMethod(
  value: string | undefined,
  fallback: OidcClientAuthMethod
): OidcClientAuthMethod {
  const normalized = value?.trim().toLowerCase();

  switch (normalized) {
    case undefined:
    case '':
      return fallback;
    case 'none':
      return 'none';
    case 'client_secret_post':
    case 'post':
      return 'client_secret_post';
    case 'client_secret_basic':
    case 'basic':
      return 'client_secret_basic';
    default:
      throw new Error(`Unsupported OIDC_CLIENT_AUTH_METHOD: ${value}`);
  }
}

let OIDC_CONFIG: AuthConfig | null = null;

function getAuthConfig(): AuthConfig {
  if (!OIDC_CONFIG) {
    OIDC_CONFIG = createAuthConfig();
  }
  return OIDC_CONFIG;
}

// ============================================================================
// OAuth Discovery Cache
// ============================================================================

let authServerCache: {
  configuration: oidc.Configuration;
  cachedAt: number;
} | null = null;

const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function normalizeIssuer(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\/+$/, '');
  return normalized && normalized.length > 0 ? normalized : null;
}

function getJwtClaims(token: string | undefined): Record<string, unknown> | null {
  if (!token) {
    return null;
  }

  try {
    const [, payload] = token.split('.');
    if (!payload) {
      return null;
    }

    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getJwtIssuer(token: string | undefined): string | null {
  const issuer = getJwtClaims(token)?.iss;
  return typeof issuer === 'string' ? normalizeIssuer(issuer) : null;
}

function canUseIdTokenHint(idToken: string | undefined, expectedIssuer: string): boolean {
  if (!idToken) {
    return false;
  }

  const tokenIssuer = getJwtIssuer(idToken);
  return tokenIssuer !== null && tokenIssuer === normalizeIssuer(expectedIssuer);
}

function appendApplicationInitiatedActionResult(
  returnUrl: string,
  action: string | null | undefined,
  status: string | null | undefined
): string {
  if (!action && !status) {
    return returnUrl;
  }

  try {
    const isRelative = returnUrl.startsWith('/') && !returnUrl.startsWith('//');
    const url = new URL(returnUrl, isRelative ? 'http://spine.local' : undefined);

    if (action) {
      url.searchParams.set('kc_action', action);
    }

    if (status) {
      url.searchParams.set('kc_action_status', status);
    }

    return isRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch {
    const params = new URLSearchParams();
    if (action) params.set('kc_action', action);
    if (status) params.set('kc_action_status', status);
    const separator = returnUrl.includes('?') ? '&' : '?';
    return `${returnUrl}${separator}${params.toString()}`;
  }
}

export function createAuthorizationResponseUrl(requestUrl: string, redirectUri: string): URL {
  const incomingUrl = new URL(requestUrl);
  const authorizationResponseUrl = new URL(redirectUri);
  authorizationResponseUrl.search = incomingUrl.search;
  authorizationResponseUrl.hash = "";
  return authorizationResponseUrl;
}

function isLocalInsecureIssuer(authority: string): boolean {
  try {
    const issuer = new URL(authority);
    return (
      issuer.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '::1', '[::1]'].includes(issuer.hostname)
    );
  } catch {
    return false;
  }
}

function shouldAllowInsecureOidcRequests(authority: string): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }

  if (process.env.OIDC_ALLOW_INSECURE_REQUESTS === 'true') {
    return true;
  }

  return isLocalInsecureIssuer(authority);
}

function getDiscoveryOptions(): oidc.DiscoveryRequestOptions {
  const config = getAuthConfig();

  return shouldAllowInsecureOidcRequests(config.authority)
    ? { algorithm: 'oidc', execute: [oidc.allowInsecureRequests] }
    : { algorithm: 'oidc' };
}

function getClientMetadata(config: AuthConfig): string | undefined {
  return config.clientAuthMethod === 'none' ? undefined : config.clientSecret;
}

function getClientAuthentication(config: AuthConfig): oidc.ClientAuth {
  switch (config.clientAuthMethod) {
    case 'client_secret_basic':
      if (!config.clientSecret) {
        throw new Error('OIDC_CLIENT_SECRET is required for client_secret_basic authentication');
      }

      return oidc.ClientSecretBasic(config.clientSecret);
    case 'client_secret_post':
      if (!config.clientSecret) {
        throw new Error('OIDC_CLIENT_SECRET is required for client_secret_post authentication');
      }

      return oidc.ClientSecretPost(config.clientSecret);
    case 'none':
    default:
      return oidc.None();
  }
}

function getOAuthErrorMessage(error: unknown): string {
  if (error instanceof oidc.ResponseBodyError) {
    return error.error_description || error.error || error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}

function shouldLogoutAfterOAuthError(error: unknown): boolean {
  if (error instanceof oidc.ResponseBodyError) {
    return (
      error.status === 400 ||
      error.status === 401 ||
      error.error === 'invalid_grant' ||
      error.error === 'invalid_token'
    );
  }

  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('invalid_grant') || message.includes('invalid_token') || message.includes('unauthorized');
}

function getLogoutScope(url: URL): LogoutScope {
  const requestedScope =
    url.searchParams.get('logout') ??
    url.searchParams.get('logout_scope') ??
    url.searchParams.get('scope');
  const normalized = requestedScope?.trim().toLowerCase();

  if (
    normalized === 'local' ||
    normalized === 'application' ||
    normalized === 'app' ||
    normalized === 'current-device'
  ) {
    return 'local';
  }

  if (
    normalized === 'all' ||
    normalized === 'all-local' ||
    normalized === 'all-devices' ||
    normalized === 'everywhere'
  ) {
    return 'all';
  }

  if (url.searchParams.get('local_only') === 'true' || url.searchParams.get('client_id_only') === 'true') {
    return 'local';
  }

  return 'identity';
}

function getAbsoluteRedirectUrl(request: Request, redirectUrl: string): string {
  if (/^https?:\/\//i.test(redirectUrl)) {
    return redirectUrl;
  }

  return new URL(redirectUrl, new URL(request.url).origin).toString();
}

async function revokeTokenBestEffort(
  configuration: oidc.Configuration,
  token: string | undefined,
  tokenTypeHint: 'access_token' | 'refresh_token'
): Promise<void> {
  if (!token) {
    return;
  }

  try {
    await oidc.tokenRevocation(configuration, token, {
      token_type_hint: tokenTypeHint,
    });
  } catch (error) {
    logger.warn('OIDC token revocation failed', {
      tokenTypeHint,
      error: getOAuthErrorMessage(error),
    });
  }
}

async function revokeSessionTokensBestEffort(sessionData: SessionData): Promise<void> {
  if (!sessionData.refreshToken && !sessionData.accessToken) {
    return;
  }

  try {
    const configuration = await getOAuthConfig();
    await revokeTokenBestEffort(configuration, sessionData.refreshToken, 'refresh_token');
    await revokeTokenBestEffort(configuration, sessionData.accessToken, 'access_token');
  } catch (error) {
    logger.warn('Skipping OIDC token revocation because provider configuration is unavailable', {
      error: getOAuthErrorMessage(error),
    });
  }
}

async function revokeAndDestroyAllUserSessionsBestEffort(userId: string): Promise<number> {
  const sessions = await listAuthSessionDataForUser(userId);

  try {
    const configuration = await getOAuthConfig();
    for (const { data } of sessions) {
      await revokeTokenBestEffort(configuration, data.refreshToken, 'refresh_token');
      await revokeTokenBestEffort(configuration, data.accessToken, 'access_token');
    }
  } catch (error) {
    logger.warn('Skipping all-session token revocation because provider configuration is unavailable', {
      error: getOAuthErrorMessage(error),
    });
  }

  return await destroyAuthSessionsForUser(userId);
}

function getClaimsFromTokenResponse(tokenResult: OidcTokenResponse): Record<string, unknown> {
  const claims = tokenResult.claims();

  if (claims) {
    return claims as Record<string, unknown>;
  }

  return getJwtClaims(tokenResult.id_token) ?? {};
}

/**
 * Get OIDC configuration with caching.
 */
async function getOAuthConfig(): Promise<oidc.Configuration> {
  const config = getAuthConfig();
  const now = Date.now();

  if (authServerCache && now - authServerCache.cachedAt < CACHE_TTL) {
    return authServerCache.configuration;
  }

  try {
    const configuration = await oidc.discovery(
      new URL(config.authority),
      config.clientId,
      getClientMetadata(config),
      getClientAuthentication(config),
      getDiscoveryOptions()
    );

    authServerCache = {
      configuration,
      cachedAt: now,
    };

    logger.info('OIDC discovery completed successfully', {
      issuer: configuration.serverMetadata().issuer,
      clientId: config.clientId,
      clientAuthMethod: config.clientAuthMethod,
    });
    return configuration;
  } catch (error) {
    logger.error('OIDC discovery failed', error instanceof Error ? error : undefined, {
      authority: config.authority,
      clientId: config.clientId,
    });
    throw new Error(`OIDC discovery failed: ${getOAuthErrorMessage(error)}`);
  }
}

function getJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  const cachedJwks = jwksCache.get(jwksUri);
  if (cachedJwks) {
    return cachedJwks;
  }

  const jwks = createRemoteJWKSet(new URL(jwksUri));
  jwksCache.set(jwksUri, jwks);
  return jwks;
}

async function getLogoutTokenFromRequest(request: Request): Promise<string | null> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => null) as { logout_token?: unknown } | null;
    return typeof body?.logout_token === 'string' ? body.logout_token : null;
  }

  const formData = await request.formData().catch(() => null);
  const logoutToken = formData?.get('logout_token');
  return typeof logoutToken === 'string' ? logoutToken : null;
}

function validateBackChannelLogoutClaims(payload: Record<string, unknown>, clientId: string): {
  issuer?: string;
  subject?: string;
  sid?: string;
} {
  const events = payload.events;
  const hasBackChannelEvent =
    events &&
    typeof events === 'object' &&
    !Array.isArray(events) &&
    'http://schemas.openid.net/event/backchannel-logout' in events;

  if (!hasBackChannelEvent) {
    throw new Error('Invalid back-channel logout token: missing back-channel logout event');
  }

  if ('nonce' in payload) {
    throw new Error('Invalid back-channel logout token: nonce is not allowed');
  }

  const audience = payload.aud;
  const hasClientAudience = Array.isArray(audience)
    ? audience.includes(clientId)
    : audience === clientId;

  if (!hasClientAudience) {
    throw new Error('Invalid back-channel logout token: audience mismatch');
  }

  const subject = typeof payload.sub === 'string' ? payload.sub : undefined;
  const sid = typeof payload.sid === 'string' ? payload.sid : undefined;

  if (!subject && !sid) {
    throw new Error('Invalid back-channel logout token: subject or sid is required');
  }

  return {
    issuer: typeof payload.iss === 'string' ? payload.iss : undefined,
    subject,
    sid,
  };
}

// ============================================================================
// Claim Extraction
// ============================================================================

const DEFAULT_AUTH_CLAIM_MAPPING: Required<AuthClaimMapping> = {
  subject: ['sub'],
  name: ['name', 'preferred_username', 'email'],
  email: ['email'],
  givenName: ['given_name', 'givenName'],
  familyName: ['family_name', 'familyName'],
  picture: ['picture', 'avatar_url'],
  locale: ['locale'],
  zoneinfo: ['zoneinfo'],
  updatedAt: ['updated_at'],
  tenantIds: ['tenant_ids'],
  tenantRoles: ['tenant_roles'],
  permissions: ['app_perms', 'permissions', 'scope'],
  isOnboarded: ['is_onboarded'],
};

let authClaimMapping: Required<AuthClaimMapping> = {
  ...DEFAULT_AUTH_CLAIM_MAPPING,
};

function normalizeClaimKeys(keys?: string[]): string[] {
  if (!Array.isArray(keys)) {
    return [];
  }

  return Array.from(
    new Set(
      keys
        .map((key) => key.trim())
        .filter((key) => key.length > 0)
    )
  );
}

/**
 * Configure claim mapping so different providers/backends can project their
 * own claim names onto the shared auth/session primitives.
 */
export function configureAuthClaimMapping(mapping: AuthClaimMapping): void {
  authClaimMapping = {
    subject: mapping.subject !== undefined ? normalizeClaimKeys(mapping.subject) : DEFAULT_AUTH_CLAIM_MAPPING.subject,
    name: mapping.name !== undefined ? normalizeClaimKeys(mapping.name) : DEFAULT_AUTH_CLAIM_MAPPING.name,
    email: mapping.email !== undefined ? normalizeClaimKeys(mapping.email) : DEFAULT_AUTH_CLAIM_MAPPING.email,
    givenName: mapping.givenName !== undefined ? normalizeClaimKeys(mapping.givenName) : DEFAULT_AUTH_CLAIM_MAPPING.givenName,
    familyName: mapping.familyName !== undefined ? normalizeClaimKeys(mapping.familyName) : DEFAULT_AUTH_CLAIM_MAPPING.familyName,
    picture: mapping.picture !== undefined ? normalizeClaimKeys(mapping.picture) : DEFAULT_AUTH_CLAIM_MAPPING.picture,
    locale: mapping.locale !== undefined ? normalizeClaimKeys(mapping.locale) : DEFAULT_AUTH_CLAIM_MAPPING.locale,
    zoneinfo: mapping.zoneinfo !== undefined ? normalizeClaimKeys(mapping.zoneinfo) : DEFAULT_AUTH_CLAIM_MAPPING.zoneinfo,
    updatedAt: mapping.updatedAt !== undefined ? normalizeClaimKeys(mapping.updatedAt) : DEFAULT_AUTH_CLAIM_MAPPING.updatedAt,
    tenantIds: mapping.tenantIds !== undefined ? normalizeClaimKeys(mapping.tenantIds) : DEFAULT_AUTH_CLAIM_MAPPING.tenantIds,
    tenantRoles: mapping.tenantRoles !== undefined ? normalizeClaimKeys(mapping.tenantRoles) : DEFAULT_AUTH_CLAIM_MAPPING.tenantRoles,
    permissions: mapping.permissions !== undefined ? normalizeClaimKeys(mapping.permissions) : DEFAULT_AUTH_CLAIM_MAPPING.permissions,
    isOnboarded: mapping.isOnboarded !== undefined ? normalizeClaimKeys(mapping.isOnboarded) : DEFAULT_AUTH_CLAIM_MAPPING.isOnboarded,
  };
}

/**
 * Reset claim mapping to the built-in defaults.
 */
export function resetAuthClaimMapping(): void {
  authClaimMapping = {
    ...DEFAULT_AUTH_CLAIM_MAPPING,
  };
}

function getConfiguredAuthClaimMapping(): Required<AuthClaimMapping> {
  return authClaimMapping;
}

function getFirstClaimValue(
  claims: Record<string, unknown>,
  claimKeys: string[]
): { key?: string; value?: unknown } {
  for (const claimKey of claimKeys) {
    if (claimKey in claims) {
      return {
        key: claimKey,
        value: claims[claimKey],
      };
    }
  }

  return {};
}

function getStringClaim(claims: Record<string, unknown>, claimKeys: string[]): string | undefined {
  const { value } = getFirstClaimValue(claims, claimKeys);

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }

  return undefined;
}

function getNumberClaim(claims: Record<string, unknown>, claimKeys: string[]): number | undefined {
  const { value } = getFirstClaimValue(claims, claimKeys);

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function getBooleanClaim(
  claims: Record<string, unknown>,
  claimKeys: string[],
  defaultValue = false
): boolean {
  const { value } = getFirstClaimValue(claims, claimKeys);

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }

  return defaultValue;
}

/**
 * Parse JSON safely
 */
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Convert value to string array
 */
function toStringArray(value: unknown): string[] {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : `${item}`.trim()))
      .filter((item) => item.length > 0);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[')) {
      const parsed = parseJson(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === 'string' ? item.trim() : `${item}`.trim()))
          .filter((item) => item.length > 0);
      }
    }

    if (trimmed.includes(',')) {
      return trimmed
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }

    return [trimmed];
  }

  return [];
}

function toScopeArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .trim()
      .split(/\s+/)
      .filter((item) => item.length > 0);
  }

  return toStringArray(value);
}

/**
 * Extract user info from ID token claims
 */
export function extractUserInfo(claims: Record<string, unknown>): {
  tenants: string[];
  currentTenant?: string;
  isOnboarded: boolean;
  tenantRoles: Record<string, string[]>;
  permissions: string[];
} {
  const claimMapping = getConfiguredAuthClaimMapping();

  // Extract tenant IDs
  let tenants: string[] = [];
  const { value: rawTenantIds } = getFirstClaimValue(claims, claimMapping.tenantIds);
  if (rawTenantIds !== undefined) {
    if (typeof rawTenantIds === 'string' && rawTenantIds.trim().startsWith('[')) {
      const parsed = parseJson(rawTenantIds.trim());
      if (Array.isArray(parsed)) {
        tenants = parsed
          .map((id) => (typeof id === 'string' ? id.trim() : `${id}`.trim()))
          .filter((id) => id.length > 0);
      }
    } else {
      tenants = toStringArray(rawTenantIds);
    }
  }

  // Extract tenant roles
  const tenantRoles: Record<string, string[]> = {};
  const { value: rawRoles } = getFirstClaimValue(claims, claimMapping.tenantRoles);
  if (rawRoles !== undefined) {
    let parsedRoles: unknown = rawRoles;

    if (typeof rawRoles === 'string' && rawRoles.trim().startsWith('{')) {
      parsedRoles = parseJson(rawRoles.trim()) ?? rawRoles;
    }

    if (parsedRoles && typeof parsedRoles === 'object' && !Array.isArray(parsedRoles)) {
      for (const [tenantId, roleValue] of Object.entries(parsedRoles as Record<string, unknown>)) {
        const roleIds = toStringArray(roleValue);
        if (roleIds.length > 0) {
          tenantRoles[tenantId] = roleIds;
        }
      }
    }
  }

  // Extract permissions
  const permissionClaim = getFirstClaimValue(claims, claimMapping.permissions);
  const permissions =
    permissionClaim.key === 'scope'
      ? toScopeArray(permissionClaim.value)
      : toStringArray(permissionClaim.value);

  // Extract onboarding status
  const isOnboarded = getBooleanClaim(claims, claimMapping.isOnboarded);

  return { tenants, isOnboarded, tenantRoles, permissions };
}

// ============================================================================
// Session Data Creation
// ============================================================================

/**
 * Create session data from token result
 */
async function createSessionData(
  tokenResult: OidcTokenResponse,
  claims: Record<string, unknown>
): Promise<Partial<SessionData>> {
  const claimMapping = getConfiguredAuthClaimMapping();
  const baseUser: UserInfo = {
    sub: getStringClaim(claims, claimMapping.subject) || 'unknown',
    name: getStringClaim(claims, claimMapping.name) || getStringClaim(claims, claimMapping.email) || 'User',
    email: getStringClaim(claims, claimMapping.email),
    givenName: getStringClaim(claims, claimMapping.givenName),
    familyName: getStringClaim(claims, claimMapping.familyName),
    picture: getStringClaim(claims, claimMapping.picture),
    locale: getStringClaim(claims, claimMapping.locale),
    zoneinfo: getStringClaim(claims, claimMapping.zoneinfo),
    updated_at: getNumberClaim(claims, claimMapping.updatedAt),
  };

  const expiresAt = tokenResult.expires_in
    ? Date.now() + tokenResult.expires_in * 1000
    : undefined;
  const now = Date.now();
  const sessionState = (tokenResult as Record<string, unknown>).session_state;

  return {
    userId: baseUser.sub,
    accessToken: tokenResult.access_token,
    refreshToken: tokenResult.refresh_token,
    idToken: tokenResult.id_token,
    expiresAt,
    issuer: getStringClaim(claims, ['iss']),
    sid: getStringClaim(claims, ['sid']),
    sessionState: typeof sessionState === 'string' ? sessionState : undefined,
    clientId: getAuthConfig().clientId,
    user: baseUser,
    createdAt: now,
    lastActivity: now,
  };
}

// ============================================================================
// Auth Error Handling
// ============================================================================

// Auth error cookie names - unique per application to prevent conflicts
const AUTH_ERROR_COOKIE = `${AUTH_ERROR_COOKIE_PREFIX}_auth_error`;
const AUTH_ERROR_DESC_COOKIE = `${AUTH_ERROR_COOKIE_PREFIX}_auth_error_desc`;
const OAUTH_STATE_COOKIE = `${AUTH_ERROR_COOKIE_PREFIX}_oauth_state_id`;
const LOGOUT_RETURN_URL_COOKIE = 'logout_return_url';

/**
 * Check if there's an auth error in cookies
 * 
 * This should be called by apps (especially those without landing pages like Dashboard)
 * BEFORE starting OAuth flow to prevent redirect loops.
 * 
 * @example
 * ```ts
 * // In dashboard's index route loader
 * const authError = getAuthError(request);
 * if (authError) {
 *   return { authError }; // Show error to user
 * }
 * // No error, proceed with session check
 * const user = await getUser(request);
 * if (!user) {
 *   return login(request);
 * }
 * ```
 */
export function getAuthError(request: Request): AuthError | null {
  const cookies = request.headers.get('Cookie');
  if (!cookies) return null;
  
  // Parse auth_error cookie (app-specific)
  const errorRegex = new RegExp(`${AUTH_ERROR_COOKIE}=([^;]+)`);
  const errorMatch = cookies.match(errorRegex);
  if (!errorMatch) return null;
  
  const error = decodeURIComponent(errorMatch[1]);
  if (!error) return null;
  
  // Parse auth_error_description cookie (app-specific)
  const descRegex = new RegExp(`${AUTH_ERROR_DESC_COOKIE}=([^;]+)`);
  const descMatch = cookies.match(descRegex);
  const description = descMatch ? decodeURIComponent(descMatch[1]) : undefined;
  
  return { error, description };
}

/**
 * Clear auth error cookies
 * 
 * Call this after displaying the error to the user
 */
export function clearAuthErrorHeaders(): Headers {
  const headers = new Headers();
  headers.append(
    'Set-Cookie',
    serializeTemporaryAuthCookie(AUTH_ERROR_COOKIE, '', { maxAge: 0 }),
  );
  headers.append(
    'Set-Cookie',
    serializeTemporaryAuthCookie(AUTH_ERROR_DESC_COOKIE, '', { maxAge: 0 }),
  );
  return headers;
}

/**
 * Check if request has auth error (quick check without parsing)
 */
export function hasAuthError(request: Request): boolean {
  const cookies = request.headers.get('Cookie');
  return cookies?.includes(`${AUTH_ERROR_COOKIE}=`) ?? false;
}

// ============================================================================
// Auth Functions
// ============================================================================

/**
 * Initiate OAuth login flow
 * 
 * @param request - The incoming request
 * @param returnUrlOrOptions - Either a return URL string or LoginOptions object
 */
export async function login(
  request: Request, 
  returnUrlOrOptions?: string | LoginOptions
): Promise<Response> {
  try {
    const config = getAuthConfig();
    
    // Parse options
    const options: LoginOptions = typeof returnUrlOrOptions === 'string' 
      ? { returnUrl: returnUrlOrOptions }
      : returnUrlOrOptions || {};
    const returnUrl = sanitizeOAuthReturnUrl(options.returnUrl, request) ?? '/';

    // Check for auth_error cookie to prevent redirect loops
    const cookies = request.headers.get('Cookie');
    const hasError = cookies?.includes(`${AUTH_ERROR_COOKIE}=`);
    if (hasError) {
      logger.warn('Auth error cookie detected, preventing redirect loop');
      // Clear the error cookie and redirect to home
      const headers = new Headers();
      headers.append(
        'Set-Cookie',
        serializeTemporaryAuthCookie(AUTH_ERROR_COOKIE, '', { maxAge: 0 }),
      );
      // Use redirectUri to get correct base URL with port
      const redirectUri = new URL(config.redirectUri);
      const baseUrl = redirectUri.origin;
      return createRedirectResponse(baseUrl, { headers });
    }

    const oidcConfig = await getOAuthConfig();

    // Generate PKCE challenge
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

    const extraAuthParams = sanitizeExtraAuthorizationParameters(options.extraAuthParams, options);

    // Generate secure state and nonce. The state may carry a non-secret UI
    // hint for Keycloak themes, but callback validation still compares the
    // exact value stored server-side.
    const state = buildAuthorizationState(oidc.randomState(), options.publicStateContext);
    const nonce = oidc.randomNonce();

    // Create OAuth state object
    const oauthState: OAuthState = {
      state,
      codeVerifier,
      nonce,
      returnUrl,
      kcAction: options.kcAction,
      createdAt: Date.now(),
    };

    logger.info('Creating OAuth state', {
      hasReturnUrl: Boolean(options.returnUrl),
      prompt: options.prompt,
      hasKcAction: Boolean(options.kcAction),
      extraAuthParamKeys: Object.keys(extraAuthParams),
    });

    // Store OAuth state in Redis
    const stateId = await createOAuthState(oauthState);

    const authorizationParameters: Record<string, string> = {
      redirect_uri: config.redirectUri,
      scope: config.scope,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...extraAuthParams,
    };

    if (options.prompt) {
      authorizationParameters.prompt = options.prompt;
    }

    if (options.kcAction) {
      authorizationParameters.kc_action = options.kcAction;
    }

    const authorizationUrl = oidc.buildAuthorizationUrl(oidcConfig, authorizationParameters);

    // Store stateId in cookie for callback (app-specific to prevent conflicts)
    const headers = new Headers();
    headers.append(
      'Set-Cookie',
      serializeTemporaryAuthCookie(OAUTH_STATE_COOKIE, stateId, { maxAge: 600 }),
    );

    logger.info('OIDC authorization flow initiated', {
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scope: config.scope,
      authorizationEndpoint: oidcConfig.serverMetadata().authorization_endpoint,
      hasStateId: true,
      prompt: options.prompt,
      hasKcAction: Boolean(options.kcAction),
    });

    return createRedirectResponse(authorizationUrl.toString(), { headers });
  } catch (error) {
    logger.error('Failed to initiate OAuth login', undefined, {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    throw new Error('Login failed');
  }
}

/**
 * Handle OAuth callback
 * 
 * Handles OAuth authorization response including success and error cases.
 * 
 * Error Handling:
 * - `access_denied`: User doesn't have access to this application
 *   - For apps with landing page: Redirect home with error cookie
 *   - For apps without landing page: Redirect home with error cookie (must handle specially)
 * - `login_required`: No active identity session
 *   - Redirect to home to start fresh login
 */
export async function handleCallback(request: Request): Promise<Response> {
  try {
    const config = getAuthConfig();
    const hasLandingPage = getEffectiveHasLandingPage(config);
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');
    const kcAction = url.searchParams.get('kc_action');
    const kcActionStatus = url.searchParams.get('kc_action_status');

    logger.info('OIDC callback received', {
      hasCode: !!code,
      hasState: !!state,
      hasError: Boolean(error),
      hasErrorDescription: Boolean(errorDescription),
      hasKcAction: Boolean(kcAction),
      hasKcActionStatus: Boolean(kcActionStatus),
      clientId: config.clientId,
      redirectUri: config.redirectUri
    });

    // Handle OAuth errors
    if (error) {
      if (kcActionStatus && state) {
        const cookies = request.headers.get('Cookie');
        const oauthStateRegex = new RegExp(`${OAUTH_STATE_COOKIE}=([^;]+)`);
        const cookieMatch = cookies?.match(oauthStateRegex);
        const stateId = cookieMatch?.[1];

        if (stateId) {
          const oauthState = await getOAuthState(stateId);
          const stateAge = oauthState ? Date.now() - oauthState.createdAt : Number.POSITIVE_INFINITY;

          if (oauthState && oauthState.state === state && stateAge <= 10 * 60 * 1000) {
            await deleteOAuthState(stateId);
            const headers = new Headers();
            headers.append(
              'Set-Cookie',
              serializeTemporaryAuthCookie(OAUTH_STATE_COOKIE, '', { maxAge: 0 }),
            );

            const redirectUrl = appendApplicationInitiatedActionResult(
              sanitizeOAuthReturnUrl(oauthState.returnUrl, request) ?? '/',
              kcAction || oauthState.kcAction,
              kcActionStatus
            );

            logger.info('Application initiated action returned with OAuth error', {
              hasError: Boolean(error),
              hasErrorDescription: Boolean(errorDescription),
              hasKcAction: Boolean(kcAction || oauthState.kcAction),
              hasKcActionStatus: Boolean(kcActionStatus),
            });

            return createRedirectResponse(redirectUrl, { headers });
          }
        }
      }

      logger.error('OAuth callback error', undefined, { 
        hasError: Boolean(error),
        hasErrorDescription: Boolean(errorDescription),
        clientId: config.clientId,
        applicationType: config.applicationType,
        hasLandingPage
      });
      
      // Handle access_denied specially - user doesn't have access to this app
      // This can happen when identity cookie is valid but user has no access to this client
      if (error === 'access_denied') {
        logger.warn('Access denied for this application', { clientId: config.clientId });
        // Clear any existing session and redirect to home without triggering new login
        const headers = await destroyAuthSession(request);
        // Set error cookies to:
        // 1. Prevent redirect loop (auth_error)
        // 2. Allow UI to show appropriate message (auth_error_type, auth_error_description)
        headers.append(
          'Set-Cookie',
          serializeTemporaryAuthCookie(AUTH_ERROR_COOKIE, 'access_denied', { maxAge: 300 }),
        );
        headers.append(
          'Set-Cookie',
          serializeTemporaryAuthCookie(
            AUTH_ERROR_DESC_COOKIE,
            errorDescription || 'You do not have access to this application.',
            { maxAge: 300 },
          ),
        );
        // Use redirectUri to get the correct base URL with port
        // request.url.origin can lose the port in some cases
        const redirectUri = new URL(config.redirectUri);
        const baseUrl = redirectUri.origin;
        logger.info('Redirecting to /auth/login to show access_denied error', { 
          hasLandingPage,
          baseUrl,
          configRedirectUri: config.redirectUri
        });
        // Redirect to /auth/login so user immediately sees the access denied page
        // instead of landing page (which doesn't show the error)
        return createRedirectResponse(`${baseUrl}/auth/login`, { headers });
      }
      
      // Handle login_required - session expired or user not logged in
      if (error === 'login_required') {
        logger.info('Login required, user session may have expired');
        const headers = await destroyAuthSession(request);
        // Use redirectUri to get correct base URL with port
        const redirectUri = new URL(config.redirectUri);
        const baseUrl = redirectUri.origin;
        return createRedirectResponse(baseUrl, { headers });
      }
      
      // Handle other errors
      const headers = await destroyAuthSession(request);
      headers.append(
        'Set-Cookie',
        serializeTemporaryAuthCookie(AUTH_ERROR_COOKIE, error, { maxAge: 300 }),
      );
      if (errorDescription) {
        headers.append(
          'Set-Cookie',
          serializeTemporaryAuthCookie(AUTH_ERROR_DESC_COOKIE, errorDescription, { maxAge: 300 }),
        );
      }
      // Use redirectUri to get correct base URL with port
      const redirectUri = new URL(config.redirectUri);
      const baseUrl = redirectUri.origin;
      return createRedirectResponse(baseUrl, { headers });
    }

    // Get stateId from cookie (app-specific)
    const cookies = request.headers.get('Cookie');
    const oauthStateRegex = new RegExp(`${OAUTH_STATE_COOKIE}=([^;]+)`);
    const cookieMatch = cookies?.match(oauthStateRegex);
    const stateId = cookieMatch?.[1];

    if (!stateId) {
      throw new Error('OAuth state ID not found in cookie');
    }

    // Retrieve OAuth state from Redis
    const oauthState = await getOAuthState(stateId);

    if (!oauthState) {
      throw new Error('No OAuth state found - state may have expired');
    }

    if (!state) {
      throw new Error('Missing required callback state parameter');
    }

    if (oauthState.state !== state) {
      throw new Error(`OAuth state mismatch`);
    }

    // Check state age (10 minutes max)
    const stateAge = Date.now() - oauthState.createdAt;
    if (stateAge > 10 * 60 * 1000) {
      throw new Error('OAuth state expired');
    }

    if (!code) {
      if (kcActionStatus) {
        await deleteOAuthState(stateId);
        const headers = new Headers();
        headers.append(
          'Set-Cookie',
          serializeTemporaryAuthCookie(OAUTH_STATE_COOKIE, '', { maxAge: 0 }),
        );

        const redirectUrl = appendApplicationInitiatedActionResult(
          sanitizeOAuthReturnUrl(oauthState.returnUrl, request) ?? '/',
          kcAction || oauthState.kcAction,
          kcActionStatus
        );

        logger.info('Application initiated action returned without authorization code', {
          hasKcAction: Boolean(kcAction || oauthState.kcAction),
          hasKcActionStatus: Boolean(kcActionStatus),
        });

        return createRedirectResponse(redirectUrl, { headers });
      }

      throw new Error('Missing required callback code parameter');
    }

    logger.info('Initiating token exchange');

    const oidcConfig = await getOAuthConfig();
    const authorizationResponseUrl = createAuthorizationResponseUrl(request.url, config.redirectUri);
    const tokenResult = await oidc.authorizationCodeGrant(oidcConfig, authorizationResponseUrl, {
      pkceCodeVerifier: oauthState.codeVerifier,
      expectedState: oauthState.state,
      expectedNonce: oauthState.nonce,
      idTokenExpected: config.scope.split(/\s+/).includes('openid'),
    });

    logger.info('Token exchange completed successfully');

    const claims = getClaimsFromTokenResponse(tokenResult);

    // Create session data
    const newSessionData = await createSessionData(tokenResult, claims);

    // Create new session
    const sessionHeaders = await createAuthSession(request, newSessionData);

    // Clean up OAuth state from Redis
    await deleteOAuthState(stateId);

    // Combine headers and clear OAuth state cookie (app-specific)
    const headers = new Headers(sessionHeaders);
    headers.append(
      'Set-Cookie',
      serializeTemporaryAuthCookie(OAUTH_STATE_COOKIE, '', { maxAge: 0 }),
    );

    logger.info('OAuth callback processed successfully');

    // Redirect to return URL or default location
    const redirectUrl = appendApplicationInitiatedActionResult(
      sanitizeOAuthReturnUrl(oauthState.returnUrl, request) ?? '/',
      kcAction || oauthState.kcAction,
      kcActionStatus
    );
    return createRedirectResponse(redirectUrl, { headers });
  } catch (error) {
    logger.error('OAuth callback failed', undefined, {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });

    // Try to clean up OAuth state on error
    try {
      const cookies = request.headers.get('Cookie');
      const oauthStateRegex = new RegExp(`${OAUTH_STATE_COOKIE}=([^;]+)`);
      const cookieMatch = cookies?.match(oauthStateRegex);
      const stateId = cookieMatch?.[1];
      if (stateId) {
        await deleteOAuthState(stateId);
      }
    } catch {
      // Ignore cleanup errors
    }

    await destroyAuthSession(request);
    throw new Error('Authentication failed');
  }
}

/**
 * Logout user.
 *
 * Default logout follows OIDC RP-Initiated Logout and ends the identity
 * provider session. Automatic/session-expiry cleanup can request
 * `/auth/logout?logout=local` to clear only this app's Redis session without
 * bouncing the browser through the identity provider or revoking SSO tokens.
 */
export async function logout(request: Request): Promise<Response> {
  try {
    const config = getAuthConfig();
    const url = new URL(request.url);
    
    const logoutScope = getLogoutScope(url);
    const returnUrl = sanitizeOAuthReturnUrl(url.searchParams.get('returnUrl'), request);
    
    logger.info('Logout initiated', { 
      clientId: config.clientId,
      logoutScope,
    });
    
    const sessionData = await getAuthSession(request);
    const idToken = sessionData.idToken;

    if (logoutScope === 'local') {
      // Local logout is RP-only cleanup. Tokens are server-side and become
      // unreachable once the Redis session is destroyed; revoking the refresh
      // token can also terminate the Keycloak SSO session for this user.
      const headers = await destroyAuthSession(request);
      const redirectUrl = returnUrl || '/';
      const absoluteRedirectUrl = getAbsoluteRedirectUrl(request, redirectUrl);

      headers.append(
        'Set-Cookie',
        serializeTemporaryAuthCookie(LOGOUT_RETURN_URL_COOKIE, '', { maxAge: 0 }),
      );
      logger.info('Local application logout completed', { hasReturnUrl: Boolean(returnUrl) });
      return createRedirectResponse(absoluteRedirectUrl, { headers });
    }

    const sessionHeaders = new Headers();

    if (logoutScope === 'all' && sessionData.userId) {
      await revokeAndDestroyAllUserSessionsBestEffort(sessionData.userId);
      sessionHeaders.append(
        'Set-Cookie',
        serializeTemporaryAuthCookie(LOGOUT_RETURN_URL_COOKIE, '', { maxAge: 0 }),
      );
      const expiredHeaders = await destroyAuthSession(request);
      expiredHeaders.forEach((value, key) => sessionHeaders.append(key, value));
    } else {
      await revokeSessionTokensBestEffort(sessionData);
      const expiredHeaders = await destroyAuthSession(request);
      expiredHeaders.forEach((value, key) => sessionHeaders.append(key, value));
    }

    const headers = new Headers(sessionHeaders);

    // Store returnUrl in cookie if provided for the post-logout landing redirect.
    if (returnUrl) {
      headers.append(
        'Set-Cookie',
        serializeTemporaryAuthCookie(LOGOUT_RETURN_URL_COOKIE, returnUrl, { maxAge: 300 }),
      );
    } else {
      headers.append(
        'Set-Cookie',
        serializeTemporaryAuthCookie(LOGOUT_RETURN_URL_COOKIE, '', { maxAge: 0 }),
      );
    }

    try {
      const oidcConfig = await getOAuthConfig();
      const serverMetadata = oidcConfig.serverMetadata();
      const logoutParameters: Record<string, string> = {};
      const expectedIssuer = serverMetadata.issuer ?? config.authority;

      if (idToken && canUseIdTokenHint(idToken, expectedIssuer)) {
        logoutParameters.id_token_hint = idToken;
      } else if (idToken) {
        logger.warn('Skipping id_token_hint because the session token issuer does not match the active OIDC provider', {
          tokenIssuer: getJwtIssuer(idToken),
          expectedIssuer: normalizeIssuer(expectedIssuer),
          clientId: config.clientId,
        });
      }

      if (config.postLogoutRedirectUri) {
        logoutParameters.post_logout_redirect_uri = config.postLogoutRedirectUri;
      }

      const endSessionUrl = oidc.buildEndSessionUrl(oidcConfig, logoutParameters);
      logger.info('RP-Initiated Logout redirect created', {
        endSessionEndpoint: serverMetadata.end_session_endpoint,
        hasIdTokenHint: Boolean(logoutParameters.id_token_hint),
      });

      return createRedirectResponse(endSessionUrl.toString(), { headers });
    } catch (error) {
      logger.warn('OIDC end_session endpoint unavailable, falling back to local redirect', {
        error: getOAuthErrorMessage(error),
      });
    }

    // Fallback redirect
    const registeredPath = config.postLogoutRedirectUri || '/';
    const finalRedirectUrl = getAbsoluteRedirectUrl(request, registeredPath);

    logger.info('Logout completed', { hasConfiguredRedirect: Boolean(config.postLogoutRedirectUri) });
    return createRedirectResponse(finalRedirectUrl, { headers });
  } catch (error) {
    logger.error('Logout failed', error instanceof Error ? error : undefined);
    const headers = await destroyAuthSession(request);
    return createRedirectResponse('/', { headers });
  }
}

/**
 * Handle an OIDC Back-Channel Logout request from Keycloak or another OP.
 *
 * Configure the client Backchannel logout URL to this endpoint. The logout
 * token is signature-verified against the provider JWKS, issuer/audience are
 * checked, and all matching local Redis sessions are destroyed by `sid` first,
 * falling back to `sub` when the OP omits a session id.
 */
export async function handleBackChannelLogout(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  try {
    const config = getAuthConfig();
    const oidcConfig = await getOAuthConfig();
    const serverMetadata = oidcConfig.serverMetadata();
    const logoutToken = await getLogoutTokenFromRequest(request);

    if (!logoutToken) {
      return Response.json({ error: 'missing_logout_token' }, { status: 400 });
    }

    if (!serverMetadata.jwks_uri) {
      throw new Error('OIDC provider does not expose jwks_uri');
    }

    const { payload } = await jwtVerify(logoutToken, getJwks(serverMetadata.jwks_uri), {
      issuer: serverMetadata.issuer ?? config.authority,
      audience: config.clientId,
      clockTolerance: 60,
    });

    const claims = validateBackChannelLogoutClaims(payload as Record<string, unknown>, config.clientId);
    const destroyedSessions = await destroyAuthSessionsByIdentitySession({
      sid: claims.sid,
      userId: claims.subject,
    });
    const result: BackChannelLogoutResult = {
      destroyedSessions,
      issuer: claims.issuer,
      subject: claims.subject,
      sid: claims.sid,
    };

    logger.info('Back-channel logout processed', { ...result });
    return Response.json({ success: true, ...result });
  } catch (error) {
    logger.error('Back-channel logout failed', error instanceof Error ? error : undefined);
    return Response.json(
      { error: 'invalid_logout_token', error_description: getOAuthErrorMessage(error) },
      { status: 400 }
    );
  }
}

/**
 * Handle OIDC Front-Channel Logout iframe/browser requests.
 *
 * Front-channel logout cannot carry a signed logout token, so this validates the
 * issuer and applies local cleanup only when a `sid` is present.
 */
export async function handleFrontChannelLogout(request: Request): Promise<Response> {
  try {
    const config = getAuthConfig();
    const oidcConfig = await getOAuthConfig();
    const serverMetadata = oidcConfig.serverMetadata();
    const url = new URL(request.url);
    const issuer = url.searchParams.get('iss');
    const sid = url.searchParams.get('sid');
    const expectedIssuer = normalizeIssuer(serverMetadata.issuer ?? config.authority);

    if (!issuer || normalizeIssuer(issuer) !== expectedIssuer) {
      return new Response(null, { status: 204 });
    }

    const destroyedSessions = sid ? await destroyAuthSessionsBySid(sid) : 0;
    const result: FrontChannelLogoutResult = {
      destroyedSessions,
      issuer,
      sid: sid ?? undefined,
    };

    logger.info('Front-channel logout processed', { ...result });
    return new Response(null, {
      status: 204,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    logger.warn('Front-channel logout ignored', {
      error: getOAuthErrorMessage(error),
    });

    return new Response(null, { status: 204 });
  }
}

/**
 * Get current user from session
 */
export async function getUser(request: Request): Promise<UserInfo | null> {
  try {
    const sessionData = await getAuthSession(request);
    return sessionData.user || null;
  } catch (error) {
    logger.error('Failed to get user', error instanceof Error ? error : undefined);
    return null;
  }
}

/**
 * Require authenticated user (throws redirect to login if not authenticated)
 */
export async function requireAuth(request: Request): Promise<UserInfo> {
  const user = await getUser(request);

  if (!user) {
    const url = new URL(request.url);
    const returnUrl = `${url.pathname}${url.search}`;
    logger.info('No user found, starting OAuth flow', { hasReturnUrl: true });
    throw await login(request, returnUrl);
  }

  return user;
}

/**
 * Get access token from session
 */
export async function getAccessToken(request: Request): Promise<string | null> {
  try {
    const sessionData = await getAuthSession(request);
    return sessionData.accessToken || null;
  } catch (error) {
    logger.error('Failed to get access token', error instanceof Error ? error : undefined);
    return null;
  }
}

/**
 * Refresh tokens
 */
export async function refreshTokens(
  request: Request,
  refreshToken?: string
): Promise<TokenRefreshResult> {
  try {
    const sessionData = await getAuthSession(request);
    const tokenToRefresh = refreshToken || sessionData.refreshToken;

    if (!tokenToRefresh) {
      logger.warn('No refresh token available');
      return { success: false, error: 'No refresh token available', shouldLogout: true };
    }

    logger.info('Initiating token refresh');

    const oidcConfig = await getOAuthConfig();
    const refreshResult = await oidc.refreshTokenGrant(oidcConfig, tokenToRefresh);

    logger.info('Token refresh successful');

    const newRefreshToken = refreshResult.refresh_token || tokenToRefresh;
    const expiresAt = refreshResult.expires_in
      ? Date.now() + refreshResult.expires_in * 1000
      : sessionData.expiresAt;

    // Update session
    await updateAuthSession(request, {
      accessToken: refreshResult.access_token,
      refreshToken: newRefreshToken,
      idToken: refreshResult.id_token,
      expiresAt,
      lastActivity: Date.now(),
    });

    return {
      success: true,
      tokens: {
        access_token: refreshResult.access_token,
        refresh_token: newRefreshToken,
        id_token: refreshResult.id_token,
        expires_in: refreshResult.expires_in,
      },
    };
  } catch (error) {
    logger.error('Token refresh failed with exception', error instanceof Error ? error : undefined);

    return {
      success: false,
      error: getOAuthErrorMessage(error),
      shouldLogout: shouldLogoutAfterOAuthError(error),
    };
  }
}

// Re-export session validation
export { isSessionValid };

/**
 * Clear auth server cache (useful for testing)
 */
export function clearAuthServerCache(): void {
  authServerCache = null;
  jwksCache.clear();
}
