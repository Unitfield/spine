/**
 * Identity Store (Zustand)
 * 
 * Centralized state management for identity context.
 */

import { create } from 'zustand';
import type { IdentityContextData } from './types';

const initialContext: IdentityContextData = {
  hasAnyMembership: false,
  hasSubscription: false,
  isOnboarded: false,
  tenants: [],
  currentTenant: undefined,
  permissions: [],
  contextVersion: 0,
  isLoading: true,
  userId: undefined,
  email: undefined,
  firstName: undefined,
  lastName: undefined,
  displayName: undefined,
  profileImageUrl: undefined,
  phoneNumber: undefined,
  timeZone: undefined,
  addresses: undefined,
  hasOwnerMembership: false,
  memberships: undefined,
};

interface IdentityState {
  context: IdentityContextData;

  // Actions
  setContext: (context: Partial<IdentityContextData>) => void;
  refreshContext: () => Promise<void>;
  refreshPermissions: () => Promise<void>;
  reset: () => void;
}

export interface IdentityUnauthorizedDetails {
  reason: 'current-user-missing' | 'unauthorized';
  logoutPath: string;
  response?: Response;
}

export interface IdentityStoreConfig {
  contextEndpoint?: string;
  permissionsEndpoint?: string;
  logoutPath?: string;
  fetcher?: typeof fetch;
  onUnauthorized?: (details: IdentityUnauthorizedDetails) => void;
}

const DEFAULT_IDENTITY_STORE_CONFIG: Required<
  Pick<IdentityStoreConfig, 'contextEndpoint' | 'permissionsEndpoint' | 'logoutPath' | 'fetcher'>
> = {
  contextEndpoint: '/api/identity/context',
  permissionsEndpoint: '/api/identity/permissions',
  logoutPath: '/auth/logout',
  fetcher: (input, init) => fetch(input, init),
};

let identityStoreConfig: IdentityStoreConfig = {
  ...DEFAULT_IDENTITY_STORE_CONFIG,
};

function getIdentityStoreConfig(): IdentityStoreConfig & typeof DEFAULT_IDENTITY_STORE_CONFIG {
  return {
    ...DEFAULT_IDENTITY_STORE_CONFIG,
    ...identityStoreConfig,
  };
}

function handleUnauthorized(details: Omit<IdentityUnauthorizedDetails, 'logoutPath'>): void {
  const config = getIdentityStoreConfig();
  const unauthorizedDetails: IdentityUnauthorizedDetails = {
    ...details,
    logoutPath: config.logoutPath,
  };

  if (config.onUnauthorized) {
    config.onUnauthorized(unauthorizedDetails);
    return;
  }

  if (typeof window !== 'undefined') {
    window.location.href = config.logoutPath;
  }
}

/**
 * Configure the identity store for different app/back-end conventions.
 */
export function configureIdentityStore(config: IdentityStoreConfig): void {
  identityStoreConfig = {
    ...identityStoreConfig,
    ...config,
  };
}

/**
 * Reset identity store configuration to the built-in defaults.
 */
export function resetIdentityStoreConfig(): void {
  identityStoreConfig = {
    ...DEFAULT_IDENTITY_STORE_CONFIG,
  };
}

/**
 * Backward-compatible endpoint-only configuration helper.
 */
export function configureIdentityEndpoints(config: {
  contextEndpoint?: string;
  permissionsEndpoint?: string;
}): void {
  configureIdentityStore(config);
}

export const useIdentityStore = create<IdentityState>((set) => ({
  context: initialContext,

  setContext: (newContext) => {
    set((state) => ({
      context: {
        ...state.context,
        ...newContext,
        isLoading: false,
        lastUpdated: new Date(),
      },
    }));
  },

  refreshContext: async () => {
    try {
      const config = getIdentityStoreConfig();

      set((state) => ({
        context: { ...state.context, isLoading: true },
      }));

      const response = await config.fetcher(`${config.contextEndpoint}?refresh=true`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const newContext = await response.json();
        set({
          context: {
            ...newContext,
            isLoading: false,
            lastUpdated: new Date(),
          },
        });
        console.log('Identity context refreshed:', newContext);
      } else if (response.status === 404) {
        const errorData = await response.json().catch(() => ({}));
        if (errorData.code === 'CurrentUserMissing' || errorData.title === 'CurrentUserMissing') {
          console.error('CurrentUserMissing error - session is invalid, redirecting to logout');
          handleUnauthorized({
            reason: 'current-user-missing',
            response,
          });
          return;
        }
        console.error('Failed to refresh identity context:', response.status);
        set((state) => ({
          context: { ...state.context, isLoading: false },
        }));
      } else if (response.status === 401) {
        console.error('Identity context refresh returned 401, redirecting to logout');
        handleUnauthorized({
          reason: 'unauthorized',
          response,
        });
        return;
      } else {
        console.error('Failed to refresh identity context:', response.status);
        set((state) => ({
          context: { ...state.context, isLoading: false },
        }));
      }
    } catch (error) {
      console.error('Error refreshing identity context:', error);
      set((state) => ({
        context: { ...state.context, isLoading: false },
      }));
    }
  },

  refreshPermissions: async () => {
    try {
      const config = getIdentityStoreConfig();

      console.log('Refreshing permissions...');

      const response = await config.fetcher(config.permissionsEndpoint, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const result = await response.json();
        const permissions = result.data?.permissions || [];

        set((state) => ({
          context: {
            ...state.context,
            permissions,
            lastUpdated: new Date(),
          },
        }));

        console.log('Permissions refreshed:', {
          count: permissions.length,
        });
      } else if (response.status === 401) {
        console.error('Permissions refresh returned 401, redirecting to logout');
        handleUnauthorized({
          reason: 'unauthorized',
          response,
        });
      } else {
        console.error('Failed to refresh permissions:', response.status);
      }
    } catch (error) {
      console.error('Error refreshing permissions:', error);
    }
  },

  reset: () => {
    set({ context: initialContext });
  },
}));

// Convenience selectors
export const useIsOnboarded = () => useIdentityStore((state) => state.context.isOnboarded);
export const useHasSubscription = () => useIdentityStore((state) => state.context.hasSubscription);
export const useUserTenants = () =>
  useIdentityStore((state) => ({
    tenants: state.context.tenants,
    currentTenant: state.context.currentTenant,
  }));
export const useUserPermissions = () => useIdentityStore((state) => state.context.permissions);
export const useIdentityContext = () => {
  const context = useIdentityStore((state) => state.context);
  const refreshContext = useIdentityStore((state) => state.refreshContext);
  const refreshPermissions = useIdentityStore((state) => state.refreshPermissions);

  return { context, refreshContext, refreshPermissions };
};
