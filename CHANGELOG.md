# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

No unreleased changes.

## [0.3.12] - 2026-11-05

### Added

- Added a server-only Redis refresh lease so concurrent token refreshes for one
  session are serialized across server processes. A caller that loses the race
  reuses the tokens the winner saved instead of redeeming the same rotating
  refresh token a second time.
- Added `TokenRefreshResult.sessionInvalidated`, set when a terminal refresh
  failure has already deleted the Redis session, and an optional
  `logout(request, { sessionInvalidated })` argument that then only clears the
  session cookie without rereading or revoking a replacement session.
- Added an optional `state` argument to `clearOAuthRecoveryIntentHeaders` to
  clear the recovery cookie of one exact OAuth transaction.
- Added `getAuthSession(request, { throwOnError })` so callers can tell a Redis
  failure apart from a missing session.

### Changed

- Split token refresh failures into terminal and temporary. Only a provider
  `invalid_grant` rejection, a missing or replaced session, or a missing
  refresh token sets `shouldLogout: true`; provider outages, timeouts,
  malformed refresh responses and lease contention now return
  `shouldLogout: false` and keep the refreshable session. Consumers that
  treated every failed `refreshTokens` or `attemptTokenRefresh` result as a
  logout must read `shouldLogout` instead.
- The fetch middleware now answers a temporary refresh failure with the
  `AUTH_REFRESH_UNAVAILABLE` client error, a synthetic 503 and
  `shouldLogout: false`, and keeps `REFRESH_TOKEN_EXPIRED` for terminal
  failures.
- `protectRoute` and `shouldRefreshToken` now throw a `503` response
  (`Cache-Control: no-store`, `Retry-After: 5`) when renewal or session storage
  is temporarily unavailable, instead of logging the user out. Route modules
  must let a thrown `Response` through, as they already do for redirects.
- A session with an expired token and no refresh token is now invalidated by the
  same conditional refresh path, so it can no longer delete a session
  generation that replaced it.
- Refresh requests to the provider now time out after 15 seconds, and the token
  expiry check uses the earlier of the stored `expiresAt` and the JWT `exp`
  claim consistently across route protection, session validation and refresh.
- OAuth transaction cookies are now scoped per callback state. The state
  pointer and the recovery ticket cookie names gain a `_<sha256 of the exact
  state>` suffix, so two login tabs no longer overwrite each other's pending
  transaction. Cookie names still derive from the existing application cookie
  prefix; no environment variable or configuration changes.
- Adapters that inspect `Set-Cookie` names from `login` or recovery responses
  must match the suffixed names (`<prefix>_oauth_state_id_<hash>` and
  `<prefix>_oauth_recovery_<hash>`) instead of the bare names.
  `OAUTH_RECOVERY_COOKIE_NAME` remains the exported base name.
- An OAuth login that is in flight across the upgrade still completes: when no
  scoped cookie exists, the callback and recovery paths fall back to the legacy
  single-cookie names, and a legacy cookie is cleared only after its exact
  state is verified.
- A callback now deletes its Redis OAuth state only when the stored `state`
  equals the callback's `state`, and a callback with a repeated or oversized
  `state` parameter is not eligible for stale-callback recovery.
- Read `NODE_ENV` through `node:process` in the server cookie helpers.

### Security

- Capped pending OAuth transactions at 8 per browser. `login` fails with
  `Login failed` instead of growing the cookie header or evicting another tab's
  transaction, and callbacks with an oversized, duplicated or malformed
  cookie header are rejected as malformed.
- Refresh persistence, lease release and invalidation compare the encrypted
  Redis snapshot and the lease owner atomically, so a concurrent logout or a
  newer token generation is never overwritten by a late refresh.
- A late provider response after the refresh deadline no longer persists tokens.

### Tested

- Added a real-Redis token refresh integration suite covering concurrent
  refresh coordination, provider outages, `invalid_grant` invalidation, lease
  loss and concurrent logout. It runs when `SPINE_TEST_REDIS_URL` points at a
  Redis server, which CI now provides, and is skipped otherwise.
- Added per-state OAuth transaction cookie, recovery and capacity coverage.

## [0.3.11] - 2026-08-11

### Added

- Exposed the server-only `isOAuthRecoveryEligibleCallback` predicate so
  adapters can distinguish an ordinary stale callback eligible for one fresh
  root login from terminal callback failures.
- Kept exact recovery-ticket consumption as the only source of a preserved
  return URL; the fresh-root fallback never exchanges the stale callback code.

## [0.3.10] - 2026-08-09

### Added

- Added a server-only, opaque OAuth recovery ticket contract for one atomic
  retry of a stale ordinary authorization callback while preserving the
  originally sanitized return URL.

### Security

- Bound recovery consumption to the exact callback state in Redis, preserving
  mismatch and race safety without trusting a client boolean, callback code,
  or return URL.
- Excluded provider errors, malformed callbacks, state mismatches, storage and
  configuration failures, token exchange failures, and application actions
  from recovery; terminal and successful callbacks clear recovery tickets.

## [0.3.9] - 2026-08-09

### Added

- Added a server-only typed OAuth callback failure contract that exposes a
  recoverability signal only for missing or expired normal authorization
  transactions.

### Security

- Preserved exact state, nonce, and PKCE validation while classifying malformed,
  mismatched, provider, token-exchange, storage, configuration, session, and
  application-action failures as non-recoverable.
- Preserved repeated callback cleanup cookies and redacted OAuth state IDs from
  Redis storage logs.

## [0.3.8] - 2026-08-05

### Changed

- Updated the SignalR client to 10.0.11 and Redis session storage to ioredis 6.0.0 while preserving the existing realtime, authentication, tenant, and session contracts.
- Kept the SignalR-scoped `ws` security override within SignalR's declared `^7.5.10` range and advanced it to the current 7.5.13 patch release.

### Tested

- Added focused SignalR lifecycle, reconnect, access-token, event, and invocation regressions.
- Added Redis session/index, pipeline, expiry, membership, key cleanup, error-event, and connection shutdown regressions.

## [0.3.7] - 2026-08-04

### Added

- Added TanStack Start client and server adapter entry points while retaining the React Router adapters.

### Security

- Hardened session refresh isolation, tenant membership validation, route protection, and server-authoritative tenant headers.

## [0.3.6] - 2026-07-14

### Fixed

- Carry forward the back-channel logout telemetry classification prepared in 0.3.5, which was not published after npm rejected provenance from a self-hosted release runner.
- Run npm trusted publishing on a GitHub-hosted Ubuntu runner and upgrade the release checkout action to v7 so provenance satisfies npm's supported-provider requirements.

## [0.3.5] - 2026-07-14

### Fixed

- Classify malformed or unverifiable back-channel logout tokens as expected client warnings while preserving error-level reporting for provider, discovery, JWKS, and configuration failures.

## [0.3.4] - 2026-07-13

### Security

- Restrict OAuth return targets to safe same-origin application paths and revalidate stored state during callbacks.
- Redact invitation tokens and OAuth callback details from authentication logs.
- Mark temporary production OAuth cookies as Secure, HttpOnly, and SameSite=Lax.

## [0.3.3] - 2026-07-11

### Fixed

- Align package runtime exports with the emitted `.mjs` files and add an export-map regression test.

## [0.3.2] - 2026-07-11

### Fixed

- Use the configured public OIDC redirect URI during authorization-code exchange so callbacks remain valid behind TLS-terminating reverse proxies.

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
