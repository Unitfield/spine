/**
 * Identity Types
 * 
 * Generic identity context types that can be used with any backend.
 * All fields are optional to support different backend implementations.
 */

/**
 * Address data for user profile
 */
export interface AddressData {
  addressId?: string;
  type?: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isPrimary?: boolean;
  attention?: string | null;
  region?: string | null;
}

/**
 * Tenant/Organization membership information
 */
export interface TenantMembership {
  /** Unique tenant identifier */
  tenantId: string;
  /** Display name of the tenant/organization */
  tenantName?: string;
  /** URL-friendly slug for the tenant */
  tenantSlug?: string | null;
  /** @deprecated Use tenantName instead */
  organizationName?: string;
  /** User's role in this tenant (single role) */
  role?: string;
  /** User's roles in this tenant (multiple roles) */
  roles?: string[];
  /** Owner user ID if this is an owned tenant */
  ownerUserId?: string | null;
  /** Whether current user is the owner of this tenant */
  isOwner?: boolean;
}

/**
 * Core identity context data
 * 
 * This interface is designed to be flexible and work with various backend implementations.
 * Only the fields your backend returns need to be populated.
 */
export interface IdentityContextData {
  // === User Profile (Core) ===
  /** Unique user identifier */
  userId?: string;
  /** User's email address */
  email?: string;
  /** User's first name */
  firstName?: string | null;
  /** User's last name */
  lastName?: string | null;
  /** User's display name (computed or custom) */
  displayName?: string | null;
  /** URL to user's profile image/avatar */
  profileImageUrl?: string | null;
  
  // === Contact & Localization ===
  /** User's phone number */
  phoneNumber?: string | null;
  /** User's timezone (e.g., "America/New_York") */
  timeZone?: string;
  /** User's preferred locale (e.g., "en-US") */
  locale?: string;
  /** User's addresses */
  addresses?: AddressData[];
  
  // === Membership & Tenant Context ===
  /** Whether user has any tenant membership */
  hasAnyMembership?: boolean;
  /** Whether user owns any tenant */
  hasOwnerMembership?: boolean;
  /** List of tenant IDs user belongs to */
  tenants?: string[];
  /** Currently active tenant ID */
  currentTenant?: string;
  /** Detailed membership information */
  memberships?: TenantMembership[];
  
  // === Onboarding & Status ===
  /** Whether user has completed onboarding */
  isOnboarded?: boolean;
  /** Whether user has an active subscription */
  hasSubscription?: boolean;
  /** Whether user's email is verified */
  emailVerified?: boolean;
  /** Whether 2FA is enabled */
  twoFactorEnabled?: boolean;
  
  // === Permissions & Roles ===
  /** User's permissions (for current tenant or global) */
  permissions?: string[];
  /** User's global roles */
  globalRoles?: string[];
  
  // === Context Metadata ===
  /** Version number for cache invalidation */
  contextVersion?: number;
  /** Loading state indicator */
  isLoading?: boolean;
  /** Last time context was updated */
  lastUpdated?: Date;
  
  // === Extensibility ===
  /** Additional custom data from backend */
  metadata?: Record<string, unknown>;
}

export interface IdentityContextChangedEvent {
  reason: string;
  tenantId?: string;
  triggeredByUserId?: string;
  contextVersion: number;
  timestamp: string;
}

export type IdentityContextChangeHandler = (event: IdentityContextChangedEvent) => void;
