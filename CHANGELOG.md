# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

No unreleased changes.

## [0.3.1] - 2026-06-01

### Changed

- Clarified README positioning, backend contract guidance, and quick-start snippets for the open source package.

## [0.3.0] - 2026-06-01

### Added

- Added a public-surface check that blocks private project names and app-specific authorization hints from the public package.
- Added per-login allowlists for app-specific OIDC authorization parameters and public state UI context.
- Added Keycloak-compatible back-channel and front-channel logout handlers.
- Added Redis session indexes by user, OIDC `sid`, and legacy `session_state`.
- Added session listing and destroy primitives for current-user, all-user, `sid`, and `session_state` cleanup.
- Added OIDC client authentication method configuration for public and confidential clients.
- Added generic tenant, identity, permission, access, and API configuration surfaces for custom SaaS backend contracts.
- Added Vitest coverage for authorization parameters, access evaluation, permissions, tenant state, identity state, and API header configuration.
- Added React Router SaaS example app, installation docs, adapter docs, roadmap, maintainer notes, and Codex maintenance plan.
- Added an adapter request issue template for framework and provider integrations.

### Changed

- Switched server-side auth from direct `oauth4webapi` calls to `openid-client`.
- Removed built-in product-flow redirects from route protection; consuming apps now own all setup, billing, and tenant workflow routing through `configureRouteProtection`.
- Changed built-in package defaults from legacy project branding to Spine-oriented defaults.
- Made default logout RP-Initiated Logout and kept app-local cleanup explicit with `logout=local`.
- Removed `offline_access` from the default scope; apps can opt in explicitly if they need long-lived refresh tokens.
- Updated CI and release validation to run the full `pnpm check` gate.

## [0.2.4] - 2026-04-25

### Fixed

- Allow HTTP OIDC requests for localhost issuers in non-production environments.
- Keep insecure OIDC requests disabled unconditionally in production.

## [0.2.3] - 2026-04-25

### Fixed

- Added richer OIDC discovery diagnostics, including the resolved discovery URL.
- Avoid sending stale `id_token_hint` values to a new OIDC provider during provider migrations.

## [0.2.0] - 2026-03-15

### Added

- Added framework-agnostic permission route protection primitives.
- Added configurable tenant cookie policy in core.
- Added generic server-side identity context resolution helpers.
- Added React Router adapter entry points.
- Added open source contributor documentation, security policy, and repository scaffolding.

### Changed

- Moved tenant, identity, and permission server orchestration out of the dashboard app and into Spine.
- Expanded tenant primitives to support membership-aware state.
- Updated package metadata for a fresh public open source release.
- Rewrote README around the current adapter-based architecture.
- Renamed remaining package-level branding defaults from legacy product names to Spine-oriented names where appropriate.

## [0.1.16] - 2026-02-28

### Changed

- Switched publishing target to npmjs.org with public access.
- Updated README package references and publishing instructions for npm public releases.
- Included `LICENSE` in published package files.

## [0.1.2] - 2025-12-05

### Added

- Added `REDIS_KEY_PREFIX` support for Redis session storage.

## [0.1.1] - 2025-12-05

### Fixed

- Fixed author field encoding issue in `package.json`.

## [0.1.0] - 2025-12-04

### Added

- Initial release of Spine.
