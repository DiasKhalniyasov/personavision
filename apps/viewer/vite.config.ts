import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * `docs/design/tokens.css` lives outside this app and is imported, never copied, so this
 * directory is a build input. The bundler reads it straight off disk. The dev server
 * serves a file from outside the app root only from an allowed directory: Vite already
 * infers the workspace root from `pnpm-workspace.yaml`, but naming the one directory the
 * app actually reaches into states the dependency and keeps the rest of the repository
 * off the dev server.
 */
const designDir = fileURLToPath(new URL('../../docs/design', import.meta.url));

/** The run directories, read from the repository root the same way the CLI reads them. */
const runsRoot = fileURLToPath(new URL('../../runs', import.meta.url));

/**
 * The run data, over the documented read-only paths. This is the mount `packages/cli`
 * implements and `personavision open` serves — imported, not reimplemented — so a
 * developer running `pnpm dev` reads the identical URLs the shipped app does.
 *
 * It is imported when the dev server starts rather than when this file is read: Vite
 * externalises a configuration file's package imports into the bundle it loads the
 * configuration from, so a static import here would pull the command line in every time
 * anything merely *reads* this configuration, `vite build` included.
 *
 * `@personavision/cli` is a workspace dependency, so its `dist/` has to exist by then,
 * which `pnpm typecheck` and `pnpm build` both see to.
 */
const runData = (): Plugin => ({
  name: 'personavision-run-data',
  async configureServer(server) {
    const { runDataMount } = await import('@personavision/cli');
    server.middlewares.use(runDataMount({ runsRoot }));
  },
});

export default defineConfig({
  plugins: [react(), runData()],
  server: {
    fs: {
      allow: [designDir],
    },
  },
});
