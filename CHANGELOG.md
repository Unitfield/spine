# Changelog

All notable changes to this project will be documented in this file.

## [0.1.16] - 2026-02-28

### Changed
- Switched publishing target to npmjs.org with public access.
- Updated README package references and publishing instructions for npm public releases.
- Included `LICENSE` in published package files.

## [0.1.2] - 2025-12-05

### Added
- **Redis Key Prefix Support**: Added `REDIS_KEY_PREFIX` environment variable support for Redis session storage. This allows multiple applications to share the same Redis instance without session key collisions.
  - Dashboard app: `REDIS_KEY_PREFIX=propmate:` → `propmate:session:xxx`, `propmate:oauth:state:xxx`
  - Tenant app: `REDIS_KEY_PREFIX=tenant:` → `tenant:session:xxx`, `tenant:oauth:state:xxx`

## [0.1.1] - 2025-12-05

### Fixed
- Fixed author field encoding issue in package.json that was causing package installation errors.

## [0.1.0] - 2025-12-04

### Added
- Initial release of mimir-core
- Multi-tenant SaaS infrastructure for React Router applications
- OAuth2/OIDC authentication with PKCE support
- Redis-backed session storage
- Tenant management with cookie-based tenant switching
- Permission system with Zustand store
- Identity context management
- API client with Axios integration
- SignalR client for real-time features
- TanStack Query client configuration
- Logging utilities
