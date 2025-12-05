# @mimir/core

Core infrastructure package for multi-tenant SaaS applications. Provides authentication, authorization, multi-tenancy, and API client utilities.

> **Mímir** - In Norse mythology, the wise being who guarded the Well of Wisdom. Odin sacrificed his eye to drink from it and gain cosmic knowledge.

## Installation

```bash
# GitHub Packages
pnpm add @mimir/core

# local development
cd mimir-core && pnpm link --global
cd your-app && pnpm link --global @mimir/core
```

## Features

- 🔐 **OAuth2/OIDC Authentication** - Complete auth flow with token refresh
- 🛡️ **Route Protection** - Server-side route guards
- 👥 **RBAC Permissions** - Fine-grained permission system with Zustand store
- 🏢 **Multi-Tenancy** - Tenant context management with cookie persistence
- 🆔 **Identity Context** - User identity with real-time SignalR updates
- 🔌 **SignalR Client** - Real-time communication
- 📡 **API Client** - Axios setup with interceptors, retry, and error handling
- 📊 **Query Client** - TanStack Query configuration with cache presets
- 📝 **Logging** - Structured logging with levels

## Quick Start

### 1. Client-side Setup (root.tsx)

```tsx
import {
  TenantProvider,
  IdentityContextProvider,
  PermissionInitializer,
  createQueryClient,
  initializeSignalR,
} from '@mimir/core';
import { QueryClientProvider } from '@tanstack/react-query';

// Create query client
const queryClient = createQueryClient({
  onLogout: () => window.location.href = '/auth/logout',
});

export default function App() {
  const { tenant, identity, accessToken } = useLoaderData();

  return (
    <QueryClientProvider client={queryClient}>
      <TenantProvider
        initialTenant={tenant.currentTenant}
        initialTenants={tenant.availableTenants}
      >
        <IdentityContextProvider
          initialContext={identity}
          accessToken={accessToken}
        >
          <PermissionInitializer permissions={identity.permissions}>
            <Outlet />
          </PermissionInitializer>
        </IdentityContextProvider>
      </TenantProvider>
    </QueryClientProvider>
  );
}
```

### 2. Server-side Setup

```typescript
// lib/auth.server.ts
import {
  createAuthServer,
  createRedisSessionStorage,
  createRouteProtection,
} from '@mimir/core/server';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

export const sessionStorage = createRedisSessionStorage({
  redis,
  prefix: 'session:',
  ttl: 60 * 60 * 24 * 7, // 7 days
});

export const authServer = createAuthServer({
  issuerUrl: process.env.OAUTH_ISSUER_URL!,
  clientId: process.env.OAUTH_CLIENT_ID!,
  clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  redirectUri: process.env.OAUTH_REDIRECT_URI!,
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  sessionStorage,
});

export const { getUser, getAccessToken, login, logout, handleCallback } = authServer;

export const { protectRoute, authRoute, guestRoute } = createRouteProtection(
  getUser,
  '/auth/login',
  '/app'
);
```

### 3. API Client Setup

```typescript
// lib/api.server.ts
import { createAPIConfigFactory } from '@mimir/core/server';
import { getAccessToken } from './auth.server';
import { getCurrentTenant } from './tenant.server';
import { logger } from './logger';

export const { createAPIConfig, getAPIBaseURL } = createAPIConfigFactory(
  getAccessToken,
  getCurrentTenant,
  logger,
  { baseURL: process.env.API_BASE_URL }
);
```

---

## Module Reference

### Auth Module

OAuth2/OIDC authentication with automatic token refresh and Redis session storage.

```typescript
import {
  createAuthServer,
  createRedisSessionStorage,
  createRouteProtection,
  type AuthConfig,
  type SessionData,
} from '@mimir/core/server';
```

#### createAuthServer(config)

Creates an auth server instance with OAuth2/OIDC support.

```typescript
const authServer = createAuthServer({
  issuerUrl: 'https://auth.example.com',
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  redirectUri: 'https://app.example.com/auth/callback',
  scopes: ['openid', 'profile', 'offline_access'],
  sessionStorage,
});

// Methods
authServer.getUser(request);           // Get current user
authServer.getAccessToken(request);    // Get access token
authServer.login(request);             // Start OAuth flow
authServer.logout(request);            // Clear session
authServer.handleCallback(request);    // Handle OAuth callback
authServer.attemptTokenRefresh(request); // Refresh access token
```

#### createRouteProtection(getUser, loginUrl, dashboardUrl)

Creates route protection utilities.

```typescript
const { protectRoute, authRoute, guestRoute } = createRouteProtection(
  getUser,
  '/auth/login',
  '/app'
);

// Usage in loaders
export async function loader({ request }) {
  const user = await protectRoute(request); // Requires auth
  return { user };
}

export async function loader({ request }) {
  await guestRoute(request); // Redirects if already logged in
  return null;
}

export async function loader({ request }) {
  const user = await authRoute(request); // Optional auth
  return { user };
}
```

---

### Permissions Module

RBAC permission system with Zustand store, React hooks, and protected components.

```typescript
import {
  // Store
  usePermissionStore,
  
  // Hooks
  usePermission,
  useHasPermission,
  useHasAnyPermission,
  useHasAllPermissions,
  
  // Components
  ProtectedButton,
  ProtectedSection,
  ProtectedLink,
  
  // Service
  PermissionChecker,
  
  // Types
  type PermissionCode,
  type PermissionCheckOptions,
} from '@mimir/core';
```

#### Hooks

```typescript
// Single permission check
const canCreate = useHasPermission('Identity.Users.Create');

// Multiple permissions (any)
const canEdit = useHasAnyPermission(['Identity.Users.Edit', 'Identity.Users.Admin']);

// Multiple permissions (all)
const canManage = useHasAllPermissions(['Identity.Users.View', 'Identity.Users.Edit']);

// Full permission object
const { hasPermission, isLoading } = usePermission('Identity.Users.Create');
```

#### Components

```tsx
// Protected Button - disabled if no permission
<ProtectedButton
  permission="Identity.Users.Create"
  onClick={handleCreate}
  fallback={<Button disabled>Create User</Button>}
>
  Create User
</ProtectedButton>

// Protected Section - hidden if no permission
<ProtectedSection
  permission="Identity.Users.View"
  fallback={<AccessDenied />}
>
  <UserList />
</ProtectedSection>

// Protected Link - hidden if no permission
<ProtectedLink permission="Identity.Users.Edit" to={`/users/${id}/edit`}>
  Edit
</ProtectedLink>
```

#### Permission Initializer

```tsx
// Initialize permissions from server
<PermissionInitializer permissions={['Identity.Users.View', 'Identity.Users.Create']}>
  <App />
</PermissionInitializer>
```

---

### Tenant Module

Multi-tenant context management with cookie persistence.

```typescript
import {
  // Client
  TenantProvider,
  useTenant,
  useTenantStore,
  
  // Server
  createTenantServerFactory,
  createTenantCookieFactory,
} from '@mimir/core';
```

#### Client Usage

```tsx
// Provider
<TenantProvider
  initialTenant="tenant-123"
  initialTenants={['tenant-123', 'tenant-456']}
>
  <App />
</TenantProvider>

// Hook
function TenantSwitcher() {
  const { currentTenant, availableTenants, setCurrentTenant } = useTenant();
  
  return (
    <select 
      value={currentTenant} 
      onChange={(e) => setCurrentTenant(e.target.value)}
    >
      {availableTenants.map(t => <option key={t} value={t}>{t}</option>)}
    </select>
  );
}
```

#### Server Usage

```typescript
import { createTenantServerFactory } from '@mimir/core/server';

const { getCurrentTenant, setCurrentTenant, getAvailableTenants } = createTenantServerFactory(
  getSession,
  setSession,
  { cookieName: 'tenant_id' }
);

// In loader
export async function loader({ request }) {
  const tenantId = await getCurrentTenant(request);
  return { tenantId };
}
```

---

### Identity Module

User identity context with SignalR real-time updates.

```typescript
import {
  // Client
  IdentityContextProvider,
  useIdentityStore,
  useIsOnboarded,
  useHasSubscription,
  useUserTenants,
  useUserPermissions,
  useIdentityContext,
  
  // Server
  fetchIdentityContext,
  getIdentityContext,
  clearIdentityContextCache,
  configureIdentityAPIFetcher,
  configurePermissionFetcher,
} from '@mimir/core';
```

#### Client Usage

```tsx
// Provider with SignalR
<IdentityContextProvider
  initialContext={identity}
  accessToken={accessToken}
  signalRClient={signalRClient}
>
  <App />
</IdentityContextProvider>

// Store access
function Profile() {
  const { context, refreshContext, refreshPermissions } = useIdentityContext();
  
  return (
    <div>
      <h1>{context.displayName}</h1>
      <p>{context.email}</p>
      <button onClick={refreshContext}>Refresh</button>
    </div>
  );
}

// Convenience hooks
const isOnboarded = useIsOnboarded();
const hasSubscription = useHasSubscription();
const { tenants, currentTenant } = useUserTenants();
const permissions = useUserPermissions();
```

#### Server Usage

```typescript
import { configureIdentityAPIFetcher, getIdentityContext } from '@mimir/core/server';

// Configure API fetcher (once at startup)
configureIdentityAPIFetcher(async (request) => {
  const config = await createAPIConfig(request);
  const response = await fetch(`${config.basePath}/api/identity/context`, {
    headers: config.headers,
  });
  return response.json();
});

// Use in loader
export async function loader({ request }) {
  const user = await getUser(request);
  const identity = await getIdentityContext(request, user.id);
  return { identity };
}
```

---

### API Client Module

Axios setup with automatic token refresh, retry logic, and error handling.

```typescript
import {
  // Client
  ApiError,
  ErrorHandler,
  handleApiError,
  ErrorCodes,
  withRetry,
  fetchWithTimeout,
  
  // Server
  createAPIConfigFactory,
  setupAxiosInterceptors,
  createEnhancedClient,
} from '@mimir/core/server';
```

#### API Config Factory

```typescript
const { createAPIConfig, getAPIBaseURL } = createAPIConfigFactory(
  getAccessToken,
  getCurrentTenant,
  logger,
  {
    baseURL: 'https://api.example.com',
    userAgent: 'MyApp/1.0',
    timeout: 30000,
  }
);

// Usage
const config = await createAPIConfig(request);
// config.basePath, config.headers, config.tenantId, config.accessToken
```

#### Enhanced Client

```typescript
import { IdentityApi, Configuration } from './generated-api';

const { client, tenantId } = await createEnhancedClient(
  request,
  IdentityApi,
  createAPIConfig,
  Configuration,
  {
    logger,
    attemptTokenRefresh,
    retryConfig: { maxRetries: 3 },
  }
);

const users = await client.getUsers(tenantId);
```

#### Error Handling

```typescript
try {
  await api.createUser(data);
} catch (error) {
  const apiError = handleApiError(error);
  
  if (apiError.code === ErrorCodes.VALIDATION_ERROR) {
    // Handle validation errors
    console.log(apiError.validationErrors);
  } else if (apiError.code === ErrorCodes.NOT_FOUND) {
    // Handle not found
  }
}
```

---

### SignalR Module

Real-time communication client for identity context changes.

```typescript
import {
  SignalRClient,
  IdentitySignalRClient,
  initializeSignalR,
  cleanupSignalR,
  getIdentitySignalRClient,
  type SignalRClientConfig,
  type IdentityContextChangedEvent,
} from '@mimir/core';
```

#### Usage

```typescript
// Initialize
const client = await initializeSignalR(accessToken, {
  baseUrl: 'https://api.example.com',
  verbose: true,
  autoReconnectOnVisibility: true,
});

// Listen for events
const unsubscribe = client.onIdentityContextChanged((event) => {
  console.log('Context changed:', event.reason);
  
  if (event.reason === 'PermissionsChanged') {
    refreshPermissions();
  } else {
    refreshContext();
  }
});

// Cleanup
await cleanupSignalR();
```

---

### Query Client Module

TanStack Query configuration with optimized caching.

```typescript
import {
  createQueryClient,
  cachePresets,
  createQueryKeyFactory,
  invalidationHelpers,
  type QueryClientConfig,
} from '@mimir/core';
```

#### Setup

```typescript
const queryClient = createQueryClient({
  staleTime: 5 * 60 * 1000,      // 5 minutes
  gcTime: 10 * 60 * 1000,        // 10 minutes
  maxRetries: 3,
  refetchOnWindowFocus: true,
  logger,
  onLogout: () => window.location.href = '/auth/logout',
});
```

#### Cache Presets

```typescript
// Static data (permissions, roles) - long cache
cachePresets.static   // staleTime: 30min, gcTime: 1hr

// Normal data (properties, users)
cachePresets.normal   // staleTime: 5min, gcTime: 10min

// Dynamic data (transactions)
cachePresets.dynamic  // staleTime: 1min, gcTime: 5min

// Realtime data (live status)
cachePresets.realtime // staleTime: 0, gcTime: 1min
```

#### Query Key Factory

```typescript
const propertyKeys = createQueryKeyFactory('properties');

// ['properties']
propertyKeys.all

// ['properties', 'list']
propertyKeys.lists()

// ['properties', 'list', { status: 'active' }]
propertyKeys.list({ status: 'active' })

// ['properties', 'detail', '123']
propertyKeys.detail('123')
```

---

### Logging Module

Structured logging with configurable levels.

```typescript
import {
  createLogger,
  Logger,
  LogLevel,
  type LoggerConfig,
} from '@mimir/core';
```

#### Usage

```typescript
const logger = createLogger({
  minLevel: LogLevel.DEBUG,
  enableConsole: true,
  enableRemote: process.env.NODE_ENV === 'production',
  remoteEndpoint: '/api/logs',
  serviceName: 'dashboard-app',
});

logger.debug('Debug message', { context: 'value' });
logger.info('Info message');
logger.warn('Warning message', error);
logger.error('Error message', error, { userId: '123' });
```

---

## TypeScript Support

All modules are fully typed. Import types as needed:

```typescript
import type {
  // Auth
  AuthConfig,
  SessionData,
  TokenRefreshResult,
  
  // Permissions
  PermissionCode,
  PermissionCheckOptions,
  
  // Tenant
  Tenant,
  TenantState,
  
  // Identity
  IdentityContextData,
  UserInfo,
  TenantMembership,
  
  // API
  APIConfig,
  ProblemDetails,
  APILogger,
  
  // SignalR
  SignalRClientConfig,
  IdentityContextChangedEvent,
  
  // Query
  QueryClientConfig,
  CachePreset,
  
  // Logging
  LogLevel,
  LogEntry,
} from '@mimir/core';
```

---

## Publishing

```bash
# Login to GitHub Packages
npm login --scope=@mimir --registry=https://npm.pkg.github.com

# Build and publish
pnpm build
pnpm publish
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © [Muhammet Emin Üçkan](https://github.com/eminuckan)
