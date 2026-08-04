import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
const adapterContracts = {
  './react-router': {
    source: 'src/react-router/index.ts',
    target: '../index',
    runtime: './dist/react-router/index.mjs',
    types: './dist/react-router/index.d.ts',
  },
  './react-router/server': {
    source: 'src/react-router/server.ts',
    target: '../server',
    runtime: './dist/react-router/server.mjs',
    types: './dist/react-router/server.d.ts',
  },
  './tanstack-start': {
    source: 'src/tanstack-start/index.ts',
    target: '../index',
    runtime: './dist/tanstack-start/index.mjs',
    types: './dist/tanstack-start/index.d.ts',
  },
  './tanstack-start/server': {
    source: 'src/tanstack-start/server.ts',
    target: '../server',
    runtime: './dist/tanstack-start/server.mjs',
    types: './dist/tanstack-start/server.d.ts',
  },
};

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

const packageManifest = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);

for (const [entry, contract] of Object.entries(adapterContracts)) {
  const packageExport = packageManifest.exports?.[entry];
  if (!packageExport) {
    findings.push(`package.json: missing adapter export ${entry}`);
    continue;
  }

  if (
    packageExport.import !== contract.runtime ||
    packageExport.types !== contract.types
  ) {
    findings.push(`package.json: adapter export ${entry} does not match its emitted files`);
  }

  const sourcePath = join(root, contract.source);
  if (!existsSync(sourcePath)) {
    findings.push(`${contract.source}: adapter source is missing`);
    continue;
  }

  const source = readFileSync(sourcePath, 'utf8');
  const aliasPattern = new RegExp(
    `export\\s+\\*\\s+from\\s+['"]${contract.target}['"]`,
  );
  if (!aliasPattern.test(source)) {
    findings.push(`${contract.source}: adapter must alias ${contract.target}`);
  }

  if (/from\s+['"]@tanstack\/(?:react-start|react-router)['"]/.test(source)) {
    findings.push(`${contract.source}: adapter must not import TanStack runtime glue`);
  }
}

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
  console.error('Public surface check failed:');
  findings.forEach((finding) => console.error(`  ${finding}`));
  process.exit(1);
}

console.log('Public surface check passed.');
