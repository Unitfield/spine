# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-03-15

### Added

- Added framework-agnostic permission route protection primitives.
- Added configurable tenant cookie policy in core.
- Added generic server-side identity context resolution helpers.
- Added React Router adapter entry points.
- Added open source contributor documentation, security policy, and repository scaffolding.

### Changed

- Moved tenant, identity, and permission server orchestration out of the dashboard app and into Mimir.
- Expanded tenant primitives to support membership-aware state.
- Updated package metadata for a fresh public open source release.
- Rewrote README around the current adapter-based architecture.
- Renamed remaining package-level branding defaults from legacy product names to Mimir-oriented names where appropriate.

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

- Initial release of Mimir Core.
