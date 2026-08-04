import {
  configureTenantResolution,
  configureTenantCookie,
  getCurrentTenant,
  initializeTenant,
} from '@eminuckan/spine/tenant/server';
import { getUser } from '@eminuckan/spine/react-router/server';
import { getIdentityContext } from './identity.server';

configureTenantCookie({
  name: '__spine_tenant',
  httpOnly: false,
  sameSite: 'Lax',
});

configureTenantResolution({
  identityContextFetcher: async (request) => {
    const user = await getUser(request);
    if (!user) {
      return null;
    }

    const context = await getIdentityContext(request, user.sub);
    return {
      memberships: context.memberships ?? [],
    };
  },
});

export { getCurrentTenant, initializeTenant };
