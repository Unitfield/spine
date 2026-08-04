import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };

describe('package export map', () => {
  it('points every runtime entry at the emitted ESM extension', () => {
    expect(packageJson.main).toMatch(/\.mjs$/);
    expect(packageJson.module).toMatch(/\.mjs$/);

    for (const contract of Object.values(packageJson.exports)) {
      expect(contract.import).toMatch(/\.mjs$/);
      expect(contract.types).toMatch(/\.d\.ts$/);
    }
  });

  it('publishes TanStack Start client and server adapter aliases', () => {
    expect(packageJson.exports['./tanstack-start']).toEqual({
      types: './dist/tanstack-start/index.d.ts',
      import: './dist/tanstack-start/index.mjs',
    });
    expect(packageJson.exports['./tanstack-start/server']).toEqual({
      types: './dist/tanstack-start/server.d.ts',
      import: './dist/tanstack-start/server.mjs',
    });

    const tsdownConfig = readFileSync(resolve(import.meta.dirname, '../tsdown.config.ts'), 'utf8');
    expect(tsdownConfig).toContain("'tanstack-start/index': 'src/tanstack-start/index.ts'");
    expect(tsdownConfig).toContain("'tanstack-start/server': 'src/tanstack-start/server.ts'");
  });
});
