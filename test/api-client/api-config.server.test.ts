import { describe, expect, it } from 'vitest';
import { createAPIConfigFactory } from '../../src/api-client/api-config.server';

describe('createAPIConfigFactory', () => {
  it('uses configurable auth and tenant header names', async () => {
    const { createAPIConfig } = createAPIConfigFactory(
      async () => 'token-1',
      async () => 'workspace-1',
      undefined,
      {
        baseURL: 'https://api.example.test',
        authHeaderName: 'X-Access-Token',
        authHeaderValue: (token) => token,
        tenantHeaderName: 'X-Workspace-Id',
      }
    );

    const config = await createAPIConfig(new Request('https://app.example.test'));

    expect(config.basePath).toBe('https://api.example.test');
    expect(config.headers).toMatchObject({
      'X-Access-Token': 'token-1',
      'X-Workspace-Id': 'workspace-1',
    });
    expect(config.headers.Authorization).toBeUndefined();
    expect(config.headers['X-Tenant-Id']).toBeUndefined();
  });

  it('lets apps fully own auth and tenancy headers', async () => {
    const { createAPIConfig } = createAPIConfigFactory(
      async () => 'token-1',
      async () => 'account-1',
      undefined,
      {
        authHeaderName: null,
        tenantHeaderName: null,
        buildHeaders: ({ accessToken, tenantId }) => ({
          Cookie: `access=${accessToken}; account=${tenantId}`,
        }),
      }
    );

    const config = await createAPIConfig(new Request('https://app.example.test'));

    expect(config.headers.Cookie).toBe('access=token-1; account=account-1');
    expect(config.headers.Authorization).toBeUndefined();
    expect(config.headers['X-Tenant-Id']).toBeUndefined();
  });

  it('rejects an explicit tenant override outside current membership', async () => {
    const { createAPIConfig } = createAPIConfigFactory(
      async () => 'token-1',
      async () => 'tenant-a',
      undefined,
      {
        validateTenant: async (_request, tenantId) => tenantId === 'tenant-a',
      },
    );

    await expect(createAPIConfig(new Request('https://app.example.test'), {
      tenantId: 'tenant-forged',
    })).rejects.toThrow('Tenant context is required for this operation');
  });

  it('accepts an explicitly selected tenant after membership validation', async () => {
    const { createAPIConfig } = createAPIConfigFactory(
      async () => 'token-1',
      async () => 'tenant-a',
      undefined,
      {
        tenantHeaderName: 'X-Workspace-Id',
        validateTenant: async (_request, tenantId) => ['tenant-a', 'tenant-b'].includes(tenantId),
      },
    );

    const config = await createAPIConfig(new Request('https://app.example.test'), {
      tenantId: 'tenant-b',
    });

    expect(config.tenantId).toBe('tenant-b');
    expect(config.headers['X-Workspace-Id']).toBe('tenant-b');
  });

  it('fails closed for an explicit override when no validator can authorize it', async () => {
    const { createAPIConfig } = createAPIConfigFactory(
      async () => 'token-1',
      async () => 'tenant-a',
    );

    await expect(createAPIConfig(new Request('https://app.example.test'), {
      tenantId: 'tenant-b',
    })).rejects.toThrow('Tenant context is required for this operation');
  });

  it('does not expose an unauthorized selector to custom header builders', async () => {
    const { createAPIConfig } = createAPIConfigFactory(
      async () => 'token-1',
      async () => 'tenant-a',
      undefined,
      {
        tenantHeaderName: null,
        validateTenant: async () => false,
        buildHeaders: ({ options, tenantId }) => ({
          'X-Resolved-Tenant': tenantId ?? options.tenantId ?? 'none',
        }),
      },
    );

    const config = await createAPIConfig(new Request('https://app.example.test'), {
      tenantId: 'tenant-forged',
      requireTenant: false,
    });

    expect(config.tenantId).toBe('');
    expect(config.headers['X-Resolved-Tenant']).toBe('none');
  });

  it('removes a raw tenant header when no tenant was validated', async () => {
    const { createAPIConfig } = createAPIConfigFactory(
      async () => 'token-1',
      async () => null,
      undefined,
      {
        buildHeaders: () => ({
          'x-tenant-id': 'forged-by-builder',
        }),
      },
    );

    const config = await createAPIConfig(new Request('https://app.example.test'), {
      requireTenant: false,
      customHeaders: {
        'X-Tenant-Id': 'forged-by-caller',
      },
    });

    expect(config.tenantId).toBe('');
    expect(config.headers['X-Tenant-Id']).toBeUndefined();
    expect(config.headers['x-tenant-id']).toBeUndefined();
  });

  it('reasserts the validated tenant after custom headers and builders run', async () => {
    const { createAPIConfig } = createAPIConfigFactory(
      async () => 'token-1',
      async () => 'tenant-authorized',
      undefined,
      {
        buildHeaders: () => ({
          'X-Tenant-Id': 'forged-by-builder',
          'x-tenant-id': 'forged-by-builder-case-variant',
        }),
      },
    );

    const config = await createAPIConfig(new Request('https://app.example.test'), {
      customHeaders: {
        'x-tenant-id': 'forged-by-caller',
      },
    });

    expect(config.tenantId).toBe('tenant-authorized');
    expect(config.headers['X-Tenant-Id']).toBe('tenant-authorized');
    expect(config.headers['x-tenant-id']).toBeUndefined();
  });
});
