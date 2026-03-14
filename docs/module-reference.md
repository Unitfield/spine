# Module Reference

This is a high-level reference for Mimir's public surfaces.

## Auth

Server entry point:

- `@eminuckan/mimir-core/auth/server`
- `@eminuckan/mimir-core/server`
- `@eminuckan/mimir-core/react-router/server`

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

- `@eminuckan/mimir-core/tenant`

Server entry point:

- `@eminuckan/mimir-core/tenant/server`

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

- `@eminuckan/mimir-core/identity`

Server entry point:

- `@eminuckan/mimir-core/identity/server`

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

- `@eminuckan/mimir-core/permissions`

Server entry point:

- `@eminuckan/mimir-core/server`

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

- `@eminuckan/mimir-core/api-client`

Server entry point:

- `@eminuckan/mimir-core/api-client/server`

Key server exports:

- `createAPIConfigFactory`
- `setupAxiosInterceptors`
- `createEnhancedClient`

## Query Client

Entry point:

- `@eminuckan/mimir-core/query-client`

Key exports:

- `createQueryClient`
- `cachePresets`
- `createQueryKeyFactory`
- `invalidationHelpers`

## Logging

Entry point:

- `@eminuckan/mimir-core/logging`

The logging module provides typed logger configuration and a default service-level logger.

## SignalR

Entry point:

- `@eminuckan/mimir-core/signalr`

Use this module for generic realtime client helpers and types.
