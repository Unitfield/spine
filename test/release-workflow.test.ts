import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '..');
const validatorPath = resolve(repositoryRoot, 'scripts/validate-release-tag.mjs');
const temporaryDirectories: string[] = [];

function git(repository: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createReleaseRepository() {
  const root = mkdtempSync(join(tmpdir(), 'spine-release-contract-'));
  temporaryDirectories.push(root);
  const origin = join(root, 'origin.git');
  const repository = join(root, 'repository');
  mkdirSync(repository);
  git(root, ['init', '--bare', origin]);
  git(repository, ['init', '--initial-branch=main']);
  git(repository, ['config', 'user.email', 'release-test@unitfield.test']);
  git(repository, ['config', 'user.name', 'Unitfield Release Test']);
  writeFileSync(join(repository, 'package.json'), '{"version":"1.2.3"}\n');
  git(repository, ['add', 'package.json']);
  git(repository, ['commit', '-m', 'Prepare release']);
  git(repository, ['remote', 'add', 'origin', origin]);
  git(repository, ['push', '--set-upstream', 'origin', 'main']);

  return { repository, mainSha: git(repository, ['rev-parse', 'HEAD']) };
}

function validate(repository: string, refName: string, sha: string) {
  return spawnSync(
    process.execPath,
    [validatorPath, '--repository', repository],
    {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REF_NAME: refName,
        GITHUB_SHA: sha,
      },
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('npm release workflow', () => {
  it('checks out full history and preserves trusted publishing provenance', () => {
    const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/release.yml'), 'utf8');

    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('node scripts/validate-release-tag.mjs');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('npm publish --access public');
  });

  it('accepts a version-matched release commit reachable from origin/main', () => {
    const { repository, mainSha } = createReleaseRepository();
    const result = validate(repository, 'v1.2.3', mainSha);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('eligible for publishing from origin/main');
  });

  it('fails closed when a version-matched tag commit is not on origin/main', () => {
    const { repository } = createReleaseRepository();
    git(repository, ['switch', '--orphan', 'detached-release']);
    writeFileSync(join(repository, 'package.json'), '{"version":"1.2.3","offMain":true}\n');
    git(repository, ['add', 'package.json']);
    git(repository, ['commit', '-m', 'Prepare off-main release']);
    const detachedSha = git(repository, ['rev-parse', 'HEAD']);

    const result = validate(repository, 'v1.2.3', detachedSha);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not an ancestor of origin/main');
  });
});
