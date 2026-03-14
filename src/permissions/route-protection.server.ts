import { PermissionChecker } from './permission-service';
import type { PermissionCheckOptions, PermissionCode } from './types';

export interface PermissionRouteSession {
  user?: {
    sub?: string;
    email?: string | null;
  } | null;
  accessToken?: string | null;
}

export interface PermissionRouteContext {
  permissions: PermissionCode[];
  currentTenant?: string | null;
}

export interface ForbiddenPermissionDetails {
  request: Request;
  permission: PermissionCode | PermissionCode[];
  permissionsToCheck: PermissionCode[];
  missingPermissions?: PermissionCode[];
  options: PermissionCheckOptions;
  session: PermissionRouteSession;
  context: PermissionRouteContext;
}

export interface PermissionRouteProtectionConfig {
  getSession?: (request: Request) => Promise<PermissionRouteSession>;
  resolveContext?: (
    request: Request,
    session: PermissionRouteSession
  ) => Promise<PermissionRouteContext>;
  createUnauthorizedResponse?: (
    request: Request,
    session: PermissionRouteSession
  ) => Response;
  createForbiddenResponse?: (details: ForbiddenPermissionDetails) => Response;
}

const DEFAULT_UNAUTHORIZED_RESPONSE = () =>
  new Response('Unauthorized', {
    status: 401,
    statusText: 'You must be logged in to access this resource',
  });

const DEFAULT_FORBIDDEN_RESPONSE = (details: ForbiddenPermissionDetails) => {
  const message =
    process.env.NODE_ENV === 'development'
      ? `Missing permissions: ${details.missingPermissions?.join(', ')}`
      : "You don't have permission to access this resource";

  return new Response(message, {
    status: 403,
    statusText: 'Forbidden',
  });
};

let permissionRouteProtectionConfig: PermissionRouteProtectionConfig = {};

function getPermissionRouteProtectionConfig(): Required<PermissionRouteProtectionConfig> {
  if (!permissionRouteProtectionConfig.getSession) {
    throw new Error(
      'Permission route protection session getter not configured. Call configurePermissionRouteProtection first.'
    );
  }

  if (!permissionRouteProtectionConfig.resolveContext) {
    throw new Error(
      'Permission route protection context resolver not configured. Call configurePermissionRouteProtection first.'
    );
  }

  return {
    getSession: permissionRouteProtectionConfig.getSession,
    resolveContext: permissionRouteProtectionConfig.resolveContext,
    createUnauthorizedResponse:
      permissionRouteProtectionConfig.createUnauthorizedResponse || DEFAULT_UNAUTHORIZED_RESPONSE,
    createForbiddenResponse:
      permissionRouteProtectionConfig.createForbiddenResponse || DEFAULT_FORBIDDEN_RESPONSE,
  };
}

export function configurePermissionRouteProtection(
  config: PermissionRouteProtectionConfig
): void {
  permissionRouteProtectionConfig = {
    ...permissionRouteProtectionConfig,
    ...config,
  };
}

export function resetPermissionRouteProtection(): void {
  permissionRouteProtectionConfig = {};
}

async function getPermissionRouteState(request: Request): Promise<{
  config: Required<PermissionRouteProtectionConfig>;
  session: PermissionRouteSession;
  context: PermissionRouteContext;
}> {
  const config = getPermissionRouteProtectionConfig();
  const session = await config.getSession(request);
  const context = await config.resolveContext(request, session);

  return {
    config,
    session,
    context,
  };
}

export async function requirePermission(
  request: Request,
  permission: PermissionCode | PermissionCode[],
  options: PermissionCheckOptions = {}
): Promise<void> {
  const { config, session, context } = await getPermissionRouteState(request);

  if (!session.user || !session.accessToken) {
    throw config.createUnauthorizedResponse(request, session);
  }

  const checker = new PermissionChecker(context.permissions || []);
  const permissionsToCheck = Array.isArray(permission) ? permission : [permission];
  const result = checker.hasPermissions(permissionsToCheck, options);

  if (!result.hasPermission) {
    throw config.createForbiddenResponse({
      request,
      permission,
      permissionsToCheck,
      missingPermissions: result.missingPermissions,
      options,
      session,
      context,
    });
  }
}

export async function checkPermission(
  request: Request,
  permission: PermissionCode | PermissionCode[],
  options: PermissionCheckOptions = {}
): Promise<boolean> {
  try {
    await requirePermission(request, permission, options);
    return true;
  } catch {
    return false;
  }
}

export function withPermission<TLoaderData>(
  permission: PermissionCode | PermissionCode[],
  loader: (args: any) => Promise<TLoaderData>,
  options?: PermissionCheckOptions
) {
  return async (args: any): Promise<TLoaderData> => {
    await requirePermission(args.request, permission, options);
    return loader(args);
  };
}
