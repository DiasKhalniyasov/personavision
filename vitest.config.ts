import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `apps/viewer` is a Vite app and its shadcn registry files import `@/…`, the alias
      // its own `vite.config.ts` and `tsconfig.json` declare. Vitest reads this file
      // rather than the app's, so the alias is stated here too; nothing outside that app
      // uses it.
      '@': fileURLToPath(new URL('./apps/viewer/src', import.meta.url)),
    },
  },
  test: {
    // Root-level `tests/` is picked up already, so an integration ticket adds a test file
    // rather than editing this configuration.
    include: [
      'tests/**/*.{test,spec}.ts',
      'packages/*/{src,test,tests}/**/*.{test,spec}.ts',
      'apps/*/{src,tests}/**/*.{test,spec}.{ts,tsx}',
      'demo/*/test/**/*.{test,spec}.ts',
    ],
    // Node is the default because nothing here needs a DOM. A suite that does declares it
    // per file with a `// @vitest-environment jsdom` docblock and adds its own dependency,
    // so no package has to edit this file.
    environment: 'node',
  },
});
