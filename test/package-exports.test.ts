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

  it('keeps OAuth callback errors on server-only wildcard surfaces', async () => {
    const authServer = readFileSync(resolve(import.meta.dirname, '../src/auth/server.ts'), 'utf8');
    const authClient = readFileSync(resolve(import.meta.dirname, '../src/auth/index.ts'), 'utf8');
    const server = readFileSync(resolve(import.meta.dirname, '../src/server.ts'), 'utf8');
    const reactRouterServer = readFileSync(
      resolve(import.meta.dirname, '../src/react-router/server.ts'),
      'utf8',
    );
    const tanStackStartServer = readFileSync(
      resolve(import.meta.dirname, '../src/tanstack-start/server.ts'),
      'utf8',
    );

    expect(authServer).toContain("export * from './callback-errors';");
    expect(authClient).not.toContain('callback-errors');
    expect(server).toContain("export * from './auth/server';");
    expect(reactRouterServer).toContain("export * from '../server';");
    expect(tanStackStartServer).toContain("export * from '../server';");

    const serverModule = await import('../src/auth/server');
    const rootServerModule = await import('../src/server');
    const reactRouterServerModule = await import('../src/react-router/server');
    const tanStackStartServerModule = await import('../src/tanstack-start/server');
    const clientModule = await import('../src/auth/index');
    expect(serverModule.OAuthCallbackError).toBeDefined();
    expect(serverModule.isOAuthCallbackError).toBeDefined();
    expect(serverModule.isRecoverableOAuthCallbackError).toBeDefined();
    expect(serverModule.consumeOAuthRecoveryIntent).toBeDefined();
    expect(serverModule.clearOAuthRecoveryIntentHeaders).toBeDefined();
    expect(serverModule.getOAuthRecoveryCookiePath).toBeDefined();
    expect(serverModule.OAUTH_RECOVERY_COOKIE_NAME).toBeDefined();
    expect(serverModule).not.toHaveProperty('OAUTH_RECOVERY_COOKIE_PATH');
    expect(rootServerModule.OAuthCallbackError).toBe(serverModule.OAuthCallbackError);
    expect(reactRouterServerModule.OAuthCallbackError).toBe(serverModule.OAuthCallbackError);
    expect(tanStackStartServerModule.OAuthCallbackError).toBe(serverModule.OAuthCallbackError);
    expect(rootServerModule.consumeOAuthRecoveryIntent).toBe(
      serverModule.consumeOAuthRecoveryIntent,
    );
    expect(reactRouterServerModule.consumeOAuthRecoveryIntent).toBe(
      serverModule.consumeOAuthRecoveryIntent,
    );
    expect(tanStackStartServerModule.consumeOAuthRecoveryIntent).toBe(
      serverModule.consumeOAuthRecoveryIntent,
    );
    expect(rootServerModule.OAUTH_RECOVERY_COOKIE_NAME).toBe(
      serverModule.OAUTH_RECOVERY_COOKIE_NAME,
    );
    expect(rootServerModule.getOAuthRecoveryCookiePath).toBe(
      serverModule.getOAuthRecoveryCookiePath,
    );
    expect(clientModule).not.toHaveProperty('OAuthCallbackError');
    expect(clientModule).not.toHaveProperty('consumeOAuthRecoveryIntent');
    expect(clientModule).not.toHaveProperty('OAUTH_RECOVERY_COOKIE_NAME');
    expect(clientModule).not.toHaveProperty('getOAuthRecoveryCookiePath');
  });
});
