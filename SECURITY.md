# Security Policy

## Supported Versions

Security fixes are applied to the latest published release line.

## Reporting a Vulnerability

Please do not open public GitHub issues for security problems.

Instead, report vulnerabilities privately to:

- Email: `eminuckan@gmail.com`

When possible, include:

- A clear description of the issue
- Affected versions
- Reproduction steps
- Potential impact
- Any suggested mitigation

## Response Expectations

The goal is to acknowledge reports quickly, validate impact, and coordinate a fix before public disclosure.

## Scope Notes

Mimir provides infrastructure primitives, but consuming applications are still responsible for:

- Backend authorization enforcement
- Secure secret management
- Correct adapter configuration
- Safe redirect and cookie policies
- Protecting product-specific APIs and workflows

Frontend permission checks and route guards in Mimir improve UX, but they are not a substitute for backend authorization.
