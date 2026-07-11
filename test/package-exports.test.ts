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
});
