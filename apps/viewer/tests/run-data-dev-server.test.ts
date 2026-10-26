import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { listRunDirs, runPaths } from '@personavision/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Plugin, ViteDevServer } from 'vite';
import config from '../vite.config';

/**
 * The dev server reads the same run-data URLs the shipped app does, because it mounts the
 * same middleware. This asserts it by taking the plugin out of the real configuration and
 * running what it registers, rather than by reading the file and trusting it.
 */

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

const RUNS_ROOT = fileURLToPath(new URL('../../../runs', import.meta.url));

/** The middleware the dev-server plugin registers, in the order it registers it. */
const devServerMiddlewares = async (): Promise<Middleware[]> => {
  const plugins = (config.plugins ?? []).flat(2) as Plugin[];
  const runData = plugins.find((plugin) => plugin?.name === 'personavision-run-data');
  expect(runData, 'the dev server mounts the run data').toBeDefined();

  const registered: Middleware[] = [];
  const stack = { use: (handler: Middleware) => registered.push(handler) };
  const configureServer = runData?.configureServer;
  const hook = typeof configureServer === 'function' ? configureServer : configureServer?.handler;
  await hook?.call(
    // Vite hands the plugin its dev server; the mount uses one thing on it.
    {} as never,
    { middlewares: stack } as unknown as ViteDevServer,
  );
  return registered;
};

describe('the viewer dev server', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const middlewares = await devServerMiddlewares();
    server = createServer((request, response) => {
      const run = (index: number): void => {
        const middleware = middlewares[index];
        if (middleware === undefined) {
          response.writeHead(404).end();
          return;
        }
        middleware(request, response, () => run(index + 1));
      };
      run(0);
    });
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((closed) => server.close(() => closed()));
  });

  it('lists the repository’s run directories at /runs/index.json', async () => {
    const [runId] = await listRunDirs(RUNS_ROOT);
    expect(runId, 'the repository holds the committed example run').toBeDefined();

    const response = await fetch(new URL('runs/index.json', base));

    expect(response.status).toBe(200);
    // The order the listing comes back in is its own and is asserted where it is
    // implemented, in `packages/cli/test/run-index.test.ts`. What matters here is that the
    // dev server answers this URL with the repository's runs in it.
    const listed = (await response.json()) as { runId: string }[];
    expect(listed.map((entry) => entry.runId)).toContain(runId);
  });

  it('serves a run file at the same path the shipped app reads', async () => {
    const [runId] = await listRunDirs(RUNS_ROOT);

    const response = await fetch(new URL(`runs/${runId as string}/run.json`, base));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      await readFile(runPaths(`${RUNS_ROOT}/${runId as string}`).run),
    );
  });
});
