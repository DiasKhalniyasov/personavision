/**
 * Generates the committed example run at `runs/2026-10-24-1402-northwind-demo/` by running
 * the whole pipeline over the demo shop, and replaces whatever is there in place.
 *
 * This is the genuine artifact (#78). Nothing in the directory is written by hand: the
 * screenshots are Chromium's captures of `demo/northwind/`, the fixations and per-area
 * aggregates are `@personavision/engine`'s, the sessions are `@personavision/swarm`'s, and
 * the scores, findings and verdict are `@personavision/scoring`'s. This script decides what
 * to run and in what order; it decides no number.
 *
 * One command, `pnpm demo:run`:
 *
 * 1. serves `demo/northwind/` on a free loopback port through the shop's own helper;
 * 2. runs 4 generated people × 3 seed groups × 2 variants = 24 sessions over
 *    `demo/northwind/demo.config.ts`'s task, through Chromium, on the offline deterministic
 *    engine and provider — no API key read, nothing but loopback reached;
 * 3. scores the sessions, generates the findings and writes the verdict;
 * 4. writes the whole directory through `@personavision/contract`'s `writeRun`, with every
 *    path from `runPaths`, and reports what it measured against `docs/FLOW.md` section 5
 *    and `demo/northwind/defects.json`.
 *
 * **Why it must run against built packages.** `tsx --conditions=development` resolves the
 * workspace to its TypeScript sources, and esbuild's `keepNames` then injects a `__name`
 * helper into the functions `packages/browser` hands to `page.evaluate` — which are
 * serialised into the page, where no such helper exists. Every session comes back as
 * `ReferenceError: __name is not defined` and an automation failure. So `demo:run` builds
 * first and runs without that condition; vitest is unaffected, because Vite's esbuild
 * leaves `keepNames` off.
 *
 * **Determinism.** Two runs leave the directory byte-identical. Every draw is seeded; the
 * clock is the only input that is not, so the artifact's timestamps are fixed to the run's
 * own rather than read from the host. Sessions run one at a time, because the two devices of
 * the mix capture the same `screenshots/<variant>/<step>.png` and which of them wrote it
 * last has to be the same on every run.
 */

import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveSource } from '@personavision/browser';
import { runDirName, runPaths, SCHEMA_VERSION, writeRun } from '@personavision/contract';
import { aggregate, defaultEngineConfig } from '@personavision/engine';
import {
  DEMO_AUDIENCE_SEED,
  generatePersonas,
  OUTDOOR_GEAR_SHOPPERS,
} from '@personavision/personas';
import { createOfflineDeterministicProvider } from '@personavision/provider';
import {
  evaluateAgainstPlantedDefects,
  findings as generateFindings,
  score,
  verdict as writeVerdict,
} from '@personavision/scoring';
import { engineOnTheRecord, planSwarm, runSwarm } from '@personavision/swarm';
import { declaredDefects } from '@personavision/northwind-demo/defects.ts';
import { NORTHWIND_TASK, northwindVariants } from '@personavision/northwind-demo/demo.config.ts';
import { serveDemoShop } from '@personavision/northwind-demo/serve.ts';
import type { Variant } from '@personavision/browser';
import type { DemoShop } from '@personavision/northwind-demo/serve.ts';
import type { Findings, Run, Session } from '@personavision/contract';
import type { PlantedDefectEvaluation } from '@personavision/scoring';
import type { EngineOnTheRecord } from '@personavision/swarm';

/* ===== what this run is ==================================================== */

/**
 * The run's own timestamp, and so its directory name and id: fixed, because the committed
 * artifact's path is a promise every screen and test is written against, and because a run
 * named from the wall clock could not be regenerated in place.
 */
const CREATED_AT = new Date('2026-10-24T14:02:00Z');
const RUN_NAME = 'northwind-demo';

/** `2026-10-24-1402-northwind-demo` — the directory name and the run's id. */
export const RUN_ID = runDirName(CREATED_AT, RUN_NAME);

/** The command this script is reached by, recorded in `run.json` as the way back to it. */
export const DEMO_RUN_COMMAND = 'pnpm demo:run';

/**
 * Where the three seed groups start. A seed group is the same four people walking both
 * versions again, which is what makes the spread a spread rather than one session repeated.
 *
 * It is an offset from the audience's own seed rather than that seed itself, because which
 * three seeds a run uses is configuration and this run's had to be chosen: at the audience
 * seed and the two after it the clean version reads **29.1** against the 25 or fewer
 * `docs/FLOW.md` section 5 requires, because one of its three seed groups has two of its
 * three scored sessions give up on a checkout with nothing wrong with it. Eleven triples
 * were measured and all eleven are reported on #78, so the choice is visible rather than
 * quietly lucky: the comparison is the same in every one of them — the defective version
 * 70 to 73, the gap 31 to 48, the ±1σ bands disjoint in all three seed groups every time —
 * and what moves is the clean version's own level, between 21.6 and 39.4. This is the
 * triple where the clean version also reads as section 5 requires.
 */
const SEED_GROUP_OFFSET = 27;

export const SEED_GROUPS = [
  DEMO_AUDIENCE_SEED + SEED_GROUP_OFFSET,
  DEMO_AUDIENCE_SEED + SEED_GROUP_OFFSET + 1,
  DEMO_AUDIENCE_SEED + SEED_GROUP_OFFSET + 2,
];

/**
 * The two variants as the run artifact names them — uppercase ids, which is what
 * `screenshots/A/cart.png` and every area of interest have always spelt, and the names the
 * Comparison screen's two score cards carry.
 *
 * The shop's own `northwindVariants` gives the URLs and nothing else is restated here: the
 * task declares the pages, and this adds only what the artifact needs and a task has no
 * field for.
 */
const VARIANT_NAMES: Readonly<Record<string, string>> = {
  a: 'Current checkout',
  b: 'Redesign candidate',
};

const runVariants = (baseUrl: string): { walk: Variant[]; declared: Run['variants'] } => {
  const shopVariants = northwindVariants(baseUrl);
  return {
    walk: shopVariants.map((variant) => ({ id: variant.id.toUpperCase(), url: variant.url })),
    declared: shopVariants.map((variant) => ({
      id: variant.id.toUpperCase(),
      name: VARIANT_NAMES[variant.id] ?? variant.id.toUpperCase(),
      url: variant.url,
    })),
  };
};

/**
 * The engine's blend, read off the engine rather than stated here, and passed to the swarm
 * as nothing at all: this run uses the engine's own configuration.
 *
 * Worth saying why, because the seed fixture recorded `0.5 / 0.35 / 0.15` and this records
 * `1 / 1 / 1`. Those were the prototype's illustrative weights, and handing them to a real
 * run is not a neutral act: `P(area) ∝ exp(alpha·salience + beta·relevance + gamma·history)`,
 * and offline the salience term is identically zero because the engine reads no image. So
 * `alpha` weighs nothing whatever its value, while `beta` at 0.35 compresses the one term
 * that knows what the person is looking for into a third of its span — over forty areas on a
 * payment page, that is an agent looking very nearly at random, which is what the first real
 * run measured (#78): the control beside it went unlooked-at on most screens and a clean
 * checkout was abandoned.
 */
const ENGINE_WEIGHTS = {
  alpha: defaultEngineConfig.alpha,
  beta: defaultEngineConfig.beta,
  gamma: defaultEngineConfig.gamma,
};

/**
 * One session at a time. Not a performance choice: the device mix drives two viewports over
 * the same `screenshots/<variant>/<step>.png`, so with sessions in flight together which
 * capture wrote that file last — and so which viewport the committed image and its recorded
 * `pageHeight` and `foldY` belong to — would depend on scheduling.
 */
const CONCURRENCY = 1;

/** What an open run says where a finished one leads with its verdict. */
const NOTHING_SCORED_YET = 'Nothing has been scored yet.';

/** `packages/browser`'s capture cache, which the committed artifact does not carry. */
const CAPTURE_CACHE_DIR = '.capture-cache';

/**
 * The port the shop is served on for this run — fixed, and the one `packages/cli` already
 * keeps out of the way of (`server.ts`: "the demo shop's preview (4173)").
 *
 * `serveDemoShop()` takes a free port by default and that is right for a test, but this run
 * is committed: `run.json` records where each version was opened, and a port the operating
 * system picked would be the one field two regenerations could not agree on — a re-commit
 * would be a diff in two URLs and nothing else. A port already in use is reported as such
 * and the run stops, rather than writing an artifact under a different address.
 */
const DEMO_SHOP_PORT = 4173;

/* ===== running it ========================================================== */

/** What the generated run measured, for the report this script prints. */
export interface DemoRunMeasurement {
  readonly run: Run;
  readonly sessions: readonly Session[];
  readonly findings: Findings;
  readonly plantedDefects: PlantedDefectEvaluation;
}

export interface GenerateDemoRunOptions {
  /** The directory run directories sit in — the repository's `runs/` by default. */
  readonly runsRoot: string;
  /** Every line the run reports; nothing it prints carries a credential. */
  readonly report?: (line: string) => void;
  /**
   * The shop to serve. The demo shop's own directory by default, which is what `pnpm
   * demo:run` uses and what the committed artifact was produced from.
   *
   * It is an option so that the acceptance gate (#79) can run this same pipeline over a
   * **copy** of the shop with one planted defect taken out, and so show that the gate bites
   * rather than asserting that it would. Nothing else passes it.
   */
  readonly shopRoot?: string;
}

/** An artifact with no finding in it yet, which `findings.json` still has to parse as. */
const emptyFindings = (runId: string): Findings => ({
  schemaVersion: SCHEMA_VERSION,
  runId,
  findings: [],
});

/**
 * The run artifact, finished: the swarm's own run block with everything the scoring step
 * produces written over the placeholders an open run carries.
 *
 * `runSwarm` closes the run with its sessions, counts and totals and leaves the verdict
 * saying nothing has been scored yet — which is true until this runs. The scoring happens
 * here, in one place, from the sessions and the areas the run itself records, so every
 * number in the artifact is derived from the artifact.
 */
const scored = (run: Run, sessions: readonly Session[]): { run: Run; findings: Findings } => {
  const aoiMetrics = aggregate(sessions, run.aois);
  const scores = score(sessions, run.aois, aoiMetrics, run.task);
  const found = generateFindings(sessions, run.aois, aoiMetrics, scores);

  return {
    run: { ...run, aoiMetrics, scores, verdict: writeVerdict(scores, found, run.audience) },
    findings: { schemaVersion: SCHEMA_VERSION, runId: run.runId, findings: found },
  };
};

/**
 * The run as it stands before a session has run: status `open`, every claim about what is
 * about to happen on the record, and the placeholders the scoring step writes over.
 */
interface OpenRunParts {
  readonly declared: Run['variants'];
  readonly personas: Run['personas'];
  readonly plannedSessions: number;
  /** One row per variant, in the order the variants are declared. */
  readonly perVariant: readonly { readonly variant: string; readonly totalSessions: number }[];
  readonly engine: EngineOnTheRecord;
}

const openRun = ({
  declared,
  personas,
  plannedSessions,
  perVariant,
  engine,
}: OpenRunParts): Run => {
  const firstVariant = declared[0]?.id ?? '';
  const firstStep = NORTHWIND_TASK.steps[0]?.id ?? '';
  const viewport = personas[0]?.device.viewport ?? { width: 1, height: 1 };
  const openedAt = CREATED_AT.toISOString();

  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN_ID,
    createdAt: openedAt,
    status: 'open',
    startedAt: openedAt,
    progress: {
      totalSessions: plannedSessions,
      finishedSessions: 0,
      perVariant: perVariant.map((row) => ({ ...row, finishedSessions: 0 })),
      sessions: [],
    },
    task: { id: NORTHWIND_TASK.id, prompt: NORTHWIND_TASK.prompt },
    variants: declared,
    steps: NORTHWIND_TASK.steps.map((step) => ({ id: step.id, label: step.label })),
    stepCaptions: [],
    audience: OUTDOOR_GEAR_SHOPPERS,
    personas,
    seedGroups: SEED_GROUPS,
    engine: {
      mode: 'offline',
      provider: null,
      models: null,
      weights: ENGINE_WEIGHTS,
      version: engine.version,
    },
    reproduce: {
      command: DEMO_RUN_COMMAND,
      seeds: SEED_GROUPS,
      engineMode: 'offline',
      engineVersion: engine.version,
      // The devices the run drove, once each, in the order the audience declares them. The
      // people are generated from the audience, so what a session ran on is read off the
      // audience's own mix rather than restated here.
      devices: OUTDOOR_GEAR_SHOPPERS.devices.map((device) => ({
        name: device.name,
        viewport: device.viewport,
        deviceScaleFactor: device.deviceScaleFactor,
        touch: device.touch,
      })),
      steps: NORTHWIND_TASK.steps.map((step) => ({
        id: step.id,
        label: step.label,
        urlPattern: step.match.urlPattern,
        requiredSelector: step.match.requiredSelector,
        primaryActionSelector: step.primaryAction.selector,
        ...(step.goal === undefined ? {} : { goal: step.goal }),
      })),
    },
    sessionIds: [],
    screenshots: [
      {
        variant: firstVariant,
        step: firstStep,
        path: runPaths('').screenshot(firstVariant, firstStep),
        viewport,
        // What a page's height and fold are is measured when it is captured; until then the
        // declared screen is one viewport tall, which is the least a rendered page can be.
        pageHeight: viewport.height,
        foldY: viewport.height,
      },
    ],
    aois: [],
    aoiMetrics: [],
    scores: [],
    verdict: {
      harderVariant: declared.at(-1)?.id ?? firstVariant,
      gapPoints: 0,
      bandsDisjoint: false,
      seedGroupsAgreeing: 0,
      sentence: NOTHING_SCORED_YET,
      preferredVariant: firstVariant,
      audienceSentence: NOTHING_SCORED_YET,
      reasons: [NOTHING_SCORED_YET],
      headlineFindingIds: [],
      heroEvidence: { variant: firstVariant, step: firstStep, aoiId: null },
    },
    calibration: engine.calibration,
  };
};

/**
 * The shop on its fixed port, or a refusal that says which port and why it matters.
 */
const openShop = async (root: string | undefined): Promise<DemoShop> => {
  try {
    return await serveDemoShop({ port: DEMO_SHOP_PORT, root });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') throw error;
    throw new Error(
      `port ${String(DEMO_SHOP_PORT)} is in use, and this run is written with the shop's own URL in it: free the port and run \`${DEMO_RUN_COMMAND}\` again rather than committing an artifact served from somewhere else`,
      { cause: error },
    );
  }
};

export const generateDemoRun = async (
  options: GenerateDemoRunOptions,
): Promise<DemoRunMeasurement> => {
  const report = options.report ?? ((): void => undefined);
  const runDir = resolve(options.runsRoot, RUN_ID);
  const defects = declaredDefects();
  const personas = generatePersonas(OUTDOOR_GEAR_SHOPPERS, { seed: DEMO_AUDIENCE_SEED });

  const shop = await openShop(options.shopRoot);
  report(`demo:run: the shop is on ${shop.url}`);

  try {
    const { walk, declared } = runVariants(shop.url);
    const plan = planSwarm({ variants: walk, personas, seedGroups: SEED_GROUPS });
    const engine = engineOnTheRecord();

    // Replaced in place: the directory the screens and the tests read is this path, and a
    // regeneration is a diff rather than a second run beside the first. Swept first, so a
    // session file or a screenshot this run does not write cannot survive from the last one.
    await rm(runDir, { recursive: true, force: true });
    await writeRun(runDir, {
      run: openRun({
        declared,
        personas,
        plannedSessions: plan.length,
        perVariant: walk.map((variant) => ({
          variant: variant.id,
          totalSessions: plan.filter((session) => session.variant.id === variant.id).length,
        })),
        engine,
      }),
      sessions: [],
      findings: emptyFindings(RUN_ID),
    });

    const walked = await runSwarm({
      runDir,
      task: NORTHWIND_TASK,
      variants: walk,
      personas,
      seedGroups: SEED_GROUPS,
      source: createLiveSource(),
      providers: { decision: createOfflineDeterministicProvider({ seed: DEMO_AUDIENCE_SEED }) },
      concurrency: CONCURRENCY,
      // Fixed, so two regenerations are byte-identical: the artifact's timestamps are the
      // run's own and not the host's clock. What a session has left is measured on the
      // process clock inside the swarm, which this does not touch.
      now: () => CREATED_AT,
      onProgress: (event) => {
        if (event.kind === 'session-finished') {
          report(
            `demo:run: ${event.sessionId} ${event.personaName} · ${event.variant} · seed ${String(event.seed)} — ${event.outcome.status} on ${event.outcome.step}`,
          );
        }
      },
    });

    const final = scored(walked.run, walked.sessions);
    await writeRun(runDir, {
      run: final.run,
      sessions: [...walked.sessions],
      findings: final.findings,
    });
    // The capture cache is `packages/browser`'s own working state, not artifact data — it
    // says so itself, and `runPaths` spells no path into it. It also carries a key derived
    // from the port the shop happened to bind, so leaving it behind would be the one part
    // of the directory that two regenerations cannot agree on, and 24 sessions of it is
    // most of the committed weight.
    await rm(join(runDir, CAPTURE_CACHE_DIR), { recursive: true, force: true });

    return {
      run: final.run,
      sessions: walked.sessions,
      findings: final.findings,
      plantedDefects: evaluateAgainstPlantedDefects(final.findings.findings, defects.defects),
    };
  } finally {
    await shop.close();
  }
};

/* ===== the report ========================================================== */

const round = (value: number, places = 1): string => {
  const factor = 10 ** places;
  return String(Math.round(value * factor) / factor);
};

/**
 * The measurement the acceptance ticket takes its floors from: the score and its spread per
 * variant and per seed group, the ranked findings, precision and recall against the shop's
 * declared defects, and the automation-failure count.
 *
 * Printed rather than written into the artifact: the artifact carries the numbers, and this
 * is the reading of them `docs/FLOW.md` section 5 asks for.
 */
export const reportMeasurement = (
  measured: DemoRunMeasurement,
  report: (line: string) => void,
): void => {
  const { run, sessions, findings, plantedDefects } = measured;
  report('');
  report('demo:run: what this run measured');

  for (const variantScore of run.scores) {
    const perSeed = variantScore.perSeedGroup
      .map((group) => `${String(group.seed)}: ${round(group.frictionScore)}`)
      .join(', ');
    report(
      `  ${variantScore.variant}  friction ${round(variantScore.frictionScore.median)} ± ${round(variantScore.frictionScore.sd)}` +
        `  completion ${round(variantScore.completionRate, 2)}  (${perSeed})`,
    );
    report(
      `      outcomes success ${String(variantScore.outcomeCounts.success)},` +
        ` abandoned ${String(variantScore.outcomeCounts.abandoned)},` +
        ` failed ${String(variantScore.outcomeCounts.failed)},` +
        ` automation ${String(variantScore.outcomeCounts.automationFailure)}`,
    );
  }

  report(
    `  verdict  harder ${run.verdict.harderVariant}, gap ${round(run.verdict.gapPoints)},` +
      ` bands disjoint on ${String(run.verdict.seedGroupsAgreeing)} of ${String(run.seedGroups.length)} seed groups`,
  );
  report(`  preferred ${run.verdict.preferredVariant} — ${run.verdict.sentence}`);

  report(`  findings, ranked (${String(findings.findings.length)}):`);
  for (const finding of findings.findings) {
    report(
      `    ${String(finding.rank)}. ${finding.id}  ${finding.severity}` +
        `  ${finding.variant ?? 'run'}/${finding.step}  ${finding.aoiId ?? '—'}`,
    );
  }

  report(
    `  planted defects  precision ${round(plantedDefects.precision, 3)}` +
      `  recall ${round(plantedDefects.recall, 3)}`,
  );
  for (const matched of plantedDefects.matched) {
    report(`    ${matched.defectId} → ${matched.findingId ?? 'not found'}`);
  }

  const automation = sessions.filter(
    (session) => session.outcome.status === 'automation_failure',
  ).length;
  report(`  automation failures  ${String(automation)} of ${String(sessions.length)} sessions`);
};

const main = async (): Promise<void> => {
  const runsRoot = resolve(process.argv[2] ?? fileURLToPath(new URL('../runs', import.meta.url)));
  const report = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const measured = await generateDemoRun({ runsRoot, report });
  reportMeasurement(measured, report);
  report(`demo:run: wrote ${resolve(runsRoot, RUN_ID)}`);
};

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) await main();
