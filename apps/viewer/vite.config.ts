import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * `docs/design/tokens.css` lives outside this app and is imported, never copied, so this
 * directory is a build input. The bundler reads it straight off disk. The dev server
 * serves a file from outside the app root only from an allowed directory: Vite already
 * infers the workspace root from `pnpm-workspace.yaml`, but naming the one directory the
 * app actually reaches into states the dependency and keeps the rest of the repository
 * off the dev server.
 */
const designDir = fileURLToPath(new URL('../../docs/design', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [designDir],
    },
  },
});
