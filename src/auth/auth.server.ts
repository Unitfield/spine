/**
 * OAuth2/OIDC Authentication Server Module
 * 
 * Bu modül OAuth2/OIDC authentication flow'unu yönetir:
 * - Login flow (PKCE)
 * - Token exchange
 * - Token refresh
 * - Logout
 * - Session management
 */

import * as oauth from 'oauth4webapi';
import { redirect } from 'react-router';

import {
  createAuthSession,
  getAuthSession,
  updateAuthSession,
  destroyAuthSession,
  isSessionValid,
  createOAuthState,
  getOAuthState,
  deleteOAuthState,
  AUTH_ERROR_COOKIE_PREFIX,
} from './redis-session-storage.server';
import type { 
  AuthConfig, 
  UserInfo, 
  SessionData, 
  OAuthState,
  TokenRefreshResult,
  LoginOptions,
  ApplicationType,
  AuthError
} from './types';
import { logger } from '../logging';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Get effective SSO logout setting based on config
 */
function getEffectiveSsoLogout(config: AuthConfig): boolean {
  // Explicit setting takes precedence
  if (config.ssoLogout !== undefined) {
    return config.ssoLogout;
  }
  
  // Determine by application type
  switch (config.applicationType) {
    case 'dashboard':
      return true; // Dashboard needs full logout (no landing page)
    case 'tenant-app':
      return false; // Tenant app uses app-specific logout
    default:
      return false; // Default to app-specific logout
  }
}

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
    case 'dashboard':
      return false; // Dashboard has no landing page
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
  if (appTypeEnv === 'dashboard') {
    applicationType = 'dashboard';
  } else if (appTypeEnv === 'tenant-app' || appTypeEnv === 'tenant_app') {
    applicationType = 'tenant-app';
  }

  // Parse boolean env vars
  const ssoLogout = process.env.OIDC_SSO_LOGOUT !== undefined
    ? process.env.OIDC_SSO_LOGOUT === 'true'
    : undefined;
    
  const hasLandingPage = process.env.OIDC_HAS_LANDING_PAGE !== undefined
    ? process.env.OIDC_HAS_LANDING_PAGE === 'true'
    : undefined;

  return {
    authority: requiredEnvVars.authority!,
    clientId: requiredEnvVars.clientId!,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    redirectUri: requiredEnvVars.redirectUri!,
    scope: process.env.OIDC_SCOPE || 'openid offline_access api',
    postLogoutRedirectUri: process.env.OIDC_POST_LOGOUT_REDIRECT_URI,
    applicationType,
    ssoLogout,
    hasLandingPage,
  };
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
  authorizationServer: oauth.AuthorizationServer;
  client: oauth.Client;
  cachedAt: number;
} | null = null;

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Get OAuth configuration with caching
 */
async function getOAuthConfig(): Promise<{
  authorizationServer: oauth.AuthorizationServer;
  client: oauth.Client;
}> {
  const config = getAuthConfig();
  const now = Date.now();

  if (authServerCache && now - authServerCache.cachedAt < CACHE_TTL) {
    return {
      authorizationServer: authServerCache.authorizationServer,
      client: authServerCache.client,
    };
  }

  try {
    const issuer = new URL(config.authority);
    const discoveryResponse = await oauth.discoveryRequest(issuer, {
      algorithm: 'oidc',
    });

    if (!discoveryResponse.ok) {
      const errorText = await discoveryResponse.text().catch(() => 'Unable to read response');
      logger.error('OAuth discovery error', undefined, { errorText });
      throw new Error(`OAuth discovery failed with status ${discoveryResponse.status}`);
    }

    const authorizationServer = await oauth.processDiscoveryResponse(issuer, discoveryResponse);

    const client: oauth.Client = {
      client_id: config.clientId,
    };

    authServerCache = {
      authorizationServer,
      client,
      cachedAt: now,
    };

    logger.info('OAuth discovery completed successfully');
    return { authorizationServer, client };
  } catch (error) {
    logger.error('OAuth discovery failed', error instanceof Error ? error : undefined);
    throw new Error(`OAuth discovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get client authentication method (None for public client with PKCE)
 */
function getClientAuth(): oauth.ClientAuth {
  return oauth.None();
}

// ============================================================================
// Claim Extraction
// ============================================================================

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
  // Extract tenant_ids
  let tenants: string[] = [];
  if ('tenant_ids' in claims) {
    const rawTenantIds = claims['tenant_ids'];
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

  // Extract tenant_roles
  const tenantRoles: Record<string, string[]> = {};
  if ('tenant_roles' in claims) {
    const rawRoles = claims['tenant_roles'];
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
  const permissions = 'app_perms' in claims ? toStringArray(claims['app_perms']) : [];

  // Extract onboarding status
  const isOnboarded = claims.is_onboarded === true || claims.is_onboarded === 'true';

  return { tenants, isOnboarded, tenantRoles, permissions };
}

// ============================================================================
// Session Data Creation
// ============================================================================

/**
 * Create session data from token result
 */
async function createSessionData(
  tokenResult: oauth.TokenEndpointResponse,
  claims: Record<string, unknown>
): Promise<Partial<SessionData>> {
  const baseUser: UserInfo = {
    sub: (claims.sub as string) || 'unknown',
    name: (claims.name as string) || (claims.email as string) || 'User',
    email: (claims.email as string) || undefined,
    givenName: (claims.given_name as string) || (claims.givenName as string),
    familyName: (claims.family_name as string) || (claims.familyName as string),
    picture: claims.picture as string,
    locale: claims.locale as string,
    zoneinfo: claims.zoneinfo as string,
    updated_at: claims.updated_at as number,
  };

  const expiresAt = tokenResult.expires_in
    ? Date.now() + tokenResult.expires_in * 1000
    : undefined;

  return {
    userId: baseUser.sub,
    accessToken: tokenResult.access_token,
    refreshToken: tokenResult.refresh_token,
    idToken: tokenResult.id_token,
    expiresAt,
    user: baseUser,
    lastActivity: Date.now(),
  };
}

// ============================================================================
// Auth Error Handling
// ============================================================================

// Auth error cookie names - unique per application to prevent conflicts
const AUTH_ERROR_COOKIE = `${AUTH_ERROR_COOKIE_PREFIX}_auth_error`;
const AUTH_ERROR_DESC_COOKIE = `${AUTH_ERROR_COOKIE_PREFIX}_auth_error_desc`;
const OAUTH_STATE_COOKIE = `${AUTH_ERROR_COOKIE_PREFIX}_oauth_state_id`;

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
  headers.append('Set-Cookie', `${AUTH_ERROR_COOKIE}=; Path=/; Max-Age=0`);
  headers.append('Set-Cookie', `${AUTH_ERROR_DESC_COOKIE}=; Path=/; Max-Age=0`);
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

    // Check for auth_error cookie to prevent redirect loops
    const cookies = request.headers.get('Cookie');
    const hasError = cookies?.includes(`${AUTH_ERROR_COOKIE}=`);
    if (hasError) {
      logger.warn('Auth error cookie detected, preventing redirect loop');
      // Clear the error cookie and redirect to home
      const headers = new Headers();
      headers.append('Set-Cookie', `${AUTH_ERROR_COOKIE}=; Path=/; Max-Age=0`);
      // Use redirectUri to get correct base URL with port
      const redirectUri = new URL(config.redirectUri);
      const baseUrl = redirectUri.origin;
      return redirect(baseUrl, { headers });
    }

    const { authorizationServer, client } = await getOAuthConfig();

    // Generate PKCE challenge
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

    // Generate secure state and nonce
    const state = oauth.generateRandomState();
    const nonce = oauth.generateRandomNonce();

    // Create OAuth state object
    const oauthState: OAuthState = {
      state,
      codeVerifier,
      nonce,
      returnUrl: options.returnUrl,
      createdAt: Date.now(),
    };

    logger.info('Creating OAuth state', { returnUrl: options.returnUrl, prompt: options.prompt });

    // Store OAuth state in Redis
    const stateId = await createOAuthState(oauthState);

    // Build authorization URL
    const authorizationUrl = new URL(authorizationServer.authorization_endpoint!);
    authorizationUrl.searchParams.set('client_id', client.client_id);
    authorizationUrl.searchParams.set('redirect_uri', config.redirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', config.scope);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set('nonce', nonce);
    
    // Add prompt parameter if specified
    if (options.prompt) {
      authorizationUrl.searchParams.set('prompt', options.prompt);
    }

    // Store stateId in cookie for callback (app-specific to prevent conflicts)
    const headers = new Headers();
    headers.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=${stateId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);

    // DEBUG: Log full authorization URL and config
    logger.info('🔍 DEBUG: OAuth login config', {
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      postLogoutRedirectUri: config.postLogoutRedirectUri,
      scope: config.scope,
      authority: config.authority,
      authorizationEndpoint: authorizationServer.authorization_endpoint,
      fullAuthUrl: authorizationUrl.toString()
    });

    logger.info('OAuth authorization flow initiated', { state, stateId, prompt: options.prompt });
    return redirect(authorizationUrl.toString(), { headers });
  } catch (error) {
    logger.error('Failed to initiate OAuth login', error instanceof Error ? error : undefined);
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

    // DEBUG: Log callback URL and params
    logger.info('🔍 DEBUG: OAuth callback received', {
      fullUrl: url.toString(),
      origin: url.origin,
      pathname: url.pathname,
      hasCode: !!code,
      hasState: !!state,
      error,
      errorDescription,
      clientId: config.clientId,
      redirectUri: config.redirectUri
    });

    // Handle OAuth errors
    if (error) {
      logger.error('OAuth callback error', undefined, { 
        error, 
        errorDescription,
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
          `${AUTH_ERROR_COOKIE}=access_denied; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`
        );
        headers.append(
          'Set-Cookie',
          `${AUTH_ERROR_DESC_COOKIE}=${encodeURIComponent(errorDescription || 'You do not have access to this application.')}; Path=/; SameSite=Lax; Max-Age=300`
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
        return redirect(`${baseUrl}/auth/login`, { headers });
      }
      
      // Handle login_required - session expired or user not logged in
      if (error === 'login_required') {
        logger.info('Login required, user session may have expired');
        const headers = await destroyAuthSession(request);
        // Use redirectUri to get correct base URL with port
        const redirectUri = new URL(config.redirectUri);
        const baseUrl = redirectUri.origin;
        return redirect(baseUrl, { headers });
      }
      
      // Handle other errors
      const headers = await destroyAuthSession(request);
      headers.append(
        'Set-Cookie',
        `${AUTH_ERROR_COOKIE}=${encodeURIComponent(error)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`
      );
      if (errorDescription) {
        headers.append(
          'Set-Cookie',
          `${AUTH_ERROR_DESC_COOKIE}=${encodeURIComponent(errorDescription)}; Path=/; SameSite=Lax; Max-Age=300`
        );
      }
      // Use redirectUri to get correct base URL with port
      const redirectUri = new URL(config.redirectUri);
      const baseUrl = redirectUri.origin;
      return redirect(baseUrl, { headers });
    }

    // Validate required parameters
    if (!code || !state) {
      throw new Error('Missing required callback parameters');
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

    if (oauthState.state !== state) {
      throw new Error(`OAuth state mismatch`);
    }

    // Check state age (10 minutes max)
    const stateAge = Date.now() - oauthState.createdAt;
    if (stateAge > 10 * 60 * 1000) {
      throw new Error('OAuth state expired');
    }

    const { authorizationServer, client } = await getOAuthConfig();
    const clientAuth = getClientAuth();

    logger.info('Initiating token exchange');

    // Validate authorization response
    const currentUrl = new URL(request.url);
    const callbackParameters = oauth.validateAuthResponse(
      authorizationServer,
      client,
      currentUrl,
      oauthState.state
    );

    // Exchange authorization code for tokens
    const tokenEndpointResponse = await oauth.authorizationCodeGrantRequest(
      authorizationServer,
      client,
      clientAuth,
      callbackParameters,
      config.redirectUri,
      oauthState.codeVerifier
    );

    if (!tokenEndpointResponse.ok) {
      const errorText = await tokenEndpointResponse.text().catch(() => 'Unable to read response');
      logger.error('Token endpoint error', undefined, { errorText });
      throw new Error('Token exchange failed');
    }

    // Process token response
    const tokenResult = await oauth.processAuthorizationCodeResponse(
      authorizationServer,
      client,
      tokenEndpointResponse,
      { expectedNonce: oauthState.nonce }
    );

    logger.info('Token exchange completed successfully');

    // Extract claims from ID token
    let claims: Record<string, unknown> = {};
    if (tokenResult.id_token) {
      try {
        const payload = tokenResult.id_token.split('.')[1];
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        claims = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      } catch (decodeError) {
        logger.error('Failed to decode ID token', decodeError instanceof Error ? decodeError : undefined);
        throw new Error('Invalid ID token received');
      }
    }

    // Create session data
    const newSessionData = await createSessionData(tokenResult, claims);

    // Create new session
    const sessionHeaders = await createAuthSession(request, newSessionData);

    // Clean up OAuth state from Redis
    await deleteOAuthState(stateId);

    // Combine headers and clear OAuth state cookie (app-specific)
    const headers = new Headers(sessionHeaders);
    headers.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

    logger.info('OAuth callback processed successfully');

    // Redirect to return URL or default location
    const redirectUrl = oauthState.returnUrl || '/';
    return redirect(redirectUrl, { headers });
  } catch (error) {
    logger.error('OAuth callback failed', error instanceof Error ? error : undefined);

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
 * Logout user
 * 
 * Backend uses id_token_hint to identify which tokens to revoke.
 * 
 * **Scenario 1: Full SSO Logout (Manual Sign Out)**
 * - Query param: sso_logout=true
 * - Result: Full logout + identity cookie cleared
 * - User must re-authenticate everywhere
 * 
 * **Scenario 2: Standard Logout (Automatic/Token Expired)**
 * - No sso_logout param
 * - Result: Tokens revoked based on id_token_hint
 * - Backend determines which tokens to revoke
 * 
 * Configuration:
 * - `OIDC_SSO_LOGOUT` env var ('true' | 'false') - default behavior
 * - Query param `sso_logout=true` - override for full logout
 */
export async function logout(request: Request): Promise<Response> {
  try {
    const config = getAuthConfig();
    const url = new URL(request.url);
    
    // Check for explicit sso_logout from query params
    const ssoLogout = url.searchParams.get('sso_logout') === 'true' || getEffectiveSsoLogout(config);
    const returnUrl = url.searchParams.get('returnUrl');
    
    logger.info('Logout initiated', { 
      clientId: config.clientId,
      ssoLogout
    });
    
    const sessionData = await getAuthSession(request);
    const idToken = sessionData.idToken;

    // Destroy local session
    const sessionHeaders = await destroyAuthSession(request);
    const headers = new Headers(sessionHeaders);

    // Store returnUrl in cookie if provided
    if (returnUrl) {
      headers.append(
        'Set-Cookie',
        `logout_return_url=${encodeURIComponent(returnUrl)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`
      );
    }

    // Redirect to OAuth end_session_endpoint if available
    if (idToken) {
      try {
        const { authorizationServer } = await getOAuthConfig();
        if (authorizationServer.end_session_endpoint) {
          const endSessionUrl = new URL(authorizationServer.end_session_endpoint);
          
          // Backend uses id_token_hint to identify which tokens to revoke
          endSessionUrl.searchParams.set('id_token_hint', idToken);
          
          // Add sso_logout for full SSO logout (clears identity cookie)
          if (ssoLogout) {
            endSessionUrl.searchParams.set('sso_logout', 'true');
            logger.info('Performing full SSO logout (identity cookie will be cleared)');
          } else {
            logger.info('Performing standard logout (tokens revoked based on id_token_hint)');
          }
          
          // Add post_logout_redirect_uri if configured
          if (config.postLogoutRedirectUri) {
            endSessionUrl.searchParams.set('post_logout_redirect_uri', config.postLogoutRedirectUri);
          }
          
          return redirect(endSessionUrl.toString(), { headers });
        }
      } catch {
        // Ignore OAuth logout errors
      }
    }

    // Fallback redirect
    const baseUrl = new URL(request.url).origin;
    const registeredPath = config.postLogoutRedirectUri || '/';
    const finalRedirectUrl = registeredPath.startsWith('http') 
      ? registeredPath 
      : `${baseUrl}${registeredPath}`;

    logger.info('Logout completed', { redirectUrl: finalRedirectUrl });
    return redirect(finalRedirectUrl, { headers });
  } catch (error) {
    logger.error('Logout failed', error instanceof Error ? error : undefined);
    const headers = await destroyAuthSession(request);
    return redirect('/', { headers });
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
    logger.info('No user found, starting OAuth flow', { returnUrl });
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

    const { authorizationServer, client } = await getOAuthConfig();
    const clientAuth = getClientAuth();

    logger.info('Initiating token refresh');

    const refreshResponse = await oauth.refreshTokenGrantRequest(
      authorizationServer,
      client,
      clientAuth,
      tokenToRefresh
    );

    if (!refreshResponse.ok) {
      const errorText = await refreshResponse.text().catch(() => 'Unknown error');
      logger.error('Token refresh failed', undefined, { status: refreshResponse.status, errorText });

      let errorData: Record<string, unknown> = {};
      try {
        errorData = JSON.parse(errorText);
      } catch {
        // Ignore parse errors
      }

      const shouldLogout =
        refreshResponse.status === 400 ||
        errorData.error === 'invalid_grant' ||
        errorData.error === 'invalid_token' ||
        refreshResponse.status === 401;

      return {
        success: false,
        error: `Token refresh failed: ${errorData.error_description || errorData.error || 'Unknown'}`,
        shouldLogout,
      };
    }

    const refreshResult = await oauth.processRefreshTokenResponse(
      authorizationServer,
      client,
      refreshResponse
    );

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

    const shouldLogout =
      error instanceof Error &&
      (error.message.includes('invalid_grant') ||
        error.message.includes('invalid_token') ||
        error.message.includes('unauthorized'));

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Token refresh failed',
      shouldLogout,
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
}
