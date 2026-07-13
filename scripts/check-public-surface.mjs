import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const currentFile = relative(root, fileURLToPath(import.meta.url));
const ignoredDirectories = new Set([
  '.git',
  'dist',
  'node_modules',
]);
const ignoredFiles = new Set([
  'pnpm-lock.yaml',
  currentFile,
]);
const scannedRoots = [
  '.github',
  'docs',
  'examples',
  'src',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'MAINTAINERS.md',
  'ROADMAP.md',
  'README.md',
  'SECURITY.md',
  'package.json',
];
const blockedPatterns = [
  /Unitfield/i,
  /Mimir/i,
  /PropMate/i,
  /uf_/,
  /__active-org/,
  /MimirCore/,
];
const approvedRepositoryIdentity = /(?:git\+)?https:\/\/github\.com\/Unitfield\/spine(?:\.git|(?:\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?)|\bUnitfield\/spine\b/gi;

function walk(path, files = []) {
  const stat = statSync(path);

  if (stat.isDirectory()) {
    if (ignoredDirectories.has(basename(path))) {
      return files;
    }

    for (const entry of readdirSync(path)) {
      walk(join(path, entry), files);
    }

    return files;
  }

  if (stat.isFile()) {
    const relativePath = relative(root, path);
    if (!ignoredFiles.has(relativePath)) {
      files.push(path);
    }
  }

  return files;
}

const findings = [];

for (const scannedRoot of scannedRoots) {
  const absolutePath = join(root, scannedRoot);
  const files = walk(absolutePath);

  for (const file of files) {
    const relativePath = relative(root, file);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);

    lines.forEach((line, index) => {
      const inspectedLine = line.replace(approvedRepositoryIdentity, '');
      for (const pattern of blockedPatterns) {
        if (pattern.test(inspectedLine)) {
          findings.push(`${relativePath}:${index + 1}: ${pattern}`);
        }
      }
    });
  }
}

if (findings.length > 0) {
  console.error('Public surface contains private project leakage:');
  findings.forEach((finding) => console.error(`  ${finding}`));
  process.exit(1);
}

console.log('Public surface check passed.');
