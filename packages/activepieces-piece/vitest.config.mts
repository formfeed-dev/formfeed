import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/activepieces-piece',
  resolve: {
    // PieceCategory where the piece imports it (see support/framework.ts)
    alias: [
      {
        find: /^@activepieces\/pieces-framework$/,
        replacement: fileURLToPath(new URL('./support/framework.ts', import.meta.url)),
      },
    ],
  },
  test: {
    name: 'activepieces-piece',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
  },
}));
