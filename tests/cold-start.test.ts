import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findingsSchema,
  readRun,
  runPaths,
  runSchema,
  sessionSchema,
} from '@personavision/contract';
import type { RunArtifact } from '@personavision/contract';

/**
 * The cold start: what a developer who has just cloned this repository does, asserted end
 * to end. Everything else in this step is tested in isolation against a temporary run
 * directory; this file is the one place where the contract, the command line, the built
 * viewer and the **committed** example run are exercised as one thing.
 *
 * It builds the workspace, starts the server `personavision open --no-open` starts — the
 * internal command deliberately, so that this test does not wait on sign-in — and reads
 * the artifact back over the URLs `docs/adr/0001-run-data-over-http-as-static-files.md`
 * fixes. Nothing here reaches a network beyond the loopback port it started, and the
 * command is given an environment holding nothing but a path and a home, so a cold start
 * that had come to need a credential would fail here rather than in a demo.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** The committed example run: the artifact a fresh clone finds under `runs/`. */
const RUN_ID = '2026-10-24-1402-northwind-demo';
const runDir = join(repoRoot, 'runs', RUN_ID);

/** The `personavision` binary as `pnpm build` leaves it — `packages/cli/package.json`'s `bin`. */
const CLI = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');

/** The root script CI runs after the build, and the one a developer types. */
const VALIDATE_SCRIPT = 'pnpm validate:example-run';

/** The layout, addressed relatively: on the wire these are the paths under `/runs/<runId>/`. */
const layout = runPaths('');

/** A whole workspace build and a server start, on a machine that has just cloned. */
const COLD_START_TIMEOUT = 300_000;

/**
 * What a command is given: the two variables a process needs to find its interpreter and
 * its home, and nothing else. "No API key and no network" is a claim about this sequence,
 * and the way to assert it is to run the sequence with an environment that holds neither.
 */
const PASSED_THROUGH = ['PATH', 'HOME'] as const;

const bareEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(PASSED_THROUGH.map((name) => [name, process.env[name]]));

interface FinishedCommand {
  code: number | null;
  /** Both streams, interleaved as whoever ran it reads them. */
  output: string;
}

const runToCompletion = (
  command: string,
  args: readonly string[],
  cwd = repoRoot,
): Promise<FinishedCommand> =>
  new Promise((finished, failed) => {
    const child = spawn(command, args, {
      cwd,
      env: bareEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: string): void => void (output += chunk);
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    child.on('error', failed);
    child.on('close', (code) => finished({ code, output }));
  });

interface ServedApp {
  /** The address the command printed, on the port it was actually given. */
  base: string;
  /** `true` once the process is gone. */
  exited: () => boolean;
  stop: () => Promise<void>;
}

/** The line `open` prints, and the only place this file learns which port it is on. */
const URL_LINE = /^http:\/\/127\.0\.0\.1:\d+\/$/;

/**
 * `personavision open --no-open`, started the way the demo's first beat starts it, on a
 * port the operating system picks. `--no-build` is deliberate: the build has already run,
 * and a viewer missing at this point is a failure of that build rather than something for
 * an assertion to paper over by quietly rebuilding.
 */
const openTheApp = async (): Promise<ServedApp> => {
  const child = spawn(process.execPath, [CLI, 'open', '--no-open', '--no-build', '--port', '0'], {
    cwd: repoRoot,
    env: bareEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exited = false;
  let failedToStart: Error | undefined;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.on('close', () => (exited = true));
  // A spawn that never starts emits `error`, and an unheard one would take the whole test
  // worker down with it rather than failing the start this function is reporting on.
  child.on('error', (error: Error) => {
    failedToStart = error;
    exited = true;
  });

  const stop = (): Promise<void> =>
    new Promise<void>((stopped) => {
      if (exited) {
        stopped();
        return;
      }
      child.on('close', () => stopped());
      child.kill('SIGTERM');
    });

  const line = await new Promise<string>((printed, failed) => {
    const look = (): boolean => {
      const found = stdout.split('\n').find((candidate) => URL_LINE.test(candidate.trim()));
      if (found === undefined) return false;
      printed(found.trim());
      return true;
    };
    if (look()) return;
    const poll = setInterval(() => {
      if (look()) {
        clearInterval(poll);
        return;
      }
      if (exited) {
        clearInterval(poll);
        const why =
          failedToStart === undefined
            ? 'exited before printing its URL'
            : `could not be started: ${failedToStart.message}`;
        failed(new Error(`personavision open ${why}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    }, 25);
  });

  return { base: line, exited: () => exited, stop };
};

const get = (base: string, path: string): Promise<Response> => fetch(new URL(path, base));

const getJson = async (base: string, path: string): Promise<unknown> => {
  const response = await get(base, path);
  if (!response.ok) throw new Error(`GET ${path} answered ${String(response.status)}`);
  return response.json();
};

/** One entry of `GET /runs/index.json`, as the ADR fixes it. */
interface RunListing {
  runId: string;
  name: string;
  createdAt: string;
}

/**
 * The whole run artifact, assembled from the documented URLs and parsed by the contract —
 * the same value `readRun` produces from the directory on disk, if the wire agrees.
 */
const readRunOverHttp = async (base: string): Promise<RunArtifact> => {
  const under = (path: string): string => `runs/${RUN_ID}/${path}`;
  const run = runSchema.parse(await getJson(base, under(layout.run)));
  const findings = findingsSchema.parse(await getJson(base, under(layout.findings)));
  const sessions = await Promise.all(
    run.sessionIds.map(async (sessionId) =>
      sessionSchema.parse(await getJson(base, under(layout.session(sessionId)))),
    ),
  );
  return { run, sessions, findings };
};

/**
 * One cold start, used and then stopped however it ends — including when an assertion
 * inside it throws, which would otherwise leave a command running and a port held by a
 * suite whose whole claim is that it leaves neither behind.
 */
const withTheApp = async <Read>(
  use: (app: ServedApp) => Promise<Read>,
): Promise<[Read, ServedApp]> => {
  const app = await openTheApp();
  try {
    return [await use(app), app];
  } finally {
    await app.stop();
  }
};

/** The build a new developer runs before anything can be served. */
beforeAll(async () => {
  const built = await runToCompletion('pnpm', ['build']);
  expect(built.code, built.output).toBe(0);
}, COLD_START_TIMEOUT);

describe('a fresh clone builds, and the app opens on the committed example run', () => {
  let served: ServedApp | undefined;
  let base: string;
  let onDisk: RunArtifact;

  beforeAll(async () => {
    onDisk = await readRun(runDir);
    served = await openTheApp();
    base = served.base;
  }, COLD_START_TIMEOUT);

  // `undefined` whenever the start above threw, which is one of the cases this suite
  // exists to catch: the failure that matters is reported, rather than a second one
  // about tearing down something that never came up.
  afterAll(async () => {
    await served?.stop();
  });

  it('serves the built viewer at /, and the bundle its document names', async () => {
    const page = await get(base, '/');

    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('PersonaVision');

    // The built document, not `apps/viewer/index.html`, which says PersonaVision too: what
    // is asserted is that the build's own bundle is there and is served.
    const bundle = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    if (bundle === undefined) throw new Error(`the page names no script:\n${html}`);
    expect(bundle).toMatch(/^\/assets\//);
    expect((await get(base, bundle)).status).toBe(200);
  });

  it('lists the committed example run first at /runs/index.json', async () => {
    const response = await get(base, 'runs/index.json');

    expect(response.status).toBe(200);
    const listing = (await response.json()) as RunListing[];
    expect(listing.find((entry) => entry.runId === RUN_ID)).toEqual({
      runId: RUN_ID,
      name: onDisk.run.task.prompt,
      createdAt: onDisk.run.createdAt,
    });
    // First, because a fresh clone holds this run and no other, and the listing is ordered
    // by each run's own `createdAt`. A developer who has since run a test of their own has
    // a newer directory under `./runs`, and this is the assertion that says so.
    expect(listing[0].runId).toBe(RUN_ID);
  });

  it('serves run.json, and the contract parses what comes back', async () => {
    const response = await get(base, `runs/${RUN_ID}/${layout.run}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const parsed = runSchema.safeParse(await response.json());
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it('serves a session and a screenshot that run names, byte for byte', async () => {
    const sessionId = onDisk.run.sessionIds[0];
    const screenshot = onDisk.run.screenshots[0];
    const cases: [string, string, string][] = [
      [
        layout.session(sessionId),
        runPaths(runDir).session(sessionId),
        'application/json; charset=utf-8',
      ],
      [screenshot.path, join(runDir, screenshot.path), 'image/png'],
    ];

    for (const [path, file, contentType] of cases) {
      const response = await get(base, `runs/${RUN_ID}/${path}`);

      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toBe(contentType);
      expect(Buffer.from(await response.arrayBuffer()), path).toEqual(await readFile(file));
    }
  });

  it('serves the same artifact over HTTP as the contract reads from disk', async () => {
    expect(await readRunOverHttp(base)).toEqual(onDisk);
  });
});

describe('the command leaves nothing behind, so the cold start runs twice in a row', () => {
  it(
    'frees its process, and a second start serves the same listing',
    async () => {
      const read = (app: ServedApp): Promise<unknown> => getJson(app.base, 'runs/index.json');
      const [listing, first] = await withTheApp(read);

      // The listener is the process's own socket and nothing else holds it, so a command
      // that is gone is a port that is free. The port itself is deliberately not probed:
      // the operating system is free to hand a just-freed one to a sibling suite binding
      // `--port 0` at that moment, which would fail on a perfectly healthy tree.
      expect(first.exited()).toBe(true);

      const [again, second] = await withTheApp(read);

      expect(again).toEqual(listing);
      expect(second.exited()).toBe(true);
    },
    COLD_START_TIMEOUT,
  );
});

describe('the gate CI runs over the committed example run', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const steps = [...workflow.matchAll(/^\s*-\s*run:\s*(.+?)\s*$/gm)].map((match) => match[1]);

  it('validates the committed example run, and says so', async () => {
    const validated = await runToCompletion('pnpm', ['validate:example-run']);

    expect(validated.code, validated.output).toBe(0);
    expect(validated.output).toContain(`runs/${RUN_ID} is a valid run directory.`);
  }, 120_000);

  it('rejects a fixture that has drifted from the schemas, so the job fails', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'personavision-drifted-'));
    const drifted = join(elsewhere, RUN_ID);
    try {
      await cp(runDir, drifted, { recursive: true });
      // One field renamed, which is what a schema change that leaves the fixture behind
      // looks like from the fixture's side.
      const run = JSON.parse(await readFile(runPaths(drifted).run, 'utf8')) as Record<
        string,
        unknown
      >;
      run['completedAt'] = run['createdAt'];
      delete run['createdAt'];
      await writeFile(runPaths(drifted).run, `${JSON.stringify(run, null, 2)}\n`);

      const validated = await runToCompletion(process.execPath, [CLI, 'validate', drifted]);

      expect(validated.code).not.toBe(0);
      expect(validated.output).toContain('is not a valid run directory');
      expect(validated.output).toContain('run.json/createdAt');
      expect(validated.output).toContain('run.json/completedAt');
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  }, 120_000);

  it('is a step of the workflow, after the build', () => {
    const required = ['pnpm typecheck', 'pnpm lint', 'pnpm test', 'pnpm build', VALIDATE_SCRIPT];

    expect(required.filter((step) => !steps.includes(step))).toEqual([]);
    const positions = required.map((step) => steps.indexOf(step));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('runs with nothing in the environment, and reaches no network but the registry', () => {
    // No `env:` anywhere in the workflow: no step is handed a variable, so none of them
    // can be handed a credential either.
    expect(workflow).not.toMatch(/^\s*env:/m);

    const fetches = /\b(?:curl|wget|npx|nc)\b|git\s+clone/;
    expect(steps.filter((step) => step !== undefined && fetches.test(step))).toEqual([]);
  });
});
