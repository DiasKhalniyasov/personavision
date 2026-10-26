import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDataMount } from '../src/run-data.js';
import type { RunDataMountOptions, RunSummary } from '../src/run-data.js';
import { writeRunAt } from './workspace.js';

/**
 * The mount on its own: what it refuses, and the scoping `personavision serve` adds above
 * it by naming the runs one request may see.
 */

const mounted = async (
  options: RunDataMountOptions,
): Promise<{ base: string; close: () => Promise<void> }> => {
  const mount = runDataMount(options);
  const server: Server = createServer((request, response) => {
    mount(request, response, () => {
      // The viewer sits here in the real server; a sentinel says the mount passed it on.
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('the app');
    });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
};

describe('the run-data mount', () => {
  let root: string;
  let runsRoot: string;
  let shown: string;
  let hidden: string;
  let server: { base: string; close: () => Promise<void> };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'personavision-mount-'));
    runsRoot = join(root, 'runs');
    shown = await writeRunAt(runsRoot, {
      stamp: '2026-10-24T14:02:00Z',
      createdAt: '2026-10-24T14:02:00Z',
      name: 'this workspace',
    });
    hidden = await writeRunAt(runsRoot, {
      stamp: '2026-10-25T09:00:00Z',
      createdAt: '2026-10-25T09:00:00Z',
      name: 'another workspace',
    });
    // What `personavision serve` passes: the runs of the workspace the request belongs to.
    server = await mounted({ runsRoot, visibleRuns: () => [shown] });
  });

  afterAll(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('lists only the runs the request may see', async () => {
    const listed = (await (
      await fetch(new URL('runs/index.json', server.base))
    ).json()) as RunSummary[];

    expect(listed.map((entry) => entry.runId)).toEqual([shown]);
  });

  it('answers 404, not 403, for a run the request may not see', async () => {
    const response = await fetch(new URL(`runs/${hidden}/run.json`, server.base));

    // 404 and not 403: that another workspace holds a run is not this mount's to disclose.
    expect(response.status).toBe(404);
  });

  it('refuses a symbolic link that leaves the run directory', async () => {
    const secret = join(root, 'secret.json');
    await writeFile(secret, '{"not":"run data"}\n');
    await symlink(secret, join(runsRoot, shown, 'leak.json'));

    const response = await fetch(new URL(`runs/${shown}/leak.json`, server.base));

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('not');
  });

  it('serves a file whose own name begins with dots', async () => {
    await writeFile(join(runsRoot, shown, '..keep.json'), '{"kept":true}\n');

    const response = await fetch(new URL(`runs/${shown}/..keep.json`, server.base));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kept: true });
  });

  it('names the methods it serves when asked for a write', async () => {
    const response = await fetch(new URL(`runs/${shown}/run.json`, server.base), {
      method: 'POST',
    });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('names the path that was asked for, never the path on disk', async () => {
    const response = await fetch(new URL(`runs/${shown}/sessions/S-99.json`, server.base));

    expect(response.status).toBe(404);
    const said = await response.text();
    expect(said).toContain(`/runs/${shown}/sessions/S-99.json`);
    expect(said).not.toContain(runsRoot);
  });

  it('passes a path that names no artifact file on to the app', async () => {
    for (const route of [`runs/${shown}`, `runs/${shown}/breakdown`, `runs/${shown}/sessions`]) {
      const response = await fetch(new URL(route, server.base));
      expect(response.status, route).toBe(200);
      expect(await response.text(), route).toBe('the app');
    }
  });
});
