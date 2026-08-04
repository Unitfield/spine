import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';

import * as clientCore from '../../src/index';
import * as clientAdapter from '../../src/tanstack-start/index';
import * as serverCore from '../../src/server';
import * as serverAdapter from '../../src/tanstack-start/server';

function expectSameRuntimeExports(
  core: Record<string, unknown>,
  adapter: Record<string, unknown>,
) {
  expect(Object.keys(adapter).sort()).toEqual(Object.keys(core).sort());

  for (const key of Object.keys(core)) {
    expect(adapter[key]).toBe(core[key]);
  }
}

describe('TanStack Start adapter', () => {
  it('keeps client and server runtime exports in parity with core', () => {
    expectSameRuntimeExports(
      clientCore as Record<string, unknown>,
      clientAdapter as Record<string, unknown>,
    );
    expectSameRuntimeExports(
      serverCore as Record<string, unknown>,
      serverAdapter as Record<string, unknown>,
    );
  });

  it('keeps the client adapter browser-safe and the server adapter server-capable', () => {
    expect(clientAdapter).not.toHaveProperty('getUser');
    expect(clientAdapter).not.toHaveProperty('getAccessToken');
    expect(serverAdapter).toHaveProperty('getUser');
    expect(serverAdapter).toHaveProperty('getAccessToken');
  });

  it('keeps the adapter types aligned without importing TanStack runtime glue', () => {
    expectTypeOf(clientAdapter.createQueryClient).toEqualTypeOf(
      clientCore.createQueryClient,
    );
    expectTypeOf(serverAdapter.authRoute).toEqualTypeOf(serverCore.authRoute);
    expectTypeOf(serverAdapter.getUser).toEqualTypeOf(serverCore.getUser);

    const clientSource = readFileSync(
      resolve(import.meta.dirname, '../../src/tanstack-start/index.ts'),
      'utf8',
    );
    const serverSource = readFileSync(
      resolve(import.meta.dirname, '../../src/tanstack-start/server.ts'),
      'utf8',
    );

    expect(clientSource).not.toContain('@tanstack/react-start');
    expect(clientSource).not.toContain('@tanstack/react-router');
    expect(serverSource).not.toContain('@tanstack/react-start');
    expect(serverSource).not.toContain('@tanstack/react-router');
  });
});
