/**
 * Auth Types
 */

/**
 * Application Type
 * Determines logout behavior and error handling
 */
export type ApplicationType = 'dashboard' | 'tenant-app' | 'custom';

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
   * - 'dashboard': No landing page, uses sso_logout=true for full logout
   * - 'tenant-app': Has landing page, app-specific logout (keeps identity cookie)
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
   * - 'dashboard': true (full logout)
   * - 'tenant-app': false (app-specific)
   * - 'custom': false (default)
   */
  ssoLogout?: boolean;
  
  /**
   * Whether the application has a landing page
   * - true: Has landing page - OAuth errors redirect to home, user sees landing
   * - false: No landing page - Must handle OAuth errors specially to avoid loops
   * 
   * If not set, determined by applicationType:
   * - 'dashboard': false (no landing page)
   * - 'tenant-app': true (has landing page)
   * - 'custom': true (default)
   */
  hasLandingPage?: boolean;
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
