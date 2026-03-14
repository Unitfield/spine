/**
 * Tenant Types
 */

export interface TenantInfo {
  id: string;
  name?: string;
  role?: string;
}

export interface TenantMembership {
  tenantId: string;
  tenantName?: string;
  tenantSlug?: string | null;
  organizationName?: string;
  role?: string;
  roles?: string[];
  ownerUserId?: string | null;
  isOwner?: boolean;
}

export interface OrganizationBranding {
  logoUrl?: string | null;
  themePrimary?: string | null;
  themeMode?: string | null;
  emailBranding?: string | null;
}

export interface OrganizationData {
  organizationId: string;
  name: string;
  slug?: string | null;
  timeZone?: string | null;
  currency?: string | null;
  branding?: OrganizationBranding | null;
  ownerUserId?: string | null;
  ownerAssignedAtUtc?: string | null;
  defaultOperatingAccountId?: string | null;
}

export interface TenantContextType {
  currentTenant: string | null;
  availableTenants: string[];
  memberships: Map<string, TenantMembership>;
  currentOrganization: OrganizationData | null;
  currentMembership: TenantMembership | null;
  organizations: Map<string, OrganizationData>;
  isLoading: boolean;
  switchTenant: (tenantId: string) => void;
  refreshTenants: () => void;
  refreshOrganization: () => void;
  getOrganization: (tenantId: string) => OrganizationData | null;
  getMembership: (tenantId: string) => TenantMembership | null;
  getTenantName: (tenantId: string) => string;
}
