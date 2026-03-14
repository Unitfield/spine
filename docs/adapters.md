# Adapters

Spine keeps framework-specific behavior behind adapter entry points.

## Why Adapters Exist

Core primitives should not know about:

- React Router redirects
- Next.js request helpers
- Remix data APIs
- framework-specific response classes

Adapters solve that by providing a framework-shaped surface without polluting the core package.

## Current Adapter: React Router

Available entry points:

- `@eminuckan/spine/react-router`
- `@eminuckan/spine/react-router/server`

Today these are thin aliases over the core exports. That is intentional.

Benefits:

- apps can import from a framework-named namespace today
- adapter-specific helpers can be added later without changing import strategy
- future adapters can follow the same pattern

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

- product-specific onboarding routes
- tenant-specific marketing flows
- subscription plan assumptions
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
