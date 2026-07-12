import {
  configureIdentityAPIFetcher,
  configurePermissionFetcher,
} from '@eminuckan/spine/identity/server';
import { getAccessToken } from '@eminuckan/spine/react-router/server';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:8080';

configureIdentityAPIFetcher(async (request) => {
  const accessToken = await getAccessToken(request);
  const response = await fetch(`${apiBaseUrl}/api/me/context`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
  });

  if (!response.ok) {
    throw new Error(`Failed to load identity context: ${response.status}`);
  }

  return response.json();
});

configurePermissionFetcher(async (request, tenantId) => {
  const accessToken = await getAccessToken(request);
  const url = new URL('/api/me/permissions', apiBaseUrl);
  url.searchParams.set('tenantId', tenantId);

  const response = await fetch(url, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
  });

  if (!response.ok) {
    return [];
  }

  const payload = await response.json();
  return Array.isArray(payload.permissions) ? payload.permissions : [];
});

export { contextToUserInfo, getIdentityContext } from '@eminuckan/spine/identity/server';
