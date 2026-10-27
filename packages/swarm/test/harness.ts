/**
 * What every `runSession` test runs against: the committed capture set, the fixture site's
 * four-step task, and people to walk it.
 *
 * The capture set is `packages/browser`'s — recorded once from the fixture site and checked
 * in — so this suite starts no browser, opens no socket and reads the same bytes every time.
 */

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureSource } from '@personavision/browser';
import { runPaths, SCHEMA_VERSION, writeRun, ZERO_USAGE } from '@personavision/contract';
import {
  createDecisionSession,
  createMetaModelApiProvider,
  createOfflineDeterministicProvider,
} from '@personavision/provider';
import type { CaptureSource, Device, TaskDefinition } from '@personavision/browser';
import type { Persona, Run } from '@personavision/contract';
import type {
  Decision,
  DecisionContext,
  DecisionProvider,
  DecisionSession,
  ModelMode,
  ModelTransport,
} from '@personavision/provider';
import type { RunSessionInput } from '../src/index.js';

/** The run every test here writes, named as a run directory is. */
export const RUN_ID = '2026-10-27-1200-fixture';

/** The capture set `pnpm -F @personavision/browser record:captures` wrote. */
export const COMMITTED = fileURLToPath(
  new URL('../../browser/test/fixtures/captures', import.meta.url),
);

/** The two devices the committed set was recorded under, as its index records them. */
export const MOBILE: Device = {
  name: 'mobile',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  touch: true,
};

export const DESKTOP: Device = {
  name: 'desktop',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  touch: false,
};

/** The fixture site's checkout, as `packages/browser`'s own integration suite declares it. */
export const TASK: TaskDefinition = {
  id: 'checkout',
  prompt: 'Buy the canvas tote bag: check out, pay and place the order.',
  steps: [
    {
      id: 'cart',
      label: 'Cart',
      match: { urlPattern: '/cart\\.html', requiredSelector: '#cart-items' },
      primaryAction: { selector: '#cart-checkout' },
    },
    {
      id: 'payment',
      label: 'Payment',
      match: { urlPattern: '/payment\\.html', requiredSelector: '#payment-form' },
      primaryAction: { selector: '#payment-submit' },
    },
    {
      id: 'review',
      label: 'Review',
      match: { urlPattern: '/review\\.html', requiredSelector: '#review-summary' },
      primaryAction: { selector: '#review-place-order' },
    },
    {
      id: 'confirmation',
      label: 'Confirmation',
      match: { urlPattern: '/confirmation\\.html', requiredSelector: '#confirmation-receipt' },
      primaryAction: { selector: '#confirmation-continue-shopping' },
    },
  ],
};

/** The variant the committed set recorded at each device's viewport. */
export const variantFor = (id: 'A' | 'B') => ({ id, url: 'https://fixture.test/cart.html' });

const TRAITS = {
  careful: {
    persistence: 0.8,
    scanningVsReading: 0.3,
    detailOrientation: 0.8,
    interfaceFamiliarity: 0.6,
    patience: 0.8,
    riskTolerance: 0.3,
  },
  rushed: {
    persistence: 0.25,
    scanningVsReading: 0.9,
    detailOrientation: 0.2,
    interfaceFamiliarity: 0.75,
    patience: 0.15,
    riskTolerance: 0.7,
  },
} as const satisfies Record<string, Persona['traits']>;

/** One generated person, as `packages/personas` would hand it over. */
export const personaWho = (who: keyof typeof TRAITS, device: Device = MOBILE): Persona => ({
  id: who,
  name: who === 'careful' ? 'Careful comparer' : 'Rushed buyer',
  audienceId: 'outdoor-gear-shoppers',
  segment: who === 'careful' ? 'Careful comparer' : 'Rushed buyer',
  traits: TRAITS[who],
  device,
});

/** A run directory of its own per test, swept afterwards. */
export const temporaryRunDir = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), 'personavision-swarm-'));

export const sweep = async (runDir: string): Promise<void> => {
  await rm(runDir, { recursive: true, force: true });
};

/** Everything a session needs, with the committed set replaying it and nobody watching. */
export const sessionOver = (
  runDir: string,
  over: Partial<RunSessionInput> = {},
): RunSessionInput => ({
  runDir,
  runId: RUN_ID,
  sessionId: 'S-01',
  variant: variantFor('A'),
  persona: personaWho('careful'),
  seed: 11,
  task: TASK,
  source: createFixtureSource(COMMITTED),
  providers: { decision: createOfflineDeterministicProvider({ seed: 11 }) },
  // Fixed, because a reproducible session is reproducible in every field and the clock is
  // the one thing this loop cannot derive.
  startedAt: '2026-10-27T12:00:00.000Z',
  ...over,
});

/**
 * A provider that answers whatever a test tells it to.
 *
 * Its session handle is `createDecisionSession`'s, because that is the body of `beginSession`
 * in both providers that ship — so a test provider that hand-rolled one would behave
 * differently from either of them in the one way that matters here: a real handle holds every
 * turn still in flight and its `close` waits for all of them, so a test with a reply that
 * never comes would pass against a hand-rolled handle and hang against a real one.
 */
export const providerThat = (
  answer: (context: DecisionContext) => Decision,
  over: Partial<Pick<DecisionProvider, 'name' | 'mode' | 'readsImages'>> = {},
): DecisionProvider => {
  const decide = async (context: DecisionContext): Promise<Decision> => answer(context);
  return {
    name: 'test-provider',
    mode: 'offline',
    readsImages: false,
    ...over,
    decide,
    beginSession: ({ personaId, seed }): DecisionSession =>
      createDecisionSession({ personaId, seed, decide }),
  };
};

/**
 * A key-shaped string that is not a key, so that the model provider will make its call and a
 * hygiene assertion has something to hunt for.
 */
export const NOT_A_KEY = 'swarm-test-model-key-0123456789-not-real';

/** The element ids one screen message lists, in the order it lists them. */
const listedElementIds = (request: Parameters<ModelTransport>[0]): readonly string[] => {
  const message = [...request.body.input].reverse().find((item) => item.role === 'user');
  const part = message?.content.find((item) => item.type === 'input_text');
  const text = part !== undefined && 'text' in part ? part.text : '';
  return [...text.matchAll(/^- (\S+) · /gm)].map((match) => match[1] ?? '');
};

/**
 * A model-mode provider whose transport is a cooperative fake rather than the API: it acts on
 * the first element the screen lists, and scrolls when the agent has looked at nothing.
 *
 * It is the real Meta Model API provider, so a session run on it writes a real trajectory —
 * which is the point of using it here rather than `providerThat` (#139). No socket is opened
 * and the key is a fake.
 */
export const metaProviderOverFake = (mode: ModelMode = 'contributor'): DecisionProvider =>
  createMetaModelApiProvider({
    mode,
    apiKey: NOT_A_KEY,
    transport: (request) => {
      const ids = listedElementIds(request);
      const reply =
        ids[0] === undefined
          ? {
              intent: 'Nothing here yet; I will look further down.',
              action: { kind: 'scroll', targetElementId: null },
            }
          : {
              intent: 'That looks like the way on.',
              action: { kind: 'click', targetElementId: ids[0] },
            };
      return Promise.resolve({
        status: 200,
        body: {
          id: 'resp-fixture',
          status: 'completed',
          output: [
            { type: 'reasoning', summary: ['weighed the options'] },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify(reply) }],
            },
          ],
          usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 400 },
            output_tokens: 200,
            output_tokens_details: { reasoning_tokens: 150 },
          },
        },
      });
    },
  });

/** Every context one provider was handed, in the order the session asked. */
export const recording = (
  inner: DecisionProvider,
): { provider: DecisionProvider; contexts: DecisionContext[] } => {
  const contexts: DecisionContext[] = [];
  const watch =
    (decide: DecisionSession['decide']): DecisionSession['decide'] =>
    (context) => {
      contexts.push(context);
      return decide(context);
    };
  return {
    contexts,
    provider: {
      ...inner,
      decide: watch((context) => inner.decide(context)),
      // The scope is forwarded rather than dropped: the run lends the session its trajectory
      // through it, and a watcher that swallowed it would make a recorded session write
      // nothing (#139).
      beginSession: (identity, scope) => {
        const session = inner.beginSession(identity, scope);
        return { ...session, decide: watch((context) => session.decide(context)) };
      },
    },
  };
};

/** Every action one source was asked to perform, in order. */
export const watchingActs = (
  inner: CaptureSource,
): { source: CaptureSource; acts: Parameters<CaptureSource['act']>[1][] } => {
  const acts: Parameters<CaptureSource['act']>[1][] = [];
  return {
    acts,
    source: {
      ...inner,
      act: (page, action, ctx, options) => {
        acts.push(action);
        return inner.act(page, action, ctx, options);
      },
    },
  };
};

/**
 * A capture set whose two variants were recorded under one device, derived into a temporary
 * directory from the committed one.
 *
 * The committed set records variant A on mobile and variant B on desktop, and a replay
 * rightly refuses a device the variant was not recorded under: every `belowFold` in a
 * capture came from that viewport's fold. But a swarm runs **the same people** against both
 * variants and a person has one device, so no swarm can walk that set end to end. This
 * mints variant B from the recorded A — the same pages at the same viewport under B's name
 * — so a session on either variant replays bytes that were really recorded, and the two
 * variants' areas of interest still have ids of their own.
 */
export const oneDeviceCaptureSet = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'personavision-captures-'));
  const index = JSON.parse(await readFile(join(COMMITTED, 'capture-set.json'), 'utf8')) as {
    formatVersion: number;
    variants: { id: string; device: Device; steps: { step: string; path: string }[] }[];
  };
  const recorded = index.variants.find((variant) => variant.id === 'A');
  if (recorded === undefined) throw new Error(`${COMMITTED} records no variant "A"`);

  await writeFile(
    join(dir, 'capture-set.json'),
    JSON.stringify({ ...index, variants: [recorded, { ...recorded, id: 'B' }] }, null, 2),
  );
  for (const { step } of recorded.steps) {
    const capture = JSON.parse(
      await readFile(join(COMMITTED, 'captures', 'A', `${step}.json`), 'utf8'),
    ) as Record<string, unknown>;
    for (const variant of ['A', 'B']) {
      const screenshot = runPaths('').screenshot(variant, step);
      await mkdir(join(dir, 'captures', variant), { recursive: true });
      await mkdir(dirname(join(dir, screenshot)), { recursive: true });
      await writeFile(
        join(dir, 'captures', variant, `${step}.json`),
        JSON.stringify({ ...capture, variant, screenshot }, null, 2),
      );
      await copyFile(join(COMMITTED, runPaths('').screenshot('A', step)), join(dir, screenshot));
    }
  }
  return dir;
};

/** The task's steps, as `run.json` lists them. */
const STEPS = TASK.steps.map((step) => ({ id: step.id, label: step.label }));

/** One variant as `run.json` records it: the id and url a session walks, plus its name. */
export const runVariant = (id: 'A' | 'B'): Run['variants'][number] => ({
  ...variantFor(id),
  name: `Variant ${id}`,
});

/**
 * The audience the people below were generated from. Inline rather than the committed
 * preset, because a run's audience declares how many people it generates and these tests
 * run two, four or none of them.
 */
export const audienceOf = (size: number): Run['audience'] => ({
  id: 'outdoor-gear-shoppers',
  name: 'Outdoor-gear shoppers',
  ageRange: { min: 25, max: 55 },
  roles: ['Shopper'],
  regions: ['UK'],
  goals: ['Buy a tote bag'],
  devices: [{ ...MOBILE, share: 1 }],
  techSavviness: 0.5,
  priceSensitivity: 0.5,
  size,
  generatedFrom: { seed: 7, generatorVersion: 'test' },
});

/**
 * One generated person on the one device the capture set was recorded under.
 *
 * The device carries the person's own `name`, which is a label a recording does not depend
 * on — the replay compares the viewport and the scale factor, as a fold-dependent number
 * must. It is what lets a test break the page for one person and watch the rest of the
 * swarm carry on, because a capture source is handed a variant and a device and never a
 * persona.
 */
export const personOnMobile = (
  who: 'careful' | 'rushed',
  { id, name, segment }: { id: string; name: string; segment?: string },
): Persona => ({
  ...personaWho(who),
  id,
  name,
  device: { ...MOBILE, name: `mobile-${id}` },
  ...(segment === undefined ? {} : { segment }),
});

/** The four people of the demo, as a generator would hand them over. */
export const FOUR_PEOPLE: readonly Persona[] = [
  personOnMobile('rushed', { id: 'rushed', name: 'Rushed buyer' }),
  personOnMobile('careful', { id: 'careful', name: 'Careful comparer' }),
  personOnMobile('rushed', { id: 'firsttime', name: 'First-time visitor', segment: 'First-time' }),
  personOnMobile('careful', { id: 'price', name: 'Price-sensitive scanner', segment: 'Price' }),
];

/**
 * The open run a swarm runs into, written as its caller writes it (#54): the audience, the
 * people, the task, the engine mode and the plan's per-variant totals, with status `open`
 * and nothing finished.
 *
 * The placeholder verdict and the one screen it points at are the contract's requirement of
 * any `run.json`, open or not: a run names the evidence its verdict turns on, and the
 * screens are declared for the areas the sessions have not reported yet.
 */
export const writeOpenRun = async (
  runDir: string,
  plan: {
    personas: readonly Persona[];
    variants: ReadonlyArray<Run['variants'][number]>;
    seedGroups: number[];
    /** Offline unless a test is about what a model run cost. */
    engine?: Run['engine'];
    /**
     * The task and its steps, when the run is over a task other than this harness's — the
     * behaviour suite's fixtures declare their own (`fixtures.ts`), and a run's `steps` have
     * to be the steps its sessions report or the directory does not validate.
     */
    task?: Run['task'];
    steps?: Run['steps'];
    /** The device the run's people are on, which is the one its capture set was recorded at. */
    device?: Device;
    /** The audience the run's people were generated from, when it is not this harness's. */
    audienceId?: string;
  },
): Promise<Run> => {
  const steps = plan.steps ?? STEPS;
  const device = plan.device ?? MOBILE;
  const total = plan.personas.length * plan.seedGroups.length;
  const run: Run = {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN_ID,
    createdAt: '2026-10-27T12:00:00.000Z',
    status: 'open',
    startedAt: '2026-10-27T12:00:00.000Z',
    progress: {
      totalSessions: total * plan.variants.length,
      finishedSessions: 0,
      perVariant: plan.variants.map((variant) => ({
        variant: variant.id,
        totalSessions: total,
        finishedSessions: 0,
      })),
      sessions: [],
    },
    usage: { ...ZERO_USAGE },
    task: plan.task ?? { id: TASK.id, prompt: TASK.prompt },
    variants: [...plan.variants],
    steps: [...steps],
    stepCaptions: [],
    audience: {
      ...audienceOf(plan.personas.length),
      ...(plan.audienceId === undefined ? {} : { id: plan.audienceId }),
      devices: [{ ...device, share: 1 }],
    },
    personas: [...plan.personas],
    seedGroups: plan.seedGroups,
    engine: plan.engine ?? {
      mode: 'offline',
      provider: 'offline-deterministic',
      models: null,
      weights: { alpha: 1, beta: 1, gamma: 1 },
      version: 'test',
    },
    sessionIds: [],
    screenshots: [
      {
        variant: plan.variants[0]?.id ?? 'A',
        step: steps[0]?.id ?? 'cart',
        path: runPaths('').screenshot(plan.variants[0]?.id ?? 'A', steps[0]?.id ?? 'cart'),
        viewport: device.viewport,
        pageHeight: 1400,
        foldY: device.viewport.height,
      },
    ],
    aois: [],
    aoiMetrics: [],
    scores: [],
    verdict: {
      harderVariant: plan.variants.at(-1)?.id ?? 'A',
      gapPoints: 0,
      bandsDisjoint: false,
      seedGroupsAgreeing: 0,
      sentence: 'Nothing has been scored yet.',
      preferredVariant: plan.variants[0]?.id ?? 'A',
      audienceSentence: 'Nothing has been scored yet.',
      reasons: ['Nothing has been scored yet.'],
      headlineFindingIds: [],
      heroEvidence: {
        variant: plan.variants[0]?.id ?? 'A',
        step: steps[0]?.id ?? 'cart',
        aoiId: null,
      },
    },
    calibration: null,
  };
  await writeRun(runDir, {
    run,
    sessions: [],
    findings: { schemaVersion: SCHEMA_VERSION, runId: RUN_ID, findings: [] },
  });
  return run;
};

const nodeRequire = createRequire(import.meta.url);

const LAUNCHERS = ['spawn', 'spawnSync', 'fork', 'exec', 'execFile', 'execFileSync', 'execSync'];

/**
 * Runs something with every way of launching a process or opening a socket broken.
 *
 * The project's promise is that a cold clone with no API key and no network runs the whole
 * of the loop (step #8), and this is where it is checked rather than intended: a session or
 * a swarm that reached for Chromium or for a model fails inside the call instead of quietly
 * succeeding on a machine that happens to have both. The technique is
 * `packages/browser/test/fixture-source.test.ts`'s, applied one layer up.
 */
export const withNothingRunning = async <T>(body: () => Promise<T>): Promise<T> => {
  const childProcess = nodeRequire('node:child_process') as Record<string, unknown>;
  const net = nodeRequire('node:net') as { Socket: { prototype: Record<string, unknown> } };

  const saved = new Map(LAUNCHERS.map((name) => [name, childProcess[name]]));
  const savedConnect = net.Socket.prototype.connect;
  const refuse = (what: string) => (): never => {
    throw new Error(`a session in fixture mode reached for ${what}`);
  };

  for (const name of LAUNCHERS) childProcess[name] = refuse(`child_process.${name}`);
  net.Socket.prototype.connect = refuse('a socket');

  try {
    return await body();
  } finally {
    for (const [name, original] of saved) childProcess[name] = original;
    net.Socket.prototype.connect = savedConnect;
  }
};
