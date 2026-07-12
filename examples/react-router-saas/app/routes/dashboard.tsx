import { Link, useLoaderData } from 'react-router';
import { authRoute, getAccessToken } from '@eminuckan/spine/react-router/server';
import type { UserInfo } from '@eminuckan/spine/auth';
import { getActiveTenant, initializeTenant } from '../lib/spine/tenant.server';

interface DashboardData {
  user: Pick<UserInfo, 'sub' | 'name' | 'email'>;
  hasAccessToken: boolean;
  currentTenant: string | null;
}

export async function loader({ request }: { request: Request }) {
  return authRoute<DashboardData>(request, async (user) => {
    const currentTenant = await getActiveTenant(request);
    const initializedTenant = currentTenant ? null : await initializeTenant(request);
    const accessToken = await getAccessToken(request);

    return {
      user: {
        sub: user.sub,
        name: user.name,
        email: user.email,
      },
      hasAccessToken: Boolean(accessToken),
      currentTenant: initializedTenant?.tenantId ?? currentTenant,
    };
  });
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();

  return (
    <main className="shell">
      <section className="panel">
        <p className="eyebrow">Protected route</p>
        <h1>Dashboard</h1>
        <ul className="meta">
          <li>
            <span>User</span>
            <strong>{data.user.email ?? data.user.name ?? data.user.sub}</strong>
          </li>
          <li>
            <span>Access token</span>
            <strong>{data.hasAccessToken ? 'available' : 'missing'}</strong>
          </li>
          <li>
            <span>Current tenant</span>
            <strong>{data.currentTenant ?? 'not selected'}</strong>
          </li>
        </ul>
        <div className="actions">
          <Link className="button secondary" to="/">
            Home
          </Link>
          <Link className="button" to="/auth/logout">
            Sign out
          </Link>
        </div>
      </section>
    </main>
  );
}
