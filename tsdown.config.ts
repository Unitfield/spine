import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    'react-router/index': 'src/react-router/index.ts',
    'react-router/server': 'src/react-router/server.ts',
    'auth/index': 'src/auth/index.ts',
    'auth/server': 'src/auth/server.ts',
    'permissions/index': 'src/permissions/index.ts',
    'tenant/index': 'src/tenant/index.ts',
    'tenant/server': 'src/tenant/server.ts',
    'identity/index': 'src/identity/index.ts',
    'identity/server': 'src/identity/server.ts',
    'api-client/index': 'src/api-client/index.ts',
    'api-client/server': 'src/api-client/server.ts',
    'logging/index': 'src/logging/index.ts',
    'signalr/index': 'src/signalr/index.ts',
    'query-client/index': 'src/query-client/index.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    'react',
    'react-dom',
    '@tanstack/react-query',
  ],
  // Tree-shaking
  treeshake: true,
  // React JSX
  esbuildOptions: {
    jsx: 'automatic',
  },
});
