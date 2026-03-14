# Backend Adaptation

Spine should adapt to your backend, not force your backend to look like the original app it came from.

This guide covers the main extension points.

## Adaptation Categories

There are four major kinds of backend adaptation:

1. Auth claims
2. Identity endpoints
3. Permission resolution
4. Tenant conventions

## Auth Claim Mapping

Use `configureAuthClaimMapping` when your identity provider uses different claim names.

```ts
import { configureAuthClaimMapping } from '@eminuckan/spine/server';

configureAuthClaimMapping({
  subject: ['sub', 'user_id'],
  email: ['email', 'preferred_username'],
  givenName: ['given_name', 'first_name'],
  familyName: ['family_name', 'last_name'],
  permissions: ['permissions', 'scope'],
  tenantIds: ['tenant_ids', 'organizations'],
  tenantRoles: ['tenant_roles', 'organization_roles'],
  isOnboarded: ['is_onboarded', 'profile_complete'],
});
```

## Identity API Fetching

Use `configureIdentityAPIFetcher` to tell Spine how to fetch the current identity context.

```ts
import { configureIdentityAPIFetcher } from '@eminuckan/spine/identity/server';

configureIdentityAPIFetcher(async (request) => {
  const response = await fetch('https://api.example.com/me/context', {
    headers: {
      Authorization: request.headers.get('Authorization') ?? '',
    },
  });

  const payload = await response.json();

  return {
    userId: payload.user.id,
    email: payload.user.email,
    memberships: payload.memberships,
    hasAnyMembership: payload.memberships.length > 0,
    isOnboarded: payload.flags.isOnboarded,
    hasSubscription: payload.flags.hasSubscription,
    contextVersion: payload.version,
  };
});
```

## Permission Fetching

Use `configurePermissionFetcher` when permissions are loaded separately from identity context.

```ts
import { configurePermissionFetcher } from '@eminuckan/spine/identity/server';

configurePermissionFetcher(async (request, tenantId) => {
  const response = await fetch(`https://api.example.com/tenants/${tenantId}/permissions`, {
    headers: {
      Authorization: request.headers.get('Authorization') ?? '',
    },
  });

  const payload = await response.json();
  return payload.permissions;
});
```

## Client Identity Store Endpoints

Use `configureIdentityStore` if your app routes for identity context or logout differ.

```ts
import { configureIdentityStore } from '@eminuckan/spine/identity';

configureIdentityStore({
  contextEndpoint: '/api/me/context',
  permissionsEndpoint: '/api/me/permissions',
  logoutPath: '/session/logout',
});
```

You can also override the fetcher or unauthorized handling logic.

```ts
configureIdentityStore({
  fetcher: window.fetch.bind(window),
  onUnauthorized: ({ logoutPath }) => {
    window.location.assign(`${logoutPath}?reason=expired`);
  },
});
```

## Tenant Cookie Policy

Use `configureTenantCookie` to match your app's cookie requirements.

```ts
import { configureTenantCookie } from '@eminuckan/spine/tenant/server';

configureTenantCookie({
  name: '__active-org',
  httpOnly: false,
  sameSite: 'Lax',
  path: '/',
  secure: process.env.NODE_ENV === 'production',
});
```

This is especially useful when:

- the tenant cookie must be client-readable
- the cookie name differs across products
- secure/samesite behavior varies by deployment model

## Tenant Resolution

Use `configureIdentityContextFetcher` so tenant helpers can derive tenant state from your identity context.

```ts
import { configureIdentityContextFetcher } from '@eminuckan/spine/tenant/server';
import { fetchIdentityContext } from './identity.server';

configureIdentityContextFetcher(fetchIdentityContext);
```

## Route Protection Policy

Use `configureRouteProtection` for product-specific route policy that still belongs close to auth.

```ts
import { configureRouteProtection } from '@eminuckan/spine/server';

configureRouteProtection({
  getLoginReturnUrl: ({ request }) => new URL(request.url).pathname,
  resolveRoute: async ({ level, currentPath, identityContext }) => {
    if (level === 'auth' && identityContext?.isOnboarded === false) {
      return { redirectTo: '/onboarding' };
    }

    return null;
  },
});
```

Use this for framework/app coordination, not domain constants.

## Permission Route Protection

Use `configurePermissionRouteProtection` to tell Spine how to get the current session and permission context.

```ts
import { configurePermissionRouteProtection } from '@eminuckan/spine/server';

configurePermissionRouteProtection({
  getSession: async (request) => {
    return {
      user: { sub: '123' },
      accessToken: 'token',
    };
  },
  resolveContext: async () => {
    return {
      permissions: ['Identity.Users.View'],
      currentTenant: 'tenant-1',
    };
  },
});
```

## API Client Adaptation

Use `createAPIConfigFactory` to keep auth and tenant resolution centralized.

```ts
import { createAPIConfigFactory } from '@eminuckan/spine/api-client/server';

const { createAPIConfig, getAPIBaseURL } = createAPIConfigFactory(
  getAccessToken,
  getCurrentTenant,
  logger,
  {
    baseURL: process.env.API_BASE_URL,
    userAgent: 'MyApp/1.0',
  }
);
```

## Practical Rule

If the value could change from one backend to another, it should usually be configured.

Examples:

- claim names
- endpoint paths
- logout URLs
- cookie policies
- redirect decisions
- permission loading

If the logic is universal infrastructure, it should usually stay in core.
