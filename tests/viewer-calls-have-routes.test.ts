import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPaths } from '@personavision/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform } from '../packages/platform/src/index.js';
import type { Route } from '../packages/platform/src/server/routes/types.js';

/**
 * **A call the app makes with no route behind it fails CI** (#399).
 *
 * The owner's walk of sign-in → results broke three times on `main`, and twice it broke the
 * same way: the app posted to a path — `/audiences/from-sentence`, `/runs/goal` — the
 * platform mounted nothing at, the request fell through to the app's own HTML, and the
 * screen printed *"the platform answered something that is not …"*. This is the cheap guard
 * against a fourth: every path the app fetches is matched against the routes
 * `createPlatform` mounts and the read-only run-data mount's documented paths, and an
 * unmatched one names the file, the path and the methods that file sends.
 *
 * It is cheap because `apps/viewer/tests/skeleton.test.ts` already pins **which** files may
 * `fetch` — eight of them, one per interface — so this reads the path literals out of
 * whatever those files are rather than keeping a list of its own. A ninth module that
 * fetched would be that test's failure and would be swept by this one the same day.
 *
 * **A fixed path needs a fixed route.** `/audiences/from-sentence` is matched by
 * `/^\/audiences\/([^/]+)$/` — which is why #396 broke in the first place: the app posted a
 * path the platform answered with the route for *one audience by id*, and the request fell
 * through to the app. So a path the app spells out in full is answered only by a route whose
 * pattern **names** it rather than capturing a segment, which is the rule the platform
 * already keeps by mounting `/audiences/from-sentence` and `/runs/goal` ahead of the
 * patterns that would swallow them. A path carrying a placeholder segment may match either.
 *
 * **Ceiling, stated plainly.** It reads literals, resolving `${…}` to one placeholder
 * segment and `${NAME}` to the constant `NAME` where the file declares one, so a path
 * assembled out of a variable computed elsewhere is invisible to it — `useRun`'s
 * `runFile(runId, layout.run)` is one, and the run-directory family it sits under is what is
 * matched for it. And it matches on the **path**: a route removed for one method while
 * another remains at the same path is not caught here. The eight-module pin is what makes
 * those bounds acceptable, and `apps/viewer/tests/walk/signin-to-results.test.ts` walks the
 * live path end to end.
 */

const appDir = fileURLToPath(new URL('../apps/viewer', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Installed and built output is not the app's own source. */
const SKIPPED = new Set(['node_modules', 'dist']);

const filesUnder = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory);
  const found = await Promise.all(
    entries
      .filter((entry) => !SKIPPED.has(entry))
      .map(async (entry) => {
        const path = join(directory, entry);
        return (await stat(path)).isDirectory() ? await filesUnder(path) : [path];
      }),
  );
  return found.flat();
};

/**
 * A file's source with its comments taken out.
 *
 * A path named in a comment is prose, not a call — and these modules name plenty: the screen
 * routes they navigate to, the paths of the routes they do *not* speak. The sweep in
 * `skeleton.test.ts` strips block comments for the same reason.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** One segment stands in for every `${…}` the walk cannot resolve: an id, an encoded name. */
const PLACEHOLDER = ':segment';

/** Every string and template literal in a file, whichever quotes it was written with. */
const LITERALS = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/g;

/** `const NAME = '…'` and `const NAME = \`…\`` — the path constants these modules declare. */
const CONSTANTS =
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:'([^'\n]*)'|`([^`]*)`)/g;

/** `method: 'POST'` — the verbs a file states. A `fetch` that states none sends `GET`. */
const METHODS = /method:\s*'([A-Z]+)'/g;

/** One path the app fetches, and where from. */
interface ViewerCall {
  /** Repository-relative, so a failure names the file a developer opens. */
  readonly file: string;
  readonly path: string;
  /** The verbs this file sends. See the ceiling in this file's header. */
  readonly methods: readonly string[];
}

/**
 * The paths one file fetches, as its literals resolve.
 *
 * A literal is resolved against the file's own path constants, once over, so
 * `` `${AUDIENCES}/${encodeURIComponent(id)}` `` becomes `/audiences/:segment`. Only a
 * resolved literal that begins with `/` is a path of this site; everything else a module
 * holds — a sentence, a field name, a header — is not.
 */
const callsIn = (file: string, source: string): ViewerCall[] => {
  const clean = withoutComments(source);
  const constants = new Map<string, string>();
  for (const match of clean.matchAll(CONSTANTS)) {
    constants.set(match[1] ?? '', match[2] ?? match[3] ?? '');
  }

  const resolve = (raw: string, depth = 0): string =>
    depth > 4
      ? raw
      : raw.replace(/\$\{([^}]*)\}/g, (_, expression: string) => {
          const named = constants.get(expression.trim());
          return named === undefined ? PLACEHOLDER : resolve(named, depth + 1);
        });

  const methods = new Set(['GET']);
  for (const match of clean.matchAll(METHODS)) methods.add(match[1] ?? '');

  const paths = new Set<string>();
  for (const match of clean.matchAll(LITERALS)) {
    const resolved = resolve(match[1] ?? match[2] ?? match[3] ?? '');
    if (resolved.startsWith('/')) paths.add(resolved);
  }

  return [...paths].sort().map((path) => ({ file, path, methods: [...methods].sort() }));
};

/**
 * Every path the app fetches, read out of the files that are allowed to.
 *
 * "Allowed to" is `skeleton.test.ts`'s own rule and its own sweep: a file of the app's
 * source — tests aside — that calls `fetch`.
 */
const callsOfTheApp = async (): Promise<ViewerCall[]> => {
  const files = (await filesUnder(appDir)).filter(
    (path) => relative(appDir, path).split(sep)[0] !== 'tests',
  );
  const calls = await Promise.all(
    files.map(async (path) => {
      const source = await readFile(path, 'utf8');
      if (!/\bfetch\s*\(/.test(withoutComments(source))) return [];
      return callsIn(relative(repoRoot, path), source);
    }),
  );
  return calls.flat();
};

/**
 * The read-only run-data mount's own documented paths
 * (`docs/adr/0001-run-data-over-http-as-static-files.md`, `packages/cli/src/run-data.ts`):
 * the one generated listing, the run directory the app resolves a stored path against, and
 * every file of the layout inside it.
 *
 * **The layout is the contract's**, read from `runPaths` with a placeholder for each id the
 * app encodes — so the names are declared once and this file spells none of them. Listing
 * them rather than accepting everything under `/runs/<id>/` is what keeps the guard sharp: a
 * call the app one day makes to `/runs/<id>/stop` with no route mounted is the #396 shape
 * again, and a pattern standing for "anything under a run" would call it answered.
 */
const RUN_DATA_PATHS: ReadonlySet<string> = (() => {
  const layout = runPaths(`/runs/${PLACEHOLDER}`);
  return new Set([
    '/runs/index.json',
    // `useRun`'s `runDataBase`: the directory itself, which is what a path stored inside the
    // artifact resolves against rather than a file the mount answers on its own.
    `/runs/${PLACEHOLDER}/`,
    layout.run,
    layout.findings,
    layout.aggregate,
    layout.recommendations,
    layout.session(PLACEHOLDER),
    layout.screenshot(PLACEHOLDER, PLACEHOLDER),
    layout.video(PLACEHOLDER),
  ]);
})();

/**
 * Whether a pattern **names** one path rather than answering a family of them: no capture
 * group and no character class, which is how every route of this platform that stands for a
 * fixed path is written and how none of the ones standing for an id is.
 */
const namesOnePath = (pattern: RegExp): boolean => !/\((?!\?)|\[/.test(pattern.source);

/**
 * Whether this pattern answers this path — and, for a path the app spells out in full, only
 * if the pattern names it. See the rule in this file's header.
 */
const answers = (pattern: RegExp, path: string): boolean =>
  pattern.test(path) && (path.includes(PLACEHOLDER) || namesOnePath(pattern));

/** One sentence per path nothing answers, in the words a failed build should read. */
const unanswered = (calls: readonly ViewerCall[], routes: readonly Route[]): string[] =>
  calls
    .filter(
      (call) =>
        !routes.some((route) => answers(route.path, call.path)) && !RUN_DATA_PATHS.has(call.path),
    )
    .map(
      (call) =>
        `${call.file} fetches "${call.path}" (the methods this file sends: ${call.methods.join(', ')}), and the platform mounts no route for that path, nor does the read-only run-data mount serve it. Mount it — or, if that literal is not a path this app asks a server for, keep it out of a module that fetches.`,
    );

describe('every path the app fetches is a path the platform answers', () => {
  let dir: string;
  let routes: Route[];
  let calls: ViewerCall[];

  beforeAll(async () => {
    // A data directory and a runs root of this suite's own: `createPlatform` seeds on a
    // first start, and nothing here may write into `runs/` in the repository.
    dir = await mkdtemp(join(tmpdir(), 'personavision-route-guard-'));
    const platform = await createPlatform({
      dataDir: join(dir, '.personavision'),
      runsRoot: join(dir, 'runs'),
    });
    routes = platform.routes;
    calls = await callsOfTheApp();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the paths out of the modules allowed to fetch, and finds them', () => {
    // Guards every check below from passing on an empty sweep, and pins the two families the
    // app speaks: the platform's routes, and the run data.
    expect(calls.length).toBeGreaterThan(10);
    expect(new Set(calls.map((call) => call.file)).size).toBeGreaterThan(5);
    expect(calls.map((call) => call.path)).toContain('/auth/session');
    expect(calls.map((call) => call.path)).toContain('/runs/index.json');
  });

  it('answers every one of them, either with a route or with the run-data mount', () => {
    expect(unanswered(calls, routes)).toStrictEqual([]);
  });

  it('takes the run-data paths from the contract, and nothing beside them', () => {
    // The mount's paths are the layout's, so the set is checked against the layout rather
    // than against a copy of it — and a path under a run directory that the layout does not
    // name is **not** in it, which is what keeps the guard sharp.
    const layout = runPaths(`/runs/${PLACEHOLDER}`);
    expect(RUN_DATA_PATHS.has(layout.run)).toBe(true);
    expect(RUN_DATA_PATHS.has(layout.session(PLACEHOLDER))).toBe(true);
    expect(RUN_DATA_PATHS.has(layout.video(PLACEHOLDER))).toBe(true);
    expect(RUN_DATA_PATHS.has(`/runs/${PLACEHOLDER}/stop`)).toBe(false);
  });

  it('names the file and the path when a route is taken off the platform', () => {
    // `/runs/goal` is the breakage of #397, and the one path no other route of the family
    // answers: `/runs` is anchored, `/runs/estimate` is its own, and the run-data family
    // needs a trailing slash, so a run directory can never claim it.
    const without = routes.filter((route) => !route.path.test('/runs/goal'));
    expect(without.length).toBe(routes.length - 1);

    const reported = unanswered(calls, without);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(
      join('apps', 'viewer', 'src', 'screens', 'newtest', 'wizard', 'goal', 'goal.ts'),
    );
    expect(reported[0]).toContain('"/runs/goal"');
    expect(reported[0]).toContain('POST');
    expect(reported[0]).toContain('the platform mounts no route for that path');
  });

  it('names the file and the path when a fixed path is left to the route for an id', () => {
    // The breakage of #396, which is why the rule above exists: with the from-sentence
    // route gone, `/^\/audiences\/([^/]+)$/` still matches the path the app posts, the
    // request falls through to the app, and the step prints that the store answered
    // something that is not JSON. A path-only match would call that answered.
    const without = routes.filter(
      (route) => route.path.source !== '^\\/audiences\\/from-sentence$',
    );
    expect(without.length).toBe(routes.length - 1);
    expect(without.some((route) => route.path.test('/audiences/from-sentence'))).toBe(true);

    const reported = unanswered(calls, without);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(join('apps', 'viewer', 'src', 'screens', 'audience', 'store.ts'));
    expect(reported[0]).toContain('"/audiences/from-sentence"');
  });

  it('names every file that calls a path the platform stops answering', () => {
    // The same, for a path two routes answer and three screens read: taking `/sites` off
    // leaves the one module that speaks it named, and `/sites/:segment` still answered.
    const without = routes.filter((route) => !route.path.test('/sites'));
    const reported = unanswered(calls, without);

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(join('apps', 'viewer', 'src', 'sites', 'store.ts'));
    expect(reported[0]).toContain('"/sites"');
  });
});
