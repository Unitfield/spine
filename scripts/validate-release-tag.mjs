#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryArgumentIndex = process.argv.indexOf('--repository');
const repositoryRoot = repositoryArgumentIndex >= 0
  ? resolve(process.argv[repositoryArgumentIndex + 1] ?? '')
  : resolve(scriptDirectory, '..');
const mainRemoteRef = 'refs/remotes/origin/main';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const refName = process.env.GITHUB_REF_NAME?.trim() ?? '';
const releaseSha = process.env.GITHUB_SHA?.trim() ?? '';

if (!/^[0-9a-f]{40}$/.test(releaseSha)) {
  fail('GITHUB_SHA must be a full lowercase commit SHA.');
}

const packageVersion = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
).version;
const expectedTag = `v${packageVersion}`;
if (refName !== expectedTag) {
  fail(`Release tag ${refName || '(missing)'} does not match package version ${packageVersion}.`);
}

let checkedOutSha;
try {
  checkedOutSha = git(['rev-parse', 'HEAD^{commit}']);
} catch {
  fail('Unable to resolve the checked-out release commit.');
}

if (checkedOutSha !== releaseSha) {
  fail(`Checked-out commit ${checkedOutSha} does not match release commit ${releaseSha}.`);
}

try {
  git([
    'fetch',
    '--no-tags',
    '--prune',
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
  ]);
  git(['show-ref', '--verify', mainRemoteRef]);
} catch {
  fail('Unable to fetch and verify origin/main; refusing to publish.');
}

const ancestorCheck = spawnSync(
  'git',
  ['merge-base', '--is-ancestor', releaseSha, mainRemoteRef],
  { cwd: repositoryRoot, stdio: 'ignore' },
);
if (ancestorCheck.status !== 0) {
  fail(`Release commit ${releaseSha} is not an ancestor of origin/main; refusing to publish.`);
}

process.stdout.write(`Release tag ${refName} is eligible for publishing from origin/main.\n`);
