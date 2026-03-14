# Module Reference

This is a high-level reference for Spine's public surfaces.

## Auth

Server entry point:

- `@eminuckan/spine/auth/server`
- `@eminuckan/spine/server`
- `@eminuckan/spine/react-router/server`

Key exports:

- `login`
- `handleCallback`
- `logout`
- `getUser`
- `requireAuth`
- `getAccessToken`
- `refreshTokens`
- `getAuthSession`
- `updateAuthSession`
- `destroyAuthSession`
- `configureAuthClaimMapping`
- `resetAuthClaimMapping`
- `configureRouteProtection`
- `authRoute`
- `publicRoute`
- `onboardingRoute`
- `subscriptionRoute`

## Tenant

Client entry point:

- `@eminuckan/spine/tenant`

Server entry point:

- `@eminuckan/spine/tenant/server`

Key client exports:

- `TenantProvider`
- `useTenant`
- `useCurrentTenant`
- `useCurrentOrganization`
- `useOrganization`
- `useTenantStore`
- `initializeTenantStore`
- `configureTenantEndpoints`

Key server exports:

- `configureTenantCookie`
- `resetTenantCookieConfig`
- `getActiveTenant`
- `setActiveTenant`
- `clearActiveTenant`
- `configureIdentityContextFetcher`
- `getCurrentTenant`
- `getAvailableTenants`
- `initializeTenant`
- `setCurrentTenant`
- `clearCurrentTenant`

## Identity

Client entry point:

- `@eminuckan/spine/identity`

Server entry point:

- `@eminuckan/spine/identity/server`

Key client exports:

- `IdentityContextProvider`
- `useIdentityStore`
- `useIdentityContext`
- `useIsOnboarded`
- `useHasSubscription`
- `useUserTenants`
- `useUserPermissions`
- `configureIdentityStore`
- `configureIdentityEndpoints`

Key server exports:

- `configureIdentityAPIFetcher`
- `configurePermissionFetcher`
- `fetchIdentityContext`
- `getIdentityContext`
- `fetchUserPermissions`
- `contextToUserInfo`
- `clearIdentityContextCache`
- `hasContextVersionChanged`
- `updateContextVersion`

## Permissions

Client entry point:

- `@eminuckan/spine/permissions`

Server entry point:

- `@eminuckan/spine/server`

Key client exports:

- `usePermissionStore`
- `initializePermissions`
- `getPermissionChecker`
- `getPermissions`
- `usePermission`
- `useHasPermission`
- `usePermissions`
- `useHasPermissions`
- `useModulePermission`
- `useHasModulePermission`
- `usePermissionChecker`
- `useAllPermissions`
- `ProtectedButton`
- `ProtectedLink`
- `ProtectedSection`
- `ProtectedAction`

Key server exports:

- `configurePermissionRouteProtection`
- `resetPermissionRouteProtection`
- `requirePermission`
- `checkPermission`
- `withPermission`

## API Client

Client entry point:

- `@eminuckan/spine/api-client`

Server entry point:

- `@eminuckan/spine/api-client/server`

Key server exports:

- `createAPIConfigFactory`
- `setupAxiosInterceptors`
- `createEnhancedClient`

## Query Client

Entry point:

- `@eminuckan/spine/query-client`

Key exports:

- `createQueryClient`
- `cachePresets`
- `createQueryKeyFactory`
- `invalidationHelpers`

## Logging

Entry point:

- `@eminuckan/spine/logging`

The logging module provides typed logger configuration and a default service-level logger.

## SignalR

Entry point:

- `@eminuckan/spine/signalr`

Use this module for generic realtime client helpers and types.
