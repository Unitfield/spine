# Architecture

This document describes how Mimir is structured and where each kind of logic should live.

## Goals

Mimir tries to solve a common problem in internal platform code:

- product A builds infrastructure
- product B copies it
- product C forks the copy
- shared behavior starts drifting

Mimir centralizes the reusable layer while keeping enough extension points for app-specific behavior.

## Layer Model

Mimir is organized into three layers:

1. Core primitives
2. Framework adapters
3. Application adapters

### 1. Core Primitives

Core primitives should:

- avoid framework-specific response helpers
- use standard Web `Request` and `Response` APIs
- expose configuration points for backend conventions
- stay reusable across multiple apps

Examples:

- token refresh
- session handling
- tenant cookie helpers
- identity cache
- permission checking
- API client configuration

### 2. Framework Adapters

Framework adapters make core primitives ergonomic in a specific framework.

Examples:

- `@eminuckan/mimir-core/react-router`
- `@eminuckan/mimir-core/react-router/server`

Today the React Router adapter is intentionally thin. That is a feature, not a gap: it keeps the core honest and leaves room for future adapters such as Next.js.

### 3. Application Adapters

Application adapters belong in the consuming app and translate Mimir into product policy.

Examples:

- onboarding route redirects
- subscription gating
- domain-specific permission constants
- generated backend API clients
- UI wrappers around generic hooks

## Module Responsibilities

### Auth

Owns:

- login
- callback handling
- logout
- token refresh
- Redis-backed session and OAuth state
- generic route protection primitives

Does not own:

- product-specific post-login routing
- onboarding flow decisions

### Tenant

Owns:

- tenant cookie primitives
- current tenant resolution
- available tenant resolution
- tenant client store and provider
- membership-aware tenant state

Does not own:

- product-specific no-tenant redirects
- organization creation flows

### Identity

Owns:

- identity context caching
- permission fetch orchestration
- transformation from identity context to tenant-aware user info
- client identity store and provider

Does not own:

- backend DTO generation
- product-specific onboarding data semantics beyond generic fields

### Permissions

Owns:

- client permission store
- permission hooks
- generic permission components
- generic server-side permission route protection

Does not own:

- your product's permission vocabulary
- domain-specific permission constants

### API Client

Owns:

- base URL and header composition
- auth header injection
- tenant header injection
- Axios interceptors
- retry and error handling

Does not own:

- generated SDK clients
- product-specific endpoint wrappers

## Composition Pattern

Mimir prefers configuration and composition over inheritance or deep factories.

The pattern is:

1. Core exposes a generic primitive
2. App provides fetchers, endpoint conventions, or redirect policies
3. App re-exports a thin local adapter if it wants ergonomic imports

This keeps the public API reusable without forcing all apps into the same workflow.

## Where New Code Should Go

Use this checklist before adding a new primitive.

### Put it in Core if

- it solves a repeated platform problem
- it can be configured instead of hardcoded
- it does not depend on a single app's domain
- it can be explained without referencing a product name

### Put it in a Framework Adapter if

- it depends on framework routing or request conventions
- it is still reusable across many apps using that framework

### Keep it in the App if

- it encodes product policy
- it references app-only routes
- it assumes app-only claims, plans, or workflows
- it is mostly a domain-specific convenience layer

## Current Tradeoffs

Mimir is already framework-agnostic at the request/response level, but not every module is maximally abstract yet. Some modules still use environment-driven configuration where factory-based configuration may eventually be better.

That is acceptable as long as:

- the surface remains reusable
- product logic stays outside core
- adapters remain thin

## Future Adapter Direction

The intended path is:

- keep root package framework-agnostic
- keep adapter packages shallow
- let apps build local adapters for product policy
- eventually add first-class Next.js support without changing the core mental model
