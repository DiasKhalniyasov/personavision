/**
 * The mechanics the acceptance gate runs on: a regeneration into a throwaway directory, a
 * fingerprint of a directory's contents, a copy of the demo shop with one planted defect
 * taken out, and the prose a missed defect is reported with.
 *
 * Nothing here decides a number. The pipeline is `scripts/generate-demo-run.ts` — the
 * generation ticket's own script (#78), not a second copy of it — and every figure the gate
 * asserts comes back from that script or off the artifact it wrote. What lives here is only
 * the plumbing that would otherwise crowd out the assertions in `../pipeline.test.ts`.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPaths, runSchema, sessionSchema } from '@personavision/contract';
import { findingRuleIdOf } from '@personavision/scoring';
import { generateDemoRun, RUN_ID } from '../../../scripts/generate-demo-run.js';
import { ALMATY_PARENTS } from '../../../packages/personas/tests/drawn-fields-expectation.js';
import type { CaptureSource, Device, TaskStep } from '@personavision/browser';
import type { Audience, Findings, Run, Session } from '@personavision/contract';
import type { Finding, PlantedDefect, PlantedDefectEvaluation } from '@personavision/scoring';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** The committed artifact the gate must not touch. */
export const committedRunDir = join(repoRoot, 'runs', RUN_ID);

/** The demo shop as it is served to a real run. */
const shopRoot = join(repoRoot, 'demo', 'northwind');

/** The only directories `serveDemoShop` serves, so the only ones a copy of it needs. */
const SERVED_DIRECTORIES = ['a', 'b', 'shared'] as const;

/** A temporary directory of this suite's, named so that a leftover says whose it was. */
const scratch = (what: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `personavision-acceptance-${what}-`));

/** One regeneration: where it was written, and the artifact that was written there. */
export interface Regeneration {
  /** The temporary `runs/` the run was written into — pass it to `discard` when done. */
  readonly runsRoot: string;
  readonly runDir: string;
  /** `run.json`, read back off disk rather than taken from the generator's return. */
  readonly run: Run;
  /** `findings.json`, likewise: what the gate judges is the artifact, not an object. */
  readonly findings: Findings;
}

export interface RegenerateOptions {
  /** The shop to serve. The demo shop itself unless a copy of it is being served. */
  readonly shopRoot?: string;
  /** Where the run's own report goes. Dropped when nothing is given. */
  readonly report?: (line: string) => void;
}

/**
 * Regenerate the run into a directory of its own.
 *
 * The temporary root is handed back rather than removed here, because the gate reads the
 * artifact after the run has finished and a determinism check holds two of them at once.
 */
export const regenerate = async (options: RegenerateOptions = {}): Promise<Regeneration> => {
  const runsRoot = await scratch('run');
  const runDir = join(runsRoot, RUN_ID);
  const paths = runPaths(runDir);
  const read = async <Parsed>(file: string): Promise<Parsed> =>
    JSON.parse(await readFile(file, 'utf8')) as Parsed;

  try {
    await generateDemoRun({ runsRoot, ...options });
    return {
      runsRoot,
      runDir,
      run: await read<Run>(paths.run),
      findings: await read<Findings>(paths.findings),
    };
  } catch (error) {
    // Nothing is handed back, so no hook can be given this directory to remove: whether the
    // run failed or its artifact would not parse, what it half wrote goes now. The whole of
    // a run — twenty-four sessions and eight screenshots — is what would otherwise be left
    // in the temporary directory.
    await discard(runsRoot);
    throw error;
  }
};

/**
 * Remove a temporary directory, whatever happened to the run that wrote it — and nothing at
 * all when there is nothing to remove, which is what a hook running after a failed
 * regeneration is given.
 */
export const discard = async (directory: string | undefined): Promise<void> => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
};

/**
 * Every file under `directory`, as `<sha256> <bytes> <path>` lines, sorted.
 *
 * Contents and not timestamps: the question the gate asks of the committed run directory is
 * whether a regeneration changed anything in it, and a file rewritten with the same bytes
 * has changed nothing a screen or a test can see.
 */
export const fingerprint = (directory: string): string[] => {
  const lines: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else {
        const bytes = readFileSync(full);
        const digest = createHash('sha256').update(bytes).digest('hex');
        lines.push(`${digest} ${String(statSync(full).size)} ${relative}`);
      }
    }
  };
  walk(directory, '');
  return lines.sort();
};

/** The markup that puts variant B's completing action out of sight — planted defect 1. */
const SPACER = '<div class="pushdown" aria-hidden="true"></div>';

/**
 * A copy of the demo shop with planted defect 1 taken out: the 1400 px spacer above variant
 * B's completing action, and nothing else.
 *
 * This is how the gate is shown to bite. Defect 1 is the one the run finds, so removing it
 * is what makes recall fall — the control is above the fold, the sessions that reach the
 * review step look at it, and `never-fixated-primary-action` has nothing to report. The
 * real shop is never written to: the three served directories are copied and the edit is
 * made in the copy, which is removed again afterwards.
 */
export const shopWithoutDefect1 = async (): Promise<string> => {
  const root = await scratch('shop');
  try {
    for (const directory of SERVED_DIRECTORIES) {
      await cp(join(shopRoot, directory), join(root, directory), { recursive: true });
    }

    const review = join(root, 'b', 'review.html');
    const markup = await readFile(review, 'utf8');
    if (!markup.includes(SPACER)) {
      throw new Error(
        `b/review.html no longer carries ${SPACER}, so this is not the way defect 1 is planted any more: find how it is planted now and remove that instead`,
      );
    }
    await writeFile(review, markup.replace(SPACER, ''), 'utf8');
    return root;
  } catch (error) {
    // The copy is only ever handed back finished, so the caller has nothing to clean up
    // when the guard above fires — which it will the day defect 1 is planted another way.
    await discard(root);
    throw error;
  }
};

/** A finding, as a reader of a failure message needs to see it. */
const describeFinding = (finding: Finding): string =>
  `${finding.id} (rank ${String(finding.rank)}, ${finding.severity}, ${finding.variant ?? 'run'}/${finding.step}/${finding.aoiId ?? '—'})`;

/**
 * The finding nearest to a defect nothing was credited to: one carrying the same rule
 * somewhere else, failing that one in the same place under another rule, failing that
 * nothing.
 *
 * A number alone sends the next session back to re-derive which defect was missed and how
 * near the run came to it, which is the one thing a failed gate should not make anybody do.
 */
const closestTo = (defect: PlantedDefect, findings: readonly Finding[]): string => {
  const sameRule = findings.find((finding) => findingRuleIdOf(finding) === defect.ruleId);
  if (sameRule !== undefined) {
    return `${describeFinding(sameRule)} carries the same rule somewhere else`;
  }
  const samePlace = findings.find(
    (finding) => finding.variant === defect.variant && finding.step === defect.step,
  );
  if (samePlace !== undefined) {
    return `${describeFinding(samePlace)} is the nearest finding in the same place`;
  }
  return 'no finding carries its rule or names its step';
};

/**
 * What the run did with each declared defect, in declared order: the finding credited to
 * it, or the miss with the closest finding named.
 *
 * Passed as the message of every headline assertion, so a red gate reads as a report.
 */
export const defectReport = (
  defects: readonly PlantedDefect[],
  findings: readonly Finding[],
  evaluation: PlantedDefectEvaluation,
): string => {
  const lines = defects.map((defect, index) => {
    const findingId = evaluation.matched[index]?.findingId ?? null;
    const where = `${defect.ruleId} @ ${defect.variant}/${defect.step}/${defect.aoiId ?? '—'}`;
    if (findingId !== null) return `  ${defect.id} (${where}) → ${findingId}`;
    return `  ${defect.id} (${where}) → NOT FOUND; ${closestTo(defect, findings)}`;
  });

  return [
    `precision ${evaluation.precision.toFixed(3)}, recall ${evaluation.recall.toFixed(3)} over ${String(findings.length)} findings`,
    ...lines,
    '  findings, ranked:',
    ...findings.map((finding) => `    ${describeFinding(finding)}`),
  ].join('\n');
};

/*
 * ─── The one-URL walk (#286) ──────────────────────────────────────────────────────────
 *
 * What a hundred agents on one URL need that the A/B gate above does not: a capture set
 * holding the one variant a path-1 test runs, the fixture site's declared steps, the
 * hundred-participant audience, a pool the test can watch, and a reader of a run that is
 * still open. Nothing here asserts anything either.
 */

/**
 * The capture set `pnpm -F @personavision/browser record:captures` wrote: the fixture
 * site's four checkout screens, recorded under two devices.
 */
const COMMITTED_CAPTURES = fileURLToPath(
  new URL('../../../packages/browser/test/fixtures/captures', import.meta.url),
);

/**
 * The variant of that set the one-URL walk replays.
 *
 * `A`, because it is the one recorded on a phone, and the audience below puts its hundred
 * people on phones: a replay refuses a device the variant was not recorded under, since
 * every `belowFold` in a capture came from that viewport's fold.
 */
const RECORDED_VARIANT = 'A';

/** The site the committed captures were recorded against — the URL a one-URL test is given. */
export const FIXTURE_SITE = 'https://fixture.test/cart.html';

/** The committed set's index, as the replay reads it. */
interface CaptureIndex {
  readonly formatVersion: number;
  readonly variants: readonly {
    readonly id: string;
    readonly device: Device;
    readonly steps: readonly { readonly step: string; readonly path: string }[];
  }[];
}

/** One variant's capture set: where it was written, and the device it answers for. */
export interface OneUrlCaptures {
  /** The temporary capture set — pass it to `discard` when done. */
  readonly dir: string;
  /** The device the variant was recorded under, which is the device the audience must use. */
  readonly device: Device;
  /** The steps it records, in the order it records them. */
  readonly steps: readonly string[];
}

/**
 * A capture set holding **one** variant, under the id a one-URL test gives it.
 *
 * A path-1 run has one variant named for the site (`ONE_URL_VARIANT_ID`), and the committed
 * set records `A` and `B`: a replay looks the session's variant up by id and finds neither.
 * So the recorded phone variant is minted under the one-URL id — the same pages at the same
 * viewport under another name — and a session therefore replays bytes that were really
 * recorded rather than geometry somebody invented.
 */
export const oneUrlCaptureSet = async (variantId: string): Promise<OneUrlCaptures> => {
  const dir = await scratch('one-url-captures');
  try {
    const index = JSON.parse(
      await readFile(join(COMMITTED_CAPTURES, 'capture-set.json'), 'utf8'),
    ) as CaptureIndex;
    const recorded = index.variants.find((variant) => variant.id === RECORDED_VARIANT);
    if (recorded === undefined) {
      throw new Error(`${COMMITTED_CAPTURES} records no variant "${RECORDED_VARIANT}"`);
    }

    await writeFile(
      join(dir, 'capture-set.json'),
      JSON.stringify({ ...index, variants: [{ ...recorded, id: variantId }] }, null, 2),
    );
    for (const { step } of recorded.steps) {
      const capture = JSON.parse(
        await readFile(
          join(COMMITTED_CAPTURES, 'captures', RECORDED_VARIANT, `${step}.json`),
          'utf8',
        ),
      ) as Record<string, unknown>;
      const screenshot = runPaths('').screenshot(variantId, step);
      await mkdir(join(dir, 'captures', variantId), { recursive: true });
      await mkdir(dirname(join(dir, screenshot)), { recursive: true });
      await writeFile(
        join(dir, 'captures', variantId, `${step}.json`),
        JSON.stringify({ ...capture, variant: variantId, screenshot }, null, 2),
      );
      await copyFile(
        join(COMMITTED_CAPTURES, runPaths('').screenshot(RECORDED_VARIANT, step)),
        join(dir, screenshot),
      );
    }
    return { dir, device: recorded.device, steps: recorded.steps.map(({ step }) => step) };
  } catch (error) {
    // Handed back only finished, so a caller has nothing to remove when the guard above
    // fires — which it will the day the committed set stops recording a phone variant.
    await discard(dir);
    throw error;
  }
};

/** The errand the fixture site's four screens are a checkout of — a one-URL test's goal. */
export const FIXTURE_SITE_ERRAND = 'Buy the canvas tote bag: check out, pay and place the order.';

/**
 * The fixture site's checkout, step by step, as `packages/browser`'s own suites declare it.
 *
 * A declared task rather than the page as one step (`packages/cli/src/run/task.ts`): the
 * capture set records four screens, and a run whose task declares one would list a step its
 * sessions never walked. The selectors are the fixture pages' own; the replay matches a
 * step by the capture it is replaying rather than by probing a page, so they are what a live
 * run of the same site would be driven by and not what this walk depends on.
 *
 * Each step carries the goal the person has on that screen, which is not decoration (#78):
 * handed only the errand, a session ranks the cart's own copy above the control beside it
 * and never leaves the first screen.
 */
export const FIXTURE_SITE_STEPS: readonly TaskStep[] = [
  {
    id: 'cart',
    label: 'Cart',
    match: { urlPattern: '/cart\\.html', requiredSelector: '#cart-items' },
    primaryAction: { selector: '#cart-checkout' },
    goal: 'Go to checkout.',
  },
  {
    id: 'payment',
    label: 'Payment',
    match: { urlPattern: '/payment\\.html', requiredSelector: '#payment-form' },
    primaryAction: { selector: '#payment-submit' },
    goal: 'Pay, and review the order.',
  },
  {
    id: 'review',
    label: 'Review',
    match: { urlPattern: '/review\\.html', requiredSelector: '#review-summary' },
    primaryAction: { selector: '#review-place-order' },
    goal: 'Place the order.',
  },
  {
    id: 'confirmation',
    label: 'Confirmation',
    match: { urlPattern: '/confirmation\\.html', requiredSelector: '#confirmation-receipt' },
    primaryAction: { selector: '#confirmation-continue-shopping' },
    goal: 'Continue shopping.',
  },
];

/**
 * The hundred-participant audience the walk stores: `docs/FLOW.md` section 12's own worked
 * example — a hundred busy parents in Almaty, a 46/54 gender split, two age groups, a
 * region and two languages — read from where #278 committed it rather than copied.
 *
 * **Its device mix is replaced by the one device the captures answer for.** The example
 * declares 72% on phones and 28% on desktop, and a replayed session is refused a device its
 * variant was not recorded under: a hundred sessions over a two-device mix cannot be walked
 * over a set recorded under one. The share is therefore the whole audience, the device is
 * read off the set rather than written out here, and every other field of the example — the
 * fields this walk is about — is the example's.
 */
export const aHundredParticipants = (device: Device): Audience => ({
  ...structuredClone(ALMATY_PARENTS),
  devices: [{ ...device, share: 1 }],
});

/** A capture source with the pool's own counter on it. */
export interface WatchedSource {
  readonly source: CaptureSource;
  /** The most sessions open at one instant, over the whole run. */
  readonly peak: () => number;
}

/**
 * The source, counting how many sessions are open at once.
 *
 * Counted at the source rather than off the swarm's progress events, because the per-site
 * cap is a claim about **browsers**: it is the thing that opens pages that must not open
 * more than ten of them, and in a replay the source is that thing. The count is raised
 * before the open and lowered after the close, so a session that is still opening is in
 * flight — which is what a cap on open browsers has to mean.
 */
export const watchingFlight = (inner: CaptureSource): WatchedSource => {
  let inFlight = 0;
  let peak = 0;
  return {
    source: {
      ...inner,
      openSession: async (variant, device) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          return await inner.openSession(variant, device);
        } catch (error) {
          inFlight -= 1;
          throw error;
        }
      },
      // Lowered whatever the close did, because a counter that leaks reports the one thing
      // this helper exists to deny — more than the cap open against one site — and would
      // report it about a failure somewhere else entirely.
      close: async (page) => {
        try {
          await inner.close(page);
        } finally {
          inFlight -= 1;
        }
      },
    },
    peak: () => peak,
  };
};

/** What a reader with nothing but the run directory sees while the run is still going. */
export interface OpenRunObservation {
  readonly status: Run['status'];
  readonly finishedSessions: number;
  readonly totalSessions: number;
  readonly listedSessions: number;
  /** A session `run.json` already lists, read off disk and parsed against the contract. */
  readonly session: Session;
}

/**
 * `run.json` and one of the sessions it lists, read **synchronously**, or `null` when the
 * run is not open or has landed nothing yet.
 *
 * Synchronous, and that is the point. `writeFile` is not atomic, and every write of
 * `run.json` and of a session file happens inside the one turn the swarm serialises them
 * in; this is called from inside that turn, from the progress line a landed session reports,
 * so a read that does not await cannot catch a half-written file. An asynchronous read taken
 * from anywhere else would be testing Node rather than the artifact.
 *
 * It parses rather than peeks: what the Running screen is promised is that `run.json` is a
 * valid run at every point and that a session file is complete the moment it is listed, so
 * a file that would not parse throws here instead of being skipped.
 */
export const readOpenRun = (
  runsRoot: string,
  besides: readonly string[],
): OpenRunObservation | null => {
  const [runId] = readdirSync(runsRoot).filter((entry) => !besides.includes(entry));
  if (runId === undefined) return null;

  const paths = runPaths(join(runsRoot, runId));
  const run = runSchema.parse(JSON.parse(readFileSync(paths.run, 'utf8')));
  if (run.status !== 'open') return null;
  // The **newest** listed session, which is the one the line being reported is about and
  // the only one this observation says anything new about: `sessionIds` grows in landing
  // order, so taking the first would re-read session one a hundred times and prove nothing
  // about the ninety-nine after it.
  const sessionId = run.sessionIds.at(-1);
  if (sessionId === undefined) return null;

  return {
    status: run.status,
    finishedSessions: run.progress?.finishedSessions ?? 0,
    totalSessions: run.progress?.totalSessions ?? 0,
    listedSessions: run.sessionIds.length,
    session: sessionSchema.parse(JSON.parse(readFileSync(paths.session(sessionId), 'utf8'))),
  };
};

/**
 * The committed example run, copied into a runs root of the walk's own, and its id.
 *
 * A fresh clone's runs root holds exactly this one directory, and that is what the platform
 * seeds a workspace from: it owns the run, and an estimate is quoted from the sessions the
 * runs it owns measured. The copy is what keeps the promise that the committed artifact is
 * untouched — the walk's own run is written beside a copy, never beside the original.
 */
export const exampleRunIn = async (runsRoot: string): Promise<string> => {
  await cp(committedRunDir, join(runsRoot, RUN_ID), { recursive: true });
  return RUN_ID;
};
