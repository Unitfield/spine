import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth/redis-session-storage.server', () => ({
  getAuthSession: vi.fn(async () => ({
    userId: 'user-1',
    user: { sub: 'user-1' },
  })),
}));

import {
  configureIdentityContextFetcher,
  resetTenantResolutionConfig,
  setCurrentTenant,
} from '../../src/tenant/tenant.server';

describe('setCurrentTenant', () => {
  beforeEach(() => {
    resetTenantResolutionConfig();
    configureIdentityContextFetcher(async () => ({
      memberships: [{ tenantId: 'tenant-a' }, { tenantId: 'tenant-b' }],
    }));
  });

  it('writes the tenant cookie for a current membership', async () => {
    const result = await setCurrentTenant(
      new Request('https://app.example.test/api/tenant/switch'),
      'tenant-b',
    );

    expect(result.success).toBe(true);
    expect(result.headers.get('Set-Cookie')).toContain('__spine_tenant=tenant-b');
  });

  it('rejects a tenant outside the active user memberships', async () => {
    const result = await setCurrentTenant(
      new Request('https://app.example.test/api/tenant/switch'),
      'tenant-other',
    );

    expect(result).toEqual({
      headers: expect.any(Headers),
      success: false,
      error: 'Tenant is not available for the active user',
    });
    expect(result.headers.has('Set-Cookie')).toBe(false);
  });
});
