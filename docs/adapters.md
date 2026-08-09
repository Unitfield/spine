# Adapters

Spine keeps framework-specific behavior behind adapter entry points.

## Why Adapters Exist

Core primitives should not know about:

- React Router redirects
- Next.js request helpers
- Remix data APIs
- framework-specific response classes

Adapters solve that by providing a framework-shaped surface without polluting the core package.

## Current Adapters

### React Router

Available entry points:

- `@eminuckan/spine/react-router`
- `@eminuckan/spine/react-router/server`

Today these are thin aliases over the core exports. That is intentional.

Benefits:

- apps can import from a framework-named namespace today
- adapter-specific helpers can be added later without changing import strategy
- future adapters can follow the same pattern

### TanStack Start

Available entry points:

- `@eminuckan/spine/tanstack-start`
- `@eminuckan/spine/tanstack-start/server`

These are also thin aliases over the framework-neutral client and server
exports. Spine does not import `@tanstack/react-start`, `@tanstack/react-router`,
or expose `createServerFn`/`createFileRoute` from its adapter. TanStack Start
server functions, middleware, route handlers, redirects, and CSRF configuration
remain owned by the consuming app.

Keep server-only request access inside the app-owned function module and return
only a safe projection across the RPC boundary:

```ts
// app/lib/viewer.functions.ts
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { authRoute } from '@eminuckan/spine/tanstack-start/server';

export const getViewerStatus = createServerFn({ method: 'GET' }).handler(() =>
  authRoute(getRequest(), () => ({ authenticated: true })),
);
```

Use server routes for HTTP auth endpoints and return Spine's native
`Response` unchanged so status, redirects, and repeated `Set-Cookie` headers
survive the framework boundary:

```ts
// app/routes/auth.callback.tsx
import { createFileRoute } from '@tanstack/react-router';
import { handleCallback } from '@eminuckan/spine/tanstack-start/server';

export const Route = createFileRoute('/auth/callback')({
  server: {
    handlers: {
      GET: ({ request }) => handleCallback(request),
    },
  },
});
```

For a normal callback with a non-empty `code` and `state`, a missing or
expired local OAuth transaction is exposed as `OAuthCallbackError` with
`isRecoverableOAuthCallbackError(error) === true`. The consuming adapter owns
loop prevention: record a signed one-shot retry marker, start at most one new
`login` flow, and render a terminal error on a second stale callback. Never
retry state mismatches, malformed callbacks, provider/access errors,
token-exchange failures, storage/configuration failures, or application
actions. When handling a typed failure, append every value from
`error.cleanupSetCookies` (or iterate `error.cleanupHeaders`) so repeated
`Set-Cookie` headers are not collapsed.

Do not return `SessionData`, access tokens, refresh tokens, or raw request
context from a server function or route. Keep tenant membership checks and
product-specific redirects in the app-owned wrapper, and configure TanStack
Start's CSRF middleware when the app defines a custom `src/start.ts`.

## Import Strategy

### Use root/core imports when

- you are building reusable adapter-agnostic logic
- you are inside a package that should not know the framework

### Use framework adapter imports when

- you are writing app-facing framework integration code
- you want framework intent to be obvious in the import path

Example:

```ts
import { authRoute, getAccessToken } from '@eminuckan/spine/react-router/server';
```

## Writing a New Adapter

A future adapter package should:

1. Re-export the relevant core/client or core/server APIs
2. Add framework-specific convenience helpers only when they reduce real boilerplate
3. Avoid duplicating business logic already present in core
4. Keep product-specific decisions out of the adapter

## What Should Not Go Into an Adapter

- product-specific setup routes
- tenant-specific marketing flows
- billing or entitlement plan assumptions
- app-specific permission constants

Those belong in the consuming application.

## Next.js Direction

The likely future shape is:

- `@eminuckan/spine/nextjs`
- `@eminuckan/spine/nextjs/server`

The goal would be the same:

- map Spine core to Next.js primitives
- keep reusable infrastructure in core
- keep app policy local

## Adapter Checklist

Before adding framework code to Spine, ask:

- Is this actually framework-specific?
- Does it belong in an adapter instead of core?
- Can the same problem be solved with configuration first?
- Is the helper generic across many apps using that framework?
