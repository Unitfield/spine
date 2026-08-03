import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth/redis-session-storage.server', () => ({
  getAuthSession: vi.fn(async () => ({
    userId: 'user-1',
    user: { sub: 'user-1' },
  })),
}));

import {
  configureIdentityContextFetcher,
  getCurrentTenant,
  getAvailableTenants,
  isTenantMember,
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

  it('treats a forged or stale tenant cookie as an untrusted selector', async () => {
    const request = new Request('https://app.example.test/api/tenant/data', {
      headers: { Cookie: '__spine_tenant=tenant-forged' },
    });

    await expect(getCurrentTenant(request)).resolves.toBeNull();
    await expect(isTenantMember(request, 'tenant-forged')).resolves.toBe(false);
    await expect(getAvailableTenants(request)).resolves.toEqual(['tenant-a', 'tenant-b']);
  });

  it('accepts an active cookie only when it is a current membership', async () => {
    const request = new Request('https://app.example.test/api/tenant/data', {
      headers: { Cookie: '__spine_tenant=tenant-b' },
    });

    await expect(getCurrentTenant(request)).resolves.toBe('tenant-b');
    await expect(isTenantMember(request, 'tenant-a')).resolves.toBe(true);
  });

  it('breaks recursive identity fetcher tenant resolution and rejects a forged selector', async () => {
    const request = new Request('https://app.example.test/api/tenant/data', {
      headers: { Cookie: '__spine_tenant=tenant-forged' },
    });
    let fetcherCalls = 0;
    let nestedTenant: string | null | undefined;

    configureIdentityContextFetcher(async (fetchRequest) => {
      fetcherCalls += 1;
      nestedTenant = await getCurrentTenant(fetchRequest);
      return {
        memberships: [{ tenantId: 'tenant-authorized' }],
      };
    });

    await expect(getCurrentTenant(request)).resolves.toBeNull();
    expect(nestedTenant).toBeNull();
    expect(fetcherCalls).toBe(1);
    await expect(isTenantMember(request, 'tenant-forged')).resolves.toBe(false);
    await expect(isTenantMember(request, 'tenant-authorized')).resolves.toBe(true);
  });
});
