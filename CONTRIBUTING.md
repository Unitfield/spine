# Contributing to Mimir Core

Thanks for contributing.

Mimir is intended to be a reusable foundation for SaaS infrastructure, so changes should optimize for clarity, composability, and portability across products.

## Before You Start

- Read [README.md](README.md)
- Read [docs/architecture.md](docs/architecture.md)
- Read [docs/backend-adaptation.md](docs/backend-adaptation.md)
- Check existing issues and pull requests first

## Local Setup

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm lint
```

## Project Structure

| Path | Purpose |
| --- | --- |
| `src/auth` | OAuth, sessions, token refresh, route protection |
| `src/tenant` | Tenant store, provider, cookie, and server helpers |
| `src/identity` | Identity cache, client store, and provider |
| `src/permissions` | Permission store, hooks, components, and server protection |
| `src/api-client` | API config factory, Axios setup, and retry/error helpers |
| `src/query-client` | TanStack Query defaults and utilities |
| `src/signalr` | Realtime client primitives |
| `src/logging` | Logging utilities |
| `src/react-router` | React Router adapter entry points |
| `docs` | Project documentation |

## Contribution Rules

- Keep core modules framework-agnostic unless the file is inside an adapter namespace
- Prefer configuration hooks over hardcoded product behavior
- Avoid shipping product-specific routes, claim names, endpoint paths, or UI assumptions into core
- Keep public APIs small and explicit
- Update documentation when behavior or public APIs change
- Add or update changelog entries for user-visible changes

## Adapter Philosophy

When deciding where code should live:

- Put it in core if it can work across multiple apps with configuration
- Put it in an adapter if it depends on framework primitives
- Keep it in the consuming app if it expresses product policy

Examples:

- Good for core: token refresh, tenant cookie utilities, permission checks, identity caching
- Good for adapters: framework-specific redirects, loader wrappers, request helpers
- Good for apps: onboarding redirects, subscription gating, domain permission constants

## Pull Request Checklist

- `pnpm typecheck` passes
- `pnpm build` passes
- Public API changes are documented
- Changelog is updated when needed
- No product-specific behavior leaked into core without a configuration escape hatch

## Commit Messages

Use concise, English commit messages.

Examples:

- `docs: rewrite README for open source release`
- `feat: add configurable permission route protection`
- `refactor: move tenant cookie policy into core config`

## Release Notes

Maintainers should also read [docs/releasing.md](docs/releasing.md).
