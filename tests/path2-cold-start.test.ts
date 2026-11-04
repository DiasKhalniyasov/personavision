import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeSession, openSession } from '@personavision/browser';
import { readRun, runPaths, validate, writeRun } from '@personavision/contract';
import { CHROMIUM_INSTALLED } from '../packages/browser/test/helpers/chromium.js';
import { TOKEN } from '../packages/improve/tests/loop/fixture.js';
import {
  HOLDOUT_SIZE,
  RUN_ID,
  walkPathTwo,
} from '../packages/improve/tests/walkthrough/fixture.js';
import type { Device, PageHandle } from '@personavision/browser';
import type { Run } from '@personavision/contract';

/**
 * **Path 2, walked from a cold start, on the screen** (#307).
 *
 * `packages/improve/tests/walkthrough/` walks the loop: the change, the pull request, the
 * preview, the holdout, the before/after and the comment, over the recorded repository with
 * no credential and no network. This file is the other half of that walk — the half a green
 * jsdom run does not answer. It takes the path-2 runs that walk produces, serves each one
 * with the command a fresh clone types (`personavision open`), and drives the **Improve
 * screen of the built application** in a real browser, because layout, stacking and the
 * minified stylesheet are not things a virtual DOM has an opinion about.
 *
 * Four faces are walked, and they are the states `#screen-improve` declares:
 *
 * - **locked** — no repository connected, which is what nearly every user sees first, and
 *   the one state that must never be wrong: it names what connecting gives, states the
 *   permissions, says *PersonaVision never merges it*, and its control goes to
 *   `/settings/github`. Walked twice: with the GitHub App unregistered, which is the
 *   product today (#231), and with it registered and nothing connected.
 * - **loading** — the heading, the lede and the lock are on the page before the connection
 *   answer arrives, and nothing moves when it does.
 * - **connected** — the pull request box with the title, the repository and its state, the
 *   recommendation, the diff, the preview and the *Tested with* row, and the before/after's
 *   three figures with their people counts, read from the run's own stored scores. Walked
 *   on both verdicts: **confirmed**, and **not confirmed**, where the sentence says so and
 *   the figures carry no win framing.
 * - **error** — a run whose change was never served anywhere shows the reason in place of
 *   the preview, and draws no before/after at all.
 *
 * **It builds nothing.** The built CLI and the built viewer are what CI's `pnpm typecheck`
 * and `pnpm build` leave behind, and a missing one is that build's failure rather than
 * something for this suite to paper over by quietly rebuilding — `tests/cold-start.test.ts`
 * is the suite that owns the build. Without Chromium the browser half is skipped, with the
 * reason in the name; CI installs Chromium before `pnpm test`, so CI is never skipped.
 *
 * **Nothing here reaches a network.** The command is given an environment holding a path and
 * a home and nothing else, every request the page makes to anywhere but the loopback port is
 * aborted and reported, and the two platform routes the viewer asks for — the session and the
 * GitHub connection, which `personavision open` does not serve — are answered in the browser.
 *
 * To **watch** it rather than read it, set `PERSONAVISION_PATH2_DIR` to a directory: the runs
 * are staged there and kept, and the suite prints the `personavision open` line for each.
 */

/**
 * The two browser globals the functions this file hands to the page use.
 *
 * They run in Chromium and not in Node, and the root TypeScript project declares no DOM
 * library — stating them here is how a page function is typed without pulling `lib.dom` into
 * everything under `tests/`.
 */
declare const document: {
  readonly documentElement: { readonly scrollWidth: number; readonly clientWidth: number };
  querySelector: (selector: string) => { readonly textContent: string | null } | null;
};
declare const getComputedStyle: (element: unknown) => { readonly backgroundColor: string };

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** The `personavision` binary as `pnpm build` leaves it — `packages/cli/package.json`'s `bin`. */
const CLI = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');

/** The built viewer `personavision open` serves, which the same build leaves behind. */
const VIEWER = join(repoRoot, 'apps', 'viewer', 'dist', 'index.html');

/** Staging three runs, three server starts and one browser over them. */
const WALK_TIMEOUT = 180_000;
const FACE_TIMEOUT = 60_000;

/** Where a person who wants to click through it asks for the runs to be left. */
const KEEP = process.env['PERSONAVISION_PATH2_DIR'];

/**
 * What a command is given: the two variables a process needs to find its interpreter and its
 * home, and nothing else. "No API key and no network" is a claim about this sequence, and
 * the way to assert it is to run the sequence with an environment that holds neither.
 */
const PASSED_THROUGH = ['PATH', 'HOME'] as const;

const bareEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(PASSED_THROUGH.map((name) => [name, process.env[name]]));

/** The line `open` prints, and the only place this file learns which port it is on. */
const URL_LINE = /^http:\/\/127\.0\.0\.1:\d+\/$/;

interface ServedApp {
  readonly base: string;
  readonly log: () => string;
  readonly stop: () => Promise<void>;
}

/**
 * `personavision open --no-open`, from the directory the runs were staged in, on a port the
 * operating system picks. `--no-build` is deliberate, for the reason in this file's header.
 */
const openTheApp = async (cwd: string): Promise<ServedApp> => {
  const child = spawn(process.execPath, [CLI, 'open', '--no-open', '--no-build', '--port', '0'], {
    cwd,
    env: bareEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exited = false;
  let failedToStart: Error | undefined;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => void (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => void (stderr += chunk));
  child.on('close', () => void (exited = true));
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

  const base = await new Promise<string>((printed, failed) => {
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
            ? `exited before printing its URL\nstdout:\n${stdout}\nstderr:\n${stderr}`
            : `could not be started: ${failedToStart.message}`;
        failed(new Error(`personavision open ${why}`));
      }
    }, 25);
  });

  return { base, log: () => stdout, stop };
};

/** The three faces' runs, each staged in a directory of its own. */
interface Staged {
  readonly root: string;
  readonly runDir: string;
  readonly run: Run;
}

const stageDir = async (what: string): Promise<string> => {
  if (KEEP === undefined) return mkdtemp(join(tmpdir(), `personavision-path2-${what}-`));
  const directory = join(KEEP, what);
  await mkdir(join(directory, 'runs'), { recursive: true });
  return directory;
};

/**
 * One path-2 run, written where `personavision open` reads runs from: `./runs`, under the
 * directory the command is run in.
 *
 * Each face gets a directory of its own because a path-2 run is named after the path-1 run it
 * improves — which is the whole of the loop's idempotence (#306) — so two walks of the same
 * run are the same run id, and the second resumes rather than landing beside the first.
 */
const stage = async (what: string, went: 'confirmed' | 'not_confirmed'): Promise<Staged> => {
  const root = await stageDir(what);
  const walk = await walkPathTwo({ went, runsRoot: join(root, 'runs') });
  if (walk.result.kind !== 'finished') {
    throw new Error(
      `the ${what} walk did not finish: ${walk.result.kind === 'stopped' ? `${walk.result.step} — ${walk.result.reason}` : walk.result.kind}`,
    );
  }
  return { root, runDir: walk.runDir, run: walk.result.run };
};

/**
 * The fourth face's run: a change that was opened and **never served anywhere**.
 *
 * It is staged by rewriting one block of the confirmed run rather than by walking the loop,
 * and the reason is worth stating: a loop stopped at the preview step records a **failed**
 * run carrying no change at all (`stoppedRunRecord` in `packages/improve/src/loop.ts`), so
 * the artifact the screen's error state is built for — a run that carries its change and a
 * preview that is a stated nothing — is one the platform's contract holds and this loop does
 * not write today. That gap is named in `docs/demo.md`; the face is walked here because it is
 * what a user sees the moment a repository without a per-pull-request preview is connected.
 */
const stageWithoutPreview = async (from: Staged): Promise<Staged> => {
  const root = await stageDir('no-preview');
  const artifact = await readRun(from.runDir);
  const improve = artifact.run.improve;
  if (improve === undefined) throw new Error('the confirmed run carries no change');
  const runDir = join(root, 'runs', RUN_ID);
  const run: Run = {
    ...artifact.run,
    improve: {
      ...improve,
      preview: {
        url: null,
        reason:
          'clipforge/web publishes no preview deployment for this pull request, and PersonaVision never runs your build.',
      },
    },
  };
  await writeRun(runDir, {
    run,
    sessions: [...artifact.sessions],
    findings: artifact.findings,
  });
  return { root, runDir, run };
};

/** A value that has to be there, or a failure naming what was looked for. */
const must = <Value>(value: Value | null | undefined, what: string): Value => {
  if (value === null || value === undefined) throw new Error(`there is no ${what}`);
  return value;
};

type Page = PageHandle['page'];

/** The GitHub connection, as the two screens that read it parse the platform's answer. */
type Connection =
  | { registered: false; connection: null }
  | { registered: true; connection: null }
  | { registered: true; connection: { repository: string } };

const DISCONNECTED: Connection = { registered: true, connection: null };
const UNREGISTERED: Connection = { registered: false, connection: null };
const CONNECTED: Connection = { registered: true, connection: { repository: 'clipforge/web' } };

interface Driven {
  readonly page: Page;
  /** What the platform answers for the connection, and how long it takes to answer. */
  readonly connection: (answer: Connection, delayMs?: number) => void;
  /** Every request the page made to somewhere other than the server under test. */
  readonly offMachine: () => readonly string[];
  readonly close: () => Promise<void>;
}

/**
 * One Chromium page over a served app, with the two platform routes answered and everything
 * that is not this server refused.
 *
 * The browser is `@personavision/browser`'s own launcher, used rather than forked: the swarm
 * is the one place this repository starts Chromium, and this walk is another caller of it.
 */
const driveOver = async (base: string, device: Device): Promise<Driven> => {
  const handle = await openSession({ id: 'path2-cold-start', url: base }, device);
  const offMachine: string[] = [];
  const origin = new URL(base).origin;
  let answer: Connection = DISCONNECTED;
  let delayMs = 0;

  try {
    // The catch-all goes on first **on purpose**: Playwright uses the route registered
    // last, so the two specific answers below have to be registered after it or the
    // session request would be served the app's own `index.html` and the screen would
    // decide nobody is signed in.
    await handle.context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) {
        void route.continue();
        return;
      }
      offMachine.push(url);
      void route.abort();
    });
    // `personavision open` serves run data and the viewer, and no platform API: the session
    // and the connection are the two answers the screen needs and the command cannot give.
    await handle.context.route(
      '**/auth/session',
      (route) =>
        void route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            signedIn: true,
            workspace: { id: 'northwind-demo', name: 'Northwind Outdoors' },
            account: { email: 'owner@northwind.example', displayName: 'Workspace owner' },
          }),
        }),
    );
    await handle.context.route('**/github/connection', async (route) => {
      if (delayMs > 0) await new Promise((later) => setTimeout(later, delayMs));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(answer),
      });
    });
  } catch (error) {
    await closeSession(handle);
    throw error;
  }

  return {
    page: handle.page,
    connection: (next, holdFor = 0) => {
      answer = next;
      delayMs = holdFor;
    },
    offMachine: () => [...offMachine],
    close: () => closeSession(handle),
  };
};

/** An element's words, with the line breaks of the markup closed up. */
const words = async (page: Page, selector: string): Promise<string> => {
  const text = await page.locator(selector).first().textContent();
  return (text ?? '').replace(/\s+/gu, ' ').trim();
};

const count = (page: Page, selector: string): Promise<number> => page.locator(selector).count();

/** Where an element is drawn, which is the only thing that answers "stacking". */
const boxOf = async (
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number }> =>
  must(await page.locator(selector).first().boundingBox(), `a drawn box for ${selector}`);

/** The elements these selectors name: one each, and drawn in this order down the page. */
const inPageOrder = async (page: Page, selectors: readonly string[]): Promise<void> => {
  const drawn: { selector: string; top: number }[] = [];
  for (const selector of selectors) {
    expect(await count(page, selector), selector).toBe(1);
    drawn.push({ selector, top: (await boxOf(page, selector)).y });
  }
  expect(drawn.map((one) => one.selector)).toEqual(
    [...drawn].sort((left, right) => left.top - right.top).map((one) => one.selector),
  );
};

/** The share out of a hundred, as `apps/viewer/src/screens/verdict/completionBand.ts` says it. */
const percent = (rate: number): number => Math.round(rate * 100);

const desktop: Device = {
  name: 'desktop',
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
  touch: false,
};

/** The phone the project draws every screen at. */
const PHONE_WIDTH = 390;

let confirmed: Staged;
let notConfirmed: Staged;
let withoutPreview: Staged;

beforeAll(async () => {
  for (const [what, path] of [
    ['the built command line', CLI],
    ['the built viewer', VIEWER],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(
        `${what} is not built: ${path} is missing. Run \`pnpm build\` — this walk drives the built application and never builds one.`,
      );
    }
  }
  confirmed = await stage('confirmed', 'confirmed');
  notConfirmed = await stage('not-confirmed', 'not_confirmed');
  withoutPreview = await stageWithoutPreview(confirmed);
  if (KEEP !== undefined) {
    for (const staged of [confirmed, notConfirmed, withoutPreview]) {
      process.stdout.write(
        `  cd ${staged.root} && personavision open   # /runs/${RUN_ID}/improve\n`,
      );
    }
  }
}, WALK_TIMEOUT);

afterAll(async () => {
  if (KEEP !== undefined) return;
  // `undefined` whenever the staging above threw: the failure that matters is reported,
  // rather than a second one about removing something that was never made.
  for (const staged of [confirmed, notConfirmed, withoutPreview]) {
    if (staged !== undefined) await rm(staged.root, { recursive: true, force: true });
  }
}, FACE_TIMEOUT);

describe('the path-2 runs a cold start produces', () => {
  it('carry the change, the pull request, the preview, the holdout and the before and after', async () => {
    for (const staged of [confirmed, notConfirmed]) {
      const improve = must(staged.run.improve, `a change on ${staged.runDir}`);

      expect(await validate(staged.runDir), staged.runDir).toEqual([]);
      expect(improve.pullRequest.repository).toBe('clipforge/web');
      expect(improve.preview.url).toContain('preview.example');
      expect(improve.holdout.personaIds).toHaveLength(HOLDOUT_SIZE);
      expect(staged.run.scores.map((score) => score.variant).sort()).toEqual([
        improve.baselineVariant,
        improve.changeVariant,
      ]);
      expect(improve.patch).toContain('+++ b/');
    }
    expect(confirmed.run.verdict.holdout).toBe('confirmed');
    expect(notConfirmed.run.verdict.holdout).toBe('not_confirmed');
    expect(must(withoutPreview.run.improve, 'a change').preview.url).toBeNull();
    expect(await validate(withoutPreview.runDir)).toEqual([]);
  });

  it('carry no token in any file they are made of', async () => {
    for (const staged of [confirmed, notConfirmed, withoutPreview]) {
      const files = await readdir(join(staged.runDir, 'sessions'));
      const read = [runPaths(staged.runDir).run, runPaths(staged.runDir).findings];
      for (const name of files) read.push(join(staged.runDir, 'sessions', name));
      for (const path of read) {
        expect(await readFile(path, 'utf8'), path).not.toContain(TOKEN);
      }
    }
  });
});

describe.skipIf(!CHROMIUM_INSTALLED)(
  'the Improve screen over the built application (needs Chromium)',
  () => {
    let served: ServedApp | undefined;
    let driven: Driven | undefined;
    let page!: Page;

    const improveUrl = (base: string): string => new URL(`runs/${RUN_ID}/improve`, base).toString();

    /** Load the screen with the connection the platform would answer. */
    const land = async (base: string, answer: Connection): Promise<void> => {
      must(driven, 'a browser').connection(answer);
      await page.goto(improveUrl(base), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-screen="improve"] .pagehead h1');
    };

    beforeAll(async () => {
      served = await openTheApp(confirmed.root);
      driven = await driveOver(served.base, desktop);
      page = driven.page;
    }, WALK_TIMEOUT);

    // The timeout is the hook's own: closing Chromium and stopping a server take longer
    // than vitest's ten seconds when the whole suite is running in parallel beside this one.
    afterAll(async () => {
      await driven?.close();
      await served?.stop();
    }, FACE_TIMEOUT);

    it(
      'the locked face: the reason, the permissions, the no-merge sentence and the one control',
      async () => {
        const base = must(served, 'a server').base;
        await land(base, DISCONNECTED);
        await page.waitForSelector('[data-section="lock"]');

        expect(await words(page, '.pagehead h1')).toBe('Have the first change written for you');
        expect(await words(page, '.breadcrumb')).toBe('Results / Improve my site');
        // The promise the product is never allowed to soften, and it is bold.
        expect(await words(page, '.lede')).toContain('PersonaVision never merges it. You do.');
        expect(await words(page, '.lede b')).toBe('PersonaVision never merges it.');

        const lock = await words(page, '[data-section="lock"]');
        expect(lock).toContain('Not connected yet.');
        expect(lock).toContain('Install the PersonaVision GitHub App on the one repository');
        expect(lock).toContain(
          'It needs read access to the code and write access to pull requests — nothing else, and no merge permission.',
        );
        // The site the one repository would have to deploy: the baseline's own host.
        expect(lock).toContain(new URL(must(confirmed.run.variants[0], 'a version').url).host);

        const connect = page.locator('[data-section="lock"] a:text-is("Connect GitHub")');
        expect(await connect.count()).toBe(1);
        expect(await connect.getAttribute('href')).toBe('/settings/github');
        // Locked is a state and not an error: the illustration of what connecting gives is
        // drawn, and the user's own result is not.
        expect(await count(page, '[data-section="illustration"]')).toBe(1);
        expect(await words(page, '[data-section="illustration"] .microlabel')).toBe(
          'What it looks like once connected',
        );
        await inPageOrder(page, [
          '.breadcrumb',
          '.pagehead',
          '[data-section="lock"]',
          '[data-section="illustration"]',
          '[data-section="before-after"]',
        ]);
      },
      FACE_TIMEOUT,
    );

    it(
      'the locked face while the GitHub App is not registered says so, and still locks',
      async () => {
        await land(must(served, 'a server').base, UNREGISTERED);
        await page.waitForSelector('[data-section="lock"]');

        const lock = await words(page, '[data-section="lock"]');
        expect(lock).toContain('PersonaVision’s GitHub App is not registered yet');
        expect(lock).toContain('Test my site needs nothing from GitHub');
        expect(await count(page, '[data-section="pull-request"]')).toBe(1);
        // The one box on the page is the illustration's, not this workspace's result.
        expect(
          await count(page, '[data-section="illustration"] [data-section="pull-request"]'),
        ).toBe(1);
      },
      FACE_TIMEOUT,
    );

    it(
      'loading: the heading, the lede and the lock are already there, and nothing moves',
      async () => {
        const base = must(served, 'a server').base;
        must(driven, 'a browser').connection(DISCONNECTED, 1_500);
        await page.goto(improveUrl(base), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-section="lock"]');

        const before = await boxOf(page, '.pagehead h1');
        const ledeBefore = await boxOf(page, '.lede');
        // The answer has not arrived yet, and the page is already the locked page.
        expect(await words(page, '.pagehead h1')).toBe('Have the first change written for you');

        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-section="lock"]')
              ?.textContent?.includes('Install the PersonaVision GitHub App') === true,
          undefined,
          { timeout: 30_000 },
        );

        expect(await boxOf(page, '.pagehead h1')).toEqual(before);
        expect(await boxOf(page, '.lede')).toEqual(ledeBefore);
        must(driven, 'a browser').connection(DISCONNECTED);
      },
      FACE_TIMEOUT,
    );

    it(
      'the connected face: the pull request, the diff, the preview and who it was tested with',
      async () => {
        await land(must(served, 'a server').base, CONNECTED);
        await page.waitForSelector('[data-section="pull-request"]');
        const improve = must(confirmed.run.improve, 'a change');

        // The connected face is this workspace's own result and carries no illustration
        // label: a user reading their own pull request under *what it looks like once
        // connected* would read it as a mock-up of somebody else's (decision 82).
        expect(await count(page, '[data-section="illustration"]')).toBe(0);
        expect(await count(page, '[data-section="lock"]')).toBe(0);
        expect(await count(page, '[data-section="pull-request"]')).toBe(1);

        expect(await words(page, '[data-section="pull-request"] h2')).toBe(
          improve.pullRequest.title,
        );
        expect(await page.locator('[data-section="pull-request"] h2 a').getAttribute('href')).toBe(
          improve.pullRequest.url,
        );
        expect(await words(page, '[data-section="pull-request"] .tag')).toBe(
          `${improve.pullRequest.repository} #${String(improve.pullRequest.number)} · open`,
        );
        expect(await words(page, '[data-section="from-recommendation"]')).toContain(
          `From recommendation ${improve.recommendationId} — ${must(improve.recommendationSentence, 'the recommendation’s sentence')}`,
        );
        expect(await words(page, '[data-section="from-recommendation"]')).toContain(
          improve.changedFile,
        );

        // The diff, line for line, as the run recorded the patch.
        const diff = await words(page, '[data-section="diff"]');
        for (const line of must(improve.patch, 'the patch').split('\n')) {
          if (line.trim() !== '') expect(diff).toContain(line.trim());
        }
        expect(await words(page, '[data-section="preview"]')).toContain(
          must(improve.preview.url, 'the preview URL'),
        );
        expect(await words(page, '[data-section="preview"]')).toContain(
          'own preview deployment for this pull request',
        );

        const tested = await words(page, '[data-section="tested-with"]');
        expect(tested).toContain(`The same audience, ${confirmed.run.audience.name}`);
        expect(tested).toContain(`the same ${String(confirmed.run.audience.size)} people`);
        expect(tested).toContain(`the same ${String(confirmed.run.seedGroups.length)} seeds`);
        expect(tested).toContain(`plus a holdout of ${String(HOLDOUT_SIZE)} people`);
      },
      FACE_TIMEOUT,
    );

    it(
      'the three figures, each with its people count, and the holdout that confirmed the gain',
      async () => {
        await land(must(served, 'a server').base, CONNECTED);
        await page.waitForSelector('[data-section="before-after"]');
        const run = confirmed.run;
        const score = (variant: string) =>
          must(
            run.scores.find((one) => one.variant === variant && one.taskId === run.task.id),
            `a score for ${variant}`,
          );
        const baseline = score(must(run.improve, 'a change').baselineVariant);
        const change = score(must(run.improve, 'a change').changeVariant);
        const holdout = must(change.holdout, 'the holdout’s figures');

        expect(await words(page, '[data-section="before-after"] h2')).toBe('Before and after');
        const figures = page.locator('[data-section="before-after"] .figure');
        expect(await figures.count()).toBe(3);

        const expected = [
          ['Baseline', baseline],
          ['With the change', change],
          ['Holdout', holdout],
        ] as const;
        for (const [position, [label, stored]] of expected.entries()) {
          const figure = (await figures.nth(position).textContent())?.replace(/\s+/gu, ' ').trim();
          expect(figure, label).toContain(label);
          expect(figure, label).toContain(`${String(percent(stored.completionRate))}%`);
          expect(figure, label).toContain(
            `${String(stored.outcomeCounts.success)} of ${String(stored.scoredSessionCount)} people`,
          );
        }
        // What makes the third figure a holdout, said on the figure.
        expect(await figures.nth(2).textContent()).toContain(
          'seeds never used to choose the change',
        );

        // Three figures about three sets of people, drawn side by side rather than stacked:
        // the minified stylesheet is doing the layout, which is the thing jsdom cannot say.
        const boxes = await Promise.all(
          [0, 1, 2].map(async (position) =>
            must(
              await figures.nth(position).boundingBox(),
              `a drawn box for figure ${String(position)}`,
            ),
          ),
        );
        expect(boxes.every((box) => box.width > 0 && box.height > 0)).toBe(true);
        expect(boxes.map((box) => Math.round(box.y))).toEqual([
          Math.round(boxes[0].y),
          Math.round(boxes[0].y),
          Math.round(boxes[0].y),
        ]);
        expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
        expect(boxes[2].x).toBeGreaterThan(boxes[1].x);

        const notice = await words(page, '[data-section="holdout-verdict"]');
        expect(notice).toContain('Confirmed on the holdout.');
        expect(notice).toContain(run.verdict.audienceSentence);
        expect(
          await page.locator('[data-section="holdout-verdict"]').getAttribute('class'),
        ).toContain('info');
        // The notice is drawn by the built stylesheet, not by the browser's defaults.
        const painted = await page
          .locator('[data-section="holdout-verdict"]')
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        expect(painted).not.toBe('rgba(0, 0, 0, 0)');

        for (const reason of run.verdict.reasons) {
          expect(await words(page, '[data-section="reasons"]')).toContain(reason);
        }
        const footnote = await words(page, '[data-section="before-after"] .footnote');
        expect(footnote).toContain(`Simulated for ${run.audience.name}`);
        expect(footnote).toContain('Merging is yours.');
      },
      FACE_TIMEOUT,
    );

    it(
      'at 390 px it is the same screen, stacked, with nothing off the side',
      async () => {
        await land(must(served, 'a server').base, CONNECTED);
        await page.setViewportSize({ width: PHONE_WIDTH, height: 844 });
        try {
          await page.waitForSelector('[data-section="before-after"] .figure');
          await inPageOrder(page, [
            '.pagehead',
            '[data-section="pull-request"]',
            '[data-section="before-after"]',
            '[data-section="holdout-verdict"]',
          ]);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
        } finally {
          await page.setViewportSize(desktop.viewport);
        }
      },
      FACE_TIMEOUT,
    );

    it(
      'nothing on the page reaches off this machine, and no token is served',
      async () => {
        expect(must(driven, 'a browser').offMachine()).toEqual([]);
        expect(must(served, 'a server').log()).not.toContain(TOKEN);
        expect(await page.content()).not.toContain(TOKEN);
      },
      FACE_TIMEOUT,
    );
  },
);

describe.skipIf(!CHROMIUM_INSTALLED)(
  'the not-confirmed face over the built application (needs Chromium)',
  () => {
    let served: ServedApp | undefined;
    let driven: Driven | undefined;

    beforeAll(async () => {
      served = await openTheApp(notConfirmed.root);
      driven = await driveOver(served.base, desktop);
      driven.connection(CONNECTED);
      await driven.page.goto(new URL(`runs/${RUN_ID}/improve`, served.base).toString(), {
        waitUntil: 'domcontentloaded',
      });
      await driven.page.waitForSelector('[data-section="holdout-verdict"]');
    }, WALK_TIMEOUT);

    // The timeout is the hook's own: closing Chromium and stopping a server take longer
    // than vitest's ten seconds when the whole suite is running in parallel beside this one.
    afterAll(async () => {
      await driven?.close();
      await served?.stop();
    }, FACE_TIMEOUT);

    it(
      'says the gain is not confirmed, in the sentence, and dresses nothing up as a win',
      async () => {
        const page = must(driven, 'a browser').page;
        const run = notConfirmed.run;

        const notice = await words(page, '[data-section="holdout-verdict"]');
        expect(notice).toContain('Not confirmed on the holdout.');
        expect(notice).toContain(run.verdict.audienceSentence);
        expect(notice).toContain('this gain is not confirmed.');
        // The sentence replaces the headline rather than qualifying it: nothing on this
        // screen reads as confirmation (decision 96).
        expect(notice).not.toContain('Confirmed on the holdout:');
        // Not the quiet `info` notice the confirmed face draws.
        expect(
          await page.locator('[data-section="holdout-verdict"]').getAttribute('class'),
        ).not.toContain('info');

        // The three figures are still the three figures, and none of them is marked as the
        // one to ship: there is no win framing on this screen, whatever the holdout said.
        expect(await count(page, '[data-section="before-after"] .figure')).toBe(3);
        const page_text = (await page.locator('[data-screen="improve"]').textContent())
          ?.replace(/\s+/gu, ' ')
          .trim();
        for (const framing of ['the one to ship', 'Ship ', 'winner', 'lift']) {
          expect(page_text, framing).not.toContain(framing);
        }
        expect(await words(page, '[data-section="reasons"]')).toContain(
          'The holdout did not move with them, so the gain may be the swarm agreeing with itself rather than the change.',
        );
      },
      FACE_TIMEOUT,
    );
  },
);

describe.skipIf(!CHROMIUM_INSTALLED)(
  'the face of a change that was never served anywhere (needs Chromium)',
  () => {
    let served: ServedApp | undefined;
    let driven: Driven | undefined;

    beforeAll(async () => {
      served = await openTheApp(withoutPreview.root);
      driven = await driveOver(served.base, desktop);
      driven.connection(CONNECTED);
      await driven.page.goto(new URL(`runs/${RUN_ID}/improve`, served.base).toString(), {
        waitUntil: 'domcontentloaded',
      });
      await driven.page.waitForSelector('[data-section="pull-request"]');
    }, WALK_TIMEOUT);

    // The timeout is the hook's own: closing Chromium and stopping a server take longer
    // than vitest's ten seconds when the whole suite is running in parallel beside this one.
    afterAll(async () => {
      await driven?.close();
      await served?.stop();
    }, FACE_TIMEOUT);

    it(
      'shows the pull request and the reason, and draws no before and after it could not measure',
      async () => {
        const page = must(driven, 'a browser').page;
        const improve = must(withoutPreview.run.improve, 'a change');

        expect(await count(page, '[data-section="preview"]')).toBe(0);
        const stated = await words(page, '[data-section="no-preview"]');
        expect(stated).toContain('No preview, so the changed version could not be reached.');
        expect(stated).toContain(must(improve.preview.reason, 'the reason'));
        expect(stated).toContain('There is no before and after');
        // The pull request that was opened is still on the page: what was done stays done.
        expect(await words(page, '[data-section="pull-request"] h2')).toBe(
          improve.pullRequest.title,
        );
        expect(await count(page, '[data-section="before-after"]')).toBe(0);
        expect(await count(page, '[data-section="holdout-verdict"]')).toBe(0);
      },
      FACE_TIMEOUT,
    );
  },
);

/**
 * The walk is in CI, in the job the cold start already runs in.
 *
 * There is no separate cold-start job to add this to: `tests/cold-start.test.ts` runs inside
 * the `check` job's `pnpm test`, which is where this file runs too. What has to stay true for
 * that to mean anything is asserted here rather than assumed — Chromium is installed before
 * `pnpm test`, so the browser half is never silently skipped, and `pnpm test` runs after the
 * build that leaves the command line and the viewer this walk drives.
 */
describe('the job this walk runs in', () => {
  const workflow = () => readFile(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('installs Chromium before pnpm test, so CI never skips the browser half', async () => {
    const text = await workflow();
    const check = must(/^  check:$[\s\S]*?(?=^  [a-z])/m.exec(text)?.[0], 'a check job');

    const steps = [...check.matchAll(/^\s*-\s*(?:if:.*\n\s*)?run:\s*(.+?)\s*$/gm)].map(
      (match) => match[1],
    );
    const installs = steps.findIndex((step) => step.includes('playwright install --with-deps'));
    const tests = steps.indexOf('pnpm test');
    const typechecks = steps.indexOf('pnpm typecheck');

    expect(installs, 'the check job installs Chromium').toBeGreaterThanOrEqual(0);
    expect(tests, 'the check job runs pnpm test').toBeGreaterThanOrEqual(0);
    expect(installs).toBeLessThan(tests);
    // `pnpm typecheck` builds the workspace, which is what leaves the built command line and
    // the built viewer this walk drives.
    expect(typechecks).toBeGreaterThanOrEqual(0);
    expect(typechecks).toBeLessThan(tests);
  });
});
