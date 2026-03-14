# Releasing Spine

This guide covers local validation, GitHub release setup, and npm publishing.

## Before Releasing

Run:

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm lint
```

Review:

- `README.md`
- `CHANGELOG.md`
- `package.json`

## Versioning

Update the version in `package.json` and add a changelog entry.

## GitHub Repository

If the repository does not exist yet:

```bash
gh repo create eminuckan/spine --public --source=. --remote=origin --push
```

Useful follow-up commands:

```bash
gh repo edit eminuckan/spine --description "Framework-agnostic SaaS primitives for auth, identity, multi-tenancy, permissions, and API access."
gh repo edit eminuckan/spine --homepage "https://github.com/eminuckan/spine#readme"
```

## npm Publishing

You need npm authentication on the machine or an `NPM_TOKEN`.

Manual publish:

```bash
npm publish --access public
```

Dry run:

```bash
npm publish --dry-run
```

## GitHub Actions Release Workflow

The repository includes a release workflow that expects:

- `NPM_TOKEN` GitHub Actions secret

Recommended tag format:

```bash
git tag v0.2.0
git push origin v0.2.0
```

## Release Checklist

- Version updated
- Changelog updated
- Docs updated
- Build and typecheck pass
- GitHub repo is public
- npm auth is available
- Publish succeeds

## Troubleshooting

### `npm whoami` fails

You are not authenticated with npm on the current machine.

### `npm view @eminuckan/spine version` returns 404

The package is not currently published or the scope/package name is unavailable to the current user.

### GitHub push fails because the repo does not exist

Create the repository first with `gh repo create`.
