/**
 * Identity Context Provider
 * 
 * Initializes the identity store and listens to SignalR events.
 */

import { useEffect, type ReactNode } from 'react';
import { useIdentityStore } from './identity-store';
import type { IdentityContextData, IdentityContextChangedEvent } from './types';

interface IdentityContextProviderProps {
  children: ReactNode;
  initialContext?: Partial<IdentityContextData>;
  accessToken?: string | null;
  signalRClient?: {
    onIdentityContextChanged: (handler: (event: IdentityContextChangedEvent) => void) => () => void;
    disconnect: () => Promise<void>;
  };
}

export function IdentityContextProvider({
  children,
  initialContext,
  accessToken,
  signalRClient,
}: IdentityContextProviderProps) {
  const setContext = useIdentityStore((state) => state.setContext);
  const refreshContext = useIdentityStore((state) => state.refreshContext);
  const refreshPermissions = useIdentityStore((state) => state.refreshPermissions);
  const contextVersion = useIdentityStore((state) => state.context.contextVersion);

  // Initialize store with initial context from server
  useEffect(() => {
    if (initialContext) {
      setContext(initialContext);
    }
  }, [initialContext, setContext]);

  // Handle SignalR identity context changes
  useEffect(() => {
    if (!signalRClient) return;

    const handleContextChange = (event: IdentityContextChangedEvent) => {
      console.log('Identity context changed via SignalR:', event);

      if (event.contextVersion > (contextVersion ?? 0)) {
        console.log('Refreshing context due to SignalR event...');

        if (event.reason === 'PermissionsChanged' || event.reason === 'RoleAssignmentChanged') {
          console.log('Permission-specific change detected, refreshing permissions only...');
          refreshPermissions();
        } else {
          refreshContext();
        }
      }
    };

    const unsubscribe = signalRClient.onIdentityContextChanged(handleContextChange);

    return unsubscribe;
  }, [accessToken, contextVersion, refreshContext, refreshPermissions, signalRClient]);

  // Initial context load if not provided
  useEffect(() => {
    if (!initialContext) {
      refreshContext();
    }
  }, [initialContext, refreshContext]);

  // Cleanup SignalR on unmount
  useEffect(() => {
    return () => {
      if (signalRClient) {
        signalRClient.disconnect().catch((error) => {
          console.error('Error disconnecting SignalR:', error);
        });
      }
    };
  }, [signalRClient]);

  return <>{children}</>;
}
