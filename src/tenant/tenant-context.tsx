/**
 * Tenant Context Provider
 * 
 * React context for tenant management.
 */

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useTenantStore } from './tenant-store';
import type { OrganizationData, TenantContextType, TenantMembership } from './types';

const TenantContext = createContext<TenantContextType | null>(null);

interface TenantProviderProps {
  children: ReactNode;
  initialTenant?: string | null;
  initialTenants?: string[];
  initialMemberships?: TenantMembership[];
  onTenantChange?: () => void;
}

export function TenantProvider({
  children,
  initialTenant = null,
  initialTenants = [],
  initialMemberships = [],
  onTenantChange,
}: TenantProviderProps) {
  const currentTenant = useTenantStore((state) => state.currentTenant);
  const availableTenants = useTenantStore((state) => state.availableTenants);
  const memberships = useTenantStore((state) => state.memberships);
  const organizations = useTenantStore((state) => state.organizations);
  const isLoading = useTenantStore((state) => state.isLoading || state.isSwitching);
  const currentOrganization = useTenantStore((state) => state.getCurrentOrganization());
  const currentMembership = useTenantStore((state) => state.getCurrentMembership());

  const setCurrentTenant = useTenantStore((state) => state.setCurrentTenant);
  const setAvailableTenants = useTenantStore((state) => state.setAvailableTenants);
  const setMemberships = useTenantStore((state) => state.setMemberships);
  const switchTenantAction = useTenantStore((state) => state.switchTenant);
  const fetchOrganization = useTenantStore((state) => state.fetchOrganization);
  const getOrganization = useTenantStore((state) => state.getOrganization);
  const getMembership = useTenantStore((state) => state.getMembership);
  const getTenantName = useTenantStore((state) => state.getTenantName);

  // Initialize store with initial values
  useEffect(() => {
    if (initialTenant) {
      setCurrentTenant(initialTenant);
    }
    if (initialTenants.length > 0) {
      setAvailableTenants(initialTenants);
    }
    if (initialMemberships.length > 0) {
      setMemberships(initialMemberships);
    }
  }, [
    initialTenant,
    initialTenants.join(','),
    initialMemberships.map((membership) => membership.tenantId).join(','),
    setCurrentTenant,
    setAvailableTenants,
    setMemberships,
  ]);

  // Read tenant from cookie (client-side)
  useEffect(() => {
    const getCookieTenant = () => {
      const cookies = document.cookie.split(';');
      const tenantCookie = cookies.find((cookie) =>
        cookie.trim().startsWith('__active-org=')
      );

      if (tenantCookie) {
        const value = tenantCookie.split('=')[1];
        return decodeURIComponent(value);
      }

      return null;
    };

    if (!currentTenant) {
      const cookieTenant = getCookieTenant();
      if (cookieTenant && availableTenants.includes(cookieTenant)) {
        setCurrentTenant(cookieTenant);
      }
    }
  }, [currentTenant, availableTenants, setCurrentTenant]);

  // Switch tenant handler
  const switchTenant = (tenantId: string) => {
    switchTenantAction(tenantId).then(() => {
      if (onTenantChange) {
        onTenantChange();
      }
    });
  };

  // Refresh tenants (handled by identity context)
  const refreshTenants = () => {
    console.log('Tenant refresh requested - should be handled by identity context');
  };

  // Refresh organization
  const refreshOrganization = () => {
    if (currentTenant) {
      fetchOrganization(currentTenant);
    }
  };

  // Load organization data when tenant is set
  useEffect(() => {
    if (currentTenant && !currentOrganization) {
      refreshOrganization();
    }
  }, [currentTenant, currentOrganization]);

  const value: TenantContextType = {
    currentTenant,
    availableTenants,
    memberships,
    currentOrganization,
    currentMembership,
    organizations,
    isLoading,
    switchTenant,
    refreshTenants,
    refreshOrganization,
    getOrganization,
    getMembership,
    getTenantName,
  };

  return (
    <TenantContext.Provider value={value}>
      {children}
    </TenantContext.Provider>
  );
}

/**
 * Hook for using tenant context
 */
export function useTenant(): TenantContextType {
  const context = useContext(TenantContext);

  if (!context) {
    throw new Error('useTenant must be used within a TenantProvider');
  }

  return context;
}

/**
 * Hook for current tenant only
 */
export function useCurrentTenant(): string | null {
  const { currentTenant } = useTenant();
  return currentTenant;
}

/**
 * Hook for tenant switching
 */
export function useTenantSwitcher() {
  const { switchTenant, isLoading, availableTenants } = useTenant();
  return { switchTenant, isLoading, availableTenants };
}

/**
 * Hook for current organization
 */
export function useCurrentOrganization(): OrganizationData | null {
  const { currentOrganization } = useTenant();
  return currentOrganization;
}

/**
 * Hook for organization operations
 */
export function useOrganization() {
  const { currentOrganization, refreshOrganization, isLoading } = useTenant();

  return {
    organization: currentOrganization,
    refreshOrganization,
    isLoading,
  };
}
