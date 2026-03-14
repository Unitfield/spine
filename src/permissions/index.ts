/**
 * Permissions Module
 * 
 * Role-based access control system with React hooks and components.
 * 
 * @example
 * ```tsx
 * import { usePermission, ProtectedButton } from '@eminuckan/spine/permissions';
 * 
 * function MyComponent() {
 *   const canEdit = usePermission('Identity.Users.Edit');
 *   
 *   return (
 *     <ProtectedButton permission="Identity.Users.Create">
 *       Create User
 *     </ProtectedButton>
 *   );
 * }
 * ```
 */

// Types
export type {
  PermissionCode,
  PermissionModule,
  PermissionCheckOptions,
  PermissionCheckResult,
  FieldPermissionResult,
} from './types';

// Permission service
export { PermissionChecker } from './permission-service';

// Store and initializer
export {
  usePermissionStore,
  initializePermissions,
  getPermissionChecker,
  getPermissions,
} from './permission-store';
export { PermissionInitializer } from './permission-initializer';

// Hooks
export {
  usePermission,
  useHasPermission,
  usePermissions,
  useHasPermissions,
  useModulePermission,
  useHasModulePermission,
  usePermissionChecker,
  useAllPermissions,
} from './hooks';

// Components
export {
  ProtectedButton,
  ProtectedLink,
  ProtectedSection,
  ProtectedAction,
} from './components';

// Constants
export { PERMISSION_MODULES } from './constants';
