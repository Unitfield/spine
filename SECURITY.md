# Security Policy

## Supported Versions

Security fixes are applied to the latest published release line and the current `main` branch. Older releases are not supported.

## Reporting a Vulnerability

Do not open a public issue or discussion for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/eminuckan/spine/security/advisories/new) from the repository's **Security** tab. Maintainers should coordinate investigation and remediation in a private draft security advisory.

Include the affected package entry point or adapter, impact, reproduction steps, affected version or revision, and any suggested mitigation. Redact credentials, tokens, session material, and application data from the report.

We will validate the report, prioritize remediation by impact and exploitability, and coordinate disclosure after a fix is available.

## Scope Notes

Spine provides infrastructure primitives, but consuming applications are still responsible for:

- Backend authorization enforcement
- Secure secret management
- Correct adapter configuration
- Safe redirect and cookie policies
- Protecting product-specific APIs and workflows

Frontend permission checks and route guards in Spine improve UX, but they are not a substitute for backend authorization.
