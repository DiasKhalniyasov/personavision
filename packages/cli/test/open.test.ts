import { readFile } from 'node:fs/promises';
import { runPaths } from '@personavision/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validRun } from '../../contract/tests/fixtures.js';
import { openCommand } from '../src/commands/open.js';
import type { RunSummary } from '../src/run-data.js';
import { personavision, startPersonavision } from './cli-process.js';
import { SCREENSHOT, SCREENSHOT_BYTES, temporaryWorkspace } from './workspace.js';
import type { TestWorkspace } from './workspace.js';

/**
 * `personavision open`, asserted over HTTP against the running command. The port is asked
 * for with `--port 0` and read back from the line the command prints, so nothing here
 * hard-codes one, and nothing reaches the network.
 */

describe('personavision open, on a run directory', () => {
  let workspace: TestWorkspace;
  let server: ReturnType<typeof startPersonavision>;
  let base: string;

  beforeAll(async () => {
    workspace = await temporaryWorkspace();
    server = startPersonavision(
      ['open', '--no-open', '--no-build', '--port', '0', '--viewer', workspace.viewerDist],
      workspace.dir,
    );
    base = (await server.waitForLine(/^http:\/\//)).trim();
  }, 30_000);

  afterAll(async () => {
    await server.stop();
    await workspace.cleanup();
  });

  it('prints the URL it serves, and the run it found', () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(server.stdout()).toContain(workspace.runId);
  });

  it('serves the viewer at /', async () => {
    const response = await fetch(base);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('PersonaVision');
  });

  it('lists the run directories at /runs/index.json', async () => {
    const response = await fetch(new URL('runs/index.json', base));

    expect(response.status).toBe(200);
    expect((await response.json()) as RunSummary[]).toEqual([
      {
        runId: workspace.runId,
        name: validRun().task.prompt,
        createdAt: validRun().createdAt,
      },
    ]);
  });

  it('serves run.json, a session and a screenshot byte for byte from disk', async () => {
    const paths = runPaths(workspace.runDir);
    const cases: [string, string, string][] = [
      [`runs/${workspace.runId}/run.json`, paths.run, 'application/json; charset=utf-8'],
      [
        `runs/${workspace.runId}/sessions/S-01.json`,
        paths.session('S-01'),
        'application/json; charset=utf-8',
      ],
      [
        `runs/${workspace.runId}/screenshots/${SCREENSHOT.variant}/${SCREENSHOT.step}.png`,
        paths.screenshot(SCREENSHOT.variant, SCREENSHOT.step),
        'image/png',
      ],
    ];

    for (const [url, file, contentType] of cases) {
      const response = await fetch(new URL(url, base));
      expect(response.status, url).toBe(200);
      expect(response.headers.get('content-type'), url).toBe(contentType);
      expect(Buffer.from(await response.arrayBuffer()), url).toEqual(await readFile(file));
    }
  });

  it('serves the findings byte for byte too', async () => {
    const response = await fetch(new URL(`runs/${workspace.runId}/findings.json`, base));

    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      await readFile(runPaths(workspace.runDir).findings),
    );
  });

  it('serves the screenshot bytes it was given, unchanged', async () => {
    const response = await fetch(
      new URL(
        `runs/${workspace.runId}/screenshots/${SCREENSHOT.variant}/${SCREENSHOT.step}.png`,
        base,
      ),
    );

    expect(Buffer.from(await response.arrayBuffer())).toEqual(SCREENSHOT_BYTES);
  });

  it('refuses a path that leaves the runs root rather than serving it', async () => {
    const response = await fetch(
      new URL(`runs/${workspace.runId}/%2e%2e%2f%2e%2e%2frun.json`, base),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Only the files of a run directory are served');
  });

  it('answers 404 for a run it does not hold, and 405 for anything but a read', async () => {
    const missing = await fetch(new URL('runs/2026-10-24-1402-not-here/run.json', base));
    expect(missing.status).toBe(404);

    const written = await fetch(new URL(`runs/${workspace.runId}/run.json`, base), {
      method: 'POST',
    });
    expect(written.status).toBe(405);
  });

  it('falls through to the app for a screen route, so a hard refresh resolves', async () => {
    const response = await fetch(new URL(`runs/${workspace.runId}/breakdown`, base));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('PersonaVision');
  });
});

describe('personavision open, with nothing in ./runs', () => {
  let workspace: TestWorkspace;
  let server: ReturnType<typeof startPersonavision>;
  let base: string;

  beforeAll(async () => {
    workspace = await temporaryWorkspace({ withRun: false });
    server = startPersonavision(
      ['open', '--no-open', '--no-build', '--port', '0', '--viewer', workspace.viewerDist],
      workspace.dir,
    );
    base = (await server.waitForLine(/^http:\/\//)).trim();
  }, 30_000);

  afterAll(async () => {
    await server.stop();
    await workspace.cleanup();
  });

  it('starts anyway and says what to do about it', () => {
    expect(server.stdout()).toContain('No test under');
    expect(server.stdout()).toContain('pnpm seed:example-run');
  });

  it('serves the app, and an empty list of runs', async () => {
    expect((await fetch(base)).status).toBe(200);

    const response = await fetch(new URL('runs/index.json', base));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
});

describe('personavision open, with a port that is not one', () => {
  it('refuses it rather than binding a port nobody typed', async () => {
    const workspace = await temporaryWorkspace({ withRun: false });
    try {
      for (const value of ['1e3', '0x10', '70000', 'eighty']) {
        const { code, stderr } = await personavision(
          ['open', '--no-build', '--port', value, '--viewer', workspace.viewerDist],
          workspace.dir,
        );

        expect(code, value).not.toBe(0);
        expect(stderr, value).toContain(`--port ${value} is not a port`);
      }
    } finally {
      await workspace.cleanup();
    }
  }, 30_000);
});

describe('personavision open, with the viewer not built', () => {
  it('with --no-build, says to build it and stops', async () => {
    const workspace = await temporaryWorkspace({ withRun: false });
    try {
      const { code, stderr } = await personavision(
        ['open', '--no-build', '--port', '0', '--viewer', `${workspace.viewerDist}-absent`],
        workspace.dir,
      );

      expect(code).not.toBe(0);
      expect(stderr).toContain('The viewer is not built');
      expect(stderr).toContain('pnpm build');
    } finally {
      await workspace.cleanup();
    }
  });

  it('builds it first, says it is doing so, and then serves it', async () => {
    const workspace = await temporaryWorkspace();
    const lines: string[] = [];
    const opened: string[] = [];
    // The build is this test's, not pnpm's: what is asserted is that `open` builds before
    // it serves, and serves what the build produced.
    const built = `${workspace.viewerDist}-built`;
    const server = await openCommand({
      runsRoot: workspace.runsRoot,
      viewerDist: built,
      repoRoot: workspace.dir,
      port: 0,
      build: true,
      openBrowser: true,
      log: (line) => lines.push(line),
      buildViewer: async () => {
        const { cp } = await import('node:fs/promises');
        await cp(workspace.viewerDist, built, { recursive: true });
      },
      launchBrowser: async (url) => void opened.push(url),
    });

    try {
      expect(lines[0]).toContain('The viewer is not built yet. Building it');
      expect((await fetch(server.url)).status).toBe(200);
      expect(opened).toEqual([server.url]);
    } finally {
      await server.close();
      await workspace.cleanup();
    }
  });
});
