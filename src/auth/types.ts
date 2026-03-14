/**
 * Auth Types
 */

/**
 * Application Type
 * Determines logout behavior and error handling
 */
export type ApplicationType =
  | 'no-landing-page'
  | 'landing-page'
  | 'dashboard'
  | 'tenant-app'
  | 'custom';

/**
 * OAuth Configuration
 */
export interface AuthConfig {
  authority: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  postLogoutRedirectUri?: string;
  scope: string;
  
  /**
   * Application type - determines logout behavior
   * - 'no-landing-page': No landing page, defaults to full SSO logout
   * - 'landing-page': Has a landing page, defaults to app-specific logout
   * - 'dashboard': Legacy alias for 'no-landing-page'
   * - 'tenant-app': Legacy alias for 'landing-page'
   * - 'custom': Use explicit ssoLogout setting
   * @default 'custom'
   */
  applicationType?: ApplicationType;
  
  /**
   * Whether to perform full SSO logout (clear identity cookie) or app-specific logout
   * - true: Full logout - clears identity cookie, revokes all tokens
   * - false: App-specific logout - keeps identity cookie, revokes only this app's tokens
   * 
   * If not set, determined by applicationType:
   * - 'no-landing-page': true (full logout)
   * - 'landing-page': false (app-specific)
   * - 'dashboard': true (legacy alias)
   * - 'tenant-app': false (legacy alias)
   * - 'custom': false (default)
   */
  ssoLogout?: boolean;
  
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
  createdAt: number;
}

/**
 * Session Data stored in Redis
 */
export interface SessionData {
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  user?: UserInfo;
  lastActivity?: number;
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
  | 'onboarding-required' 
  | 'subscription-required';

/**
 * Protected route loader function type
 */
export type ProtectedLoaderFn<T> = (user?: UserInfo) => Promise<T> | T;

/**
 * Login options
 */
export interface LoginOptions {
  /** Return URL after successful login */
  returnUrl?: string;
  /** OAuth prompt parameter (none, login, consent, select_account) */
  prompt?: 'none' | 'login' | 'consent' | 'select_account';
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
