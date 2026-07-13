# Releasing Spine

This guide covers local validation, GitHub release setup, and npm publishing.

## Before Releasing

Run:

```bash
pnpm install
pnpm check
npm pack --dry-run
```

Review:

- `README.md`
- `package.json`
- `CHANGELOG.md`
- `README.md`
- `ROADMAP.md`

## Versioning

Update the version in `package.json` and add a changelog entry.

## GitHub Repository

If the repository does not exist yet:

```bash
gh repo create Unitfield/spine --public --source=. --remote=origin --push
```

Useful follow-up commands:

```bash
gh repo edit Unitfield/spine --description "Framework-agnostic SaaS primitives for auth, identity, multi-tenancy, permissions, and API access."
gh repo edit Unitfield/spine --homepage "https://github.com/Unitfield/spine#readme"
```

## npm Publishing

You need npm authentication on the machine for manual publishing, or npm trusted publishing configured for GitHub Actions.

Manual publish:

```bash
npm publish --access public
```

Dry run:

```bash
npm publish --dry-run
```

## GitHub Actions Release Workflow

The repository includes a release workflow that expects npm trusted publishing to be configured for the `npm-publish` GitHub environment.

Recommended tag format:

```bash
git tag v0.2.0
git push origin v0.2.0
```

## Release Checklist

- Version updated
- Changelog updated
- Docs updated
- `pnpm check` passes
- `npm pack --dry-run` includes only intended files
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
