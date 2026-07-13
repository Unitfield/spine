/**
 * Auth Types
 */

/**
 * Application Type
 * Describes app UX shape for login/error handling.
 */
export type ApplicationType =
  | 'no-landing-page'
  | 'landing-page'
  | 'dashboard'
  | 'tenant-app'
  | 'custom';

export type OidcClientAuthMethod =
  | 'none'
  | 'client_secret_post'
  | 'client_secret_basic';

/**
 * OAuth Configuration
 */
export interface AuthConfig {
  authority: string;
  clientId: string;
  clientSecret?: string;
  clientAuthMethod?: OidcClientAuthMethod;
  redirectUri: string;
  postLogoutRedirectUri?: string;
  scope: string;
  
  /**
   * Application type - determines landing/error handling only.
   * Logout scope is request intent:
   * - default `/auth/logout`: RP-Initiated Logout at the identity provider
   * - `/auth/logout?logout=local`: application session cleanup only
   *
   * Aliases:
   * - 'dashboard': Legacy alias for 'no-landing-page'
   * - 'tenant-app': Legacy alias for 'landing-page'
   * @default 'custom'
   */
  applicationType?: ApplicationType;
  
  /**
   * Whether the application has a landing page
   * - true: Has landing page - OAuth errors redirect to home, user sees landing
   * - false: No landing page - Must handle OAuth errors specially to avoid loops
   * 
   * If not set, determined by applicationType:
   * - 'no-landing-page': false
   * - 'landing-page': true
   * - 'dashboard': false (legacy alias)
   * - 'tenant-app': true (legacy alias)
   * - 'custom': true (default)
   */
  hasLandingPage?: boolean;
}

/**
 * Configurable claim mapping for adapting auth/session extraction
 * to different identity providers and backend conventions.
 */
export interface AuthClaimMapping {
  subject?: string[];
  name?: string[];
  email?: string[];
  givenName?: string[];
  familyName?: string[];
  picture?: string[];
  locale?: string[];
  zoneinfo?: string[];
  updatedAt?: string[];
  tenantIds?: string[];
  tenantRoles?: string[];
  permissions?: string[];
  isOnboarded?: string[];
}

/**
 * User Info from OAuth provider
 */
export interface UserInfo {
  sub: string;
  name?: string;
  email?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  locale?: string;
  zoneinfo?: string;
  updated_at?: number;
  [key: string]: unknown;
}

/**
 * OAuth State for PKCE flow
 */
export interface OAuthState {
  state: string;
  codeVerifier: string;
  nonce?: string;
  returnUrl?: string;
  /** Keycloak application initiated action requested for this authorization flow. */
  kcAction?: string;
  createdAt: number;
}

/**
 * Session Data stored in Redis
 */
export interface SessionData {
  sessionId?: string;
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  issuer?: string;
  sid?: string;
  sessionState?: string;
  clientId?: string;
  ipAddress?: string;
  userAgent?: string;
  user?: UserInfo;
  createdAt?: number;
  lastActivity?: number;
}

export interface AuthSessionSummary {
  sessionId: string;
  userId?: string;
  email?: string;
  name?: string;
  issuer?: string;
  sid?: string;
  sessionState?: string;
  clientId?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt?: number;
  lastActivity?: number;
  expiresAt?: number;
  isCurrent?: boolean;
}

export interface BackChannelLogoutResult {
  destroyedSessions: number;
  issuer?: string;
  subject?: string;
  sid?: string;
}

export interface FrontChannelLogoutResult {
  destroyedSessions: number;
  issuer?: string;
  sid?: string;
}

/**
 * Session Flash Data for temporary messages
 */
export interface SessionFlashData {
  error: string;
  success: string;
}

/**
 * Token refresh result
 */
export interface TokenRefreshResult {
  success: boolean;
  newAccessToken?: string;
  tokens?: {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  error?: string;
  shouldLogout?: boolean;
}

/**
 * Route protection levels
 */
export type ProtectionLevel = 
  | 'public' 
  | 'auth'
  | 'policy'
  /** @deprecated Use policy with configureRouteProtection instead. */
  | 'onboarding-required'
  /** @deprecated Use policy with configureRouteProtection instead. */
  | 'subscription-required';

/**
 * Protected route loader function type
 */
export type ProtectedLoaderFn<T> = (user?: UserInfo) => Promise<T> | T;

export type PublicAuthorizationStateContext = Record<
  string,
  string | number | boolean | null | undefined
>;

/**
 * Login options
 */
export interface LoginOptions {
  /**
   * Return URL after successful login.
   *
   * Spine accepts local paths and same-origin absolute URLs, which are stored
   * as local paths. Unsafe or malformed destinations fall back to `/`.
   */
  returnUrl?: string;
  /** OAuth prompt parameter (none, login, consent, select_account, create) */
  prompt?: 'none' | 'login' | 'consent' | 'select_account' | 'create';
  /**
   * Additional authorization request parameters.
   *
   * Use this for safe provider hints: `login_hint`, `ui_locales`,
   * `acr_values`, `kc_idp_hint`, or app-specific provider hints allowed by
   * `extraAuthParamNames` / `extraAuthParamPrefixes`.
   * Security-sensitive protocol parameters such as state, nonce, redirect_uri,
   * scope, PKCE, prompt, and kc_action are managed by Spine and cannot be
   * overridden.
   */
  extraAuthParams?: Record<string, string | number | boolean | null | undefined>;
  /**
   * Additional non-sensitive authorization parameter names allowed for this
   * login request. Use this for app-specific identity-provider theme hints.
   */
  extraAuthParamNames?: string[];
  /**
   * Additional non-sensitive authorization parameter prefixes allowed for this
   * login request. Prefixes should be narrow and app-owned.
   */
  extraAuthParamPrefixes?: string[];
  /**
   * Optional public, non-secret UI context appended to the OAuth state value.
   * This exists for identity-provider themes that need display hints while the
   * server still validates the full exact state value during callback handling.
   */
  publicStateContext?: PublicAuthorizationStateContext;
  /**
   * Keycloak application initiated action.
   *
   * Example: `webauthn-register` starts native passkey registration.
   * This is Keycloak-specific and is ignored by non-Keycloak providers.
   */
  kcAction?: string;
}

/**
 * Auth error information from OAuth callback
 */
export interface AuthError {
  /** Error code (e.g., 'access_denied', 'login_required') */
  error: string;
  /** Human-readable error description */
  description?: string;
}
