import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * `docs/design/tokens.css` lives outside this app and is imported, never copied, so the
 * repository root is a build input. The bundler reads it straight off disk; the dev
 * server only serves a file outside the app root once that root is allowed here.
 */
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [repositoryRoot],
    },
  },
});
