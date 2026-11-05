import {
  recommendationsSchema,
  runPaths,
  SCHEMA_VERSION,
  sessionSchema,
} from '@personavision/contract';
import type { Recommendations, Run, Session } from '@personavision/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateCostUsd, WONDER_MODEL_ID } from '../src/meta-pricing.js';
import { WonderReplyError } from '../src/wonder.js';
import {
  ANALYSIS_EFFORT,
  ANALYSIS_REPLY_SCHEMA_NAME,
  analysisAsk,
  writeAnalysis,
} from '../src/wonder-analysis.js';
import type { AnalysisAskInput, AnalysisFinding } from '../src/wonder-analysis.js';
import { createMetaWonderProvider, WONDER_PROVIDER_MODE } from '../src/wonder-model.js';
import { createOfflineWonderProvider } from '../src/wonder-offline.js';
import { fakeTransport, FAKE_TOKENS, TEST_ENV } from './wonder-fake.js';

/**
 * What Muse Wonder makes of a finished run (#261): ranked recommendations, every one
 * carrying the evidence it rests on, refused with the path when a citation names something
 * the run does not hold or a session that is excluded from every figure, and dropped rather
 * than published when it cites nothing at all.
 *
 * Nothing here reaches the network: the offline implementation is the default, and the model
 * implementation is driven by the recorded transport the whole package is tested through.
 */

const DEVICE = {
  name: 'Pixel 8',
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  touch: true,
} as const;

const TRAITS = {
  persistence: 0.5,
  scanningVsReading: 0.5,
  detailOrientation: 0.5,
  interfaceFamiliarity: 0.5,
  patience: 0.5,
  riskTolerance: 0.5,
} as const;

/**
 * A run as the artifact holds one, with every name a citation may use: four sessions, three
 * steps in funnel order, one variant and one area of interest.
 *
 * The blocks nothing in this use reads — the personas, the per-area metrics, the verdict's
 * arithmetic — are the smallest thing their types accept, on purpose: what this fixture is
 * for is the *declarations* a citation is checked against.
 */
const RUN: Run = {
  schemaVersion: SCHEMA_VERSION,
  runId: 'run-2026-11-04-gift',
  createdAt: '2026-11-04T09:00:00.000Z',
  task: { id: 'T-01', prompt: 'Buy a gift and have it delivered on Friday.' },
  feature: 'checking out with a promo code',
  goal: {
    task: 'A person who came to example.test attempts to buy a gift.',
    successCriterion: 'The page shows the text “Order complete”.',
    lastWrittenBy: 'model',
  },
  variants: [{ id: 'a', name: 'Live site', url: 'https://example.test/' }],
  steps: [
    { id: 'basket', label: 'Basket' },
    { id: 'delivery', label: 'Delivery' },
    { id: 'pay', label: 'Payment' },
  ],
  stepCaptions: [],
  audience: {
    id: 'AUD-01',
    name: 'People buying a gift',
    ageRange: { min: 25, max: 44 },
    roles: ['gift buyer'],
    regions: ['Almaty'],
    goals: ['have a gift delivered on Friday'],
    devices: [{ ...DEVICE, share: 1 }],
    techSavviness: 0.5,
    priceSensitivity: 0.6,
    size: 3,
    generatedFrom: { seed: 20_261_104, generatorVersion: 'test' },
  },
  personas: [],
  seedGroups: [1],
  engine: {
    mode: 'offline',
    provider: null,
    models: null,
    weights: { alpha: 1, beta: 1, gamma: 1 },
    version: 'test',
  },
  sessionIds: ['S-01', 'S-02', 'S-03', 'S-04'],
  screenshots: [],
  aois: [
    {
      id: 'aoi-delivery-cost',
      variant: 'a',
      step: 'delivery',
      label: 'Delivery cost',
      source: 'dom',
      role: null,
      bbox: { x: 0, y: 400, width: 412, height: 80 },
      isPrimaryAction: false,
      belowFold: true,
    },
  ],
  aoiMetrics: [],
  scores: [
    {
      variant: 'a',
      taskId: 'T-01',
      frictionScore: { median: 61, sd: 4 },
      completionRate: 1 / 3,
      components: {
        taskFailureRate: 0.34,
        abandonment: 0.34,
        timeToFirstFixationPrimary: { worstStep: 'delivery', medianSeconds: 6.2, value: 0.7 },
        deadEndRevisits: 0.2,
      },
      outcomeCounts: { success: 1, abandoned: 1, failed: 1, automationFailure: 1 },
      scoredSessionCount: 3,
      perSeedGroup: [{ seed: 1, frictionScore: 61 }],
    },
  ],
  verdict: {
    harderVariant: 'a',
    gapPoints: 0,
    bandsDisjoint: false,
    seedGroupsAgreeing: 1,
    sentence: 'One version was tested, so there is nothing to compare it with.',
    preferredVariant: 'a',
    audienceSentence: 'One of three people bought the gift.',
    reasons: ['The delivery cost is below the fold.'],
    headlineFindingIds: ['F-01'],
    heroEvidence: { variant: 'a', step: 'delivery', aoiId: 'aoi-delivery-cost' },
  },
  calibration: null,
};

/** One session, parsed, so the fixture is a session the contract accepts and not a guess. */
const session = (
  sessionId: string,
  outcome: { status: Session['outcome']['status']; step: string },
  video: 'recorded' | 'absent',
): Session =>
  sessionSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    runId: RUN.runId,
    variant: 'a',
    taskId: 'T-01',
    kind: 'simulated',
    persona: { id: `P-${sessionId}`, traits: TRAITS, device: DEVICE },
    participant: null,
    seed: 1,
    startedAt: '2026-11-04T09:01:00.000Z',
    durationMs: 9_000,
    screens: [
      {
        index: 0,
        step: 'basket',
        screenshot: 'basket.png',
        scrollY: 0,
        intent: 'find the gift',
        decidedAction: 'click “Add to basket”',
      },
      {
        index: 1,
        step: 'delivery',
        screenshot: 'delivery.png',
        scrollY: 300,
        intent: 'see what delivery costs',
        decidedAction: 'scroll',
      },
    ],
    fixations: [],
    saccades: [],
    actions: [],
    outcome: {
      status: outcome.status,
      step: outcome.step,
      reason:
        outcome.status === 'automation_failure'
          ? 'the browser lost the page'
          : 'the delivery cost was never found',
      attribution: outcome.status === 'automation_failure' ? 'automation' : 'product',
      excludedFromScores: outcome.status === 'automation_failure',
    },
    integrity: { selectorFailures: 0, retries: 0 },
    video:
      video === 'recorded'
        ? {
            state: 'recorded',
            path: runPaths('').video(sessionId),
            durationMs: 8_800,
            truncated: null,
            screenOffsetsMs: [0, 4_000],
            actionOffsetsMs: [],
          }
        : { state: 'absent', reason: 'the recorder was not running' },
  });

/** The sessions the run is about, and the automation failure that is out of every figure. */
const SESSIONS: readonly Session[] = [
  session('S-01', { status: 'failed', step: 'delivery' }, 'recorded'),
  session('S-02', { status: 'abandoned', step: 'basket' }, 'absent'),
  session('S-04', { status: 'automation_failure', step: 'pay' }, 'recorded'),
];

const finding = (overrides: Partial<AnalysisFinding> = {}): AnalysisFinding => ({
  id: 'F-01',
  rank: 1,
  severity: 'high',
  claim: 'Two of three people never found the delivery cost.',
  evidence: 'Both scrolled past the fold on the delivery step and left.',
  variant: 'a',
  step: 'delivery',
  aoiId: 'aoi-delivery-cost',
  sessionIds: ['S-01', 'S-02'],
  sessionCount: 2,
  attribution: 'product',
  evidence_link: { screen: 'attention', params: { variant: 'a', step: 'delivery' } },
  ...overrides,
});

const ON_BASKET = finding({
  id: 'F-02',
  rank: 2,
  severity: 'medium',
  claim: 'One person hesitated on the basket.',
  evidence: 'One person read the basket for eleven seconds before moving on.',
  variant: null,
  step: 'basket',
  aoiId: null,
  sessionIds: ['S-02'],
  sessionCount: 1,
  evidence_link: { screen: 'sessions', params: { step: 'basket' } },
});

/** Our own breakage: it produces no advice about the site. */
const OUR_FAULT = finding({
  id: 'F-03',
  rank: 3,
  severity: 'info',
  claim: 'One session lost its page.',
  evidence: 'The browser closed on the payment step.',
  step: 'pay',
  aoiId: null,
  sessionIds: ['S-04'],
  sessionCount: 1,
  attribution: 'automation',
  evidence_link: { screen: 'sessions', params: { step: 'pay' } },
});

const input = (overrides: Partial<AnalysisAskInput> = {}): AnalysisAskInput => ({
  run: RUN,
  findings: [finding(), ON_BASKET, OUR_FAULT],
  sessions: SESSIONS,
  seed: 7,
  ...overrides,
});

/** One recommendation as a cooperative model answers it, with one field made wrong at a time. */
interface Written {
  readonly id: string;
  readonly sentence: string;
  readonly evidence: string;
  readonly findingIds: readonly string[];
  readonly citations: readonly unknown[];
  readonly peopleAffected: number;
  readonly step: string;
}

const written = (overrides: Partial<Written> = {}): Written => ({
  id: 'R-01',
  sentence: 'Show the delivery cost above the fold on the delivery step.',
  evidence: 'Two of three people scrolled past it and left.',
  findingIds: ['F-01'],
  citations: [{ kind: 'session', sessionId: 'S-01', offsetMs: 4_000 }],
  peopleAffected: 2,
  step: 'delivery',
  ...overrides,
});

const reply = (...recommendations: readonly unknown[]): string =>
  JSON.stringify({ recommendations });

/** The model implementation, answering one recorded reply. */
const throughModel = (replyText: string, usage: unknown = FAKE_TOKENS) =>
  createMetaWonderProvider({
    env: TEST_ENV,
    transport: fakeTransport({ replyText: () => replyText, usage }).transport,
  });

const offline = (given: AnalysisAskInput = input()): Promise<Recommendations> =>
  writeAnalysis(createOfflineWonderProvider(), given).then((answer) => answer.value);

const refusalOf = async (promise: Promise<unknown>): Promise<WonderReplyError> => {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(WonderReplyError);
  return error as WonderReplyError;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the ask the analysis is written through', () => {
  it('is the analysis use, at the effort the live call was answered at', () => {
    const ask = analysisAsk(input());

    expect(ask.use).toBe('analysis');
    expect(ask.effort).toBe(ANALYSIS_EFFORT);
    expect(ANALYSIS_EFFORT).toBe('low');
    expect(ask.replySchema.name).toBe(ANALYSIS_REPLY_SCHEMA_NAME);
  });

  it('asks for the contract’s own fields, in the strict subset the protocol requires', () => {
    const schema = analysisAsk(input()).replySchema.schema as Record<string, unknown>;

    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['recommendations']);
    expect(schema.$schema).toBeUndefined();

    const one = (schema.properties as Record<string, Record<string, unknown>>).recommendations
      .items as Record<string, unknown>;
    expect(one.additionalProperties).toBe(false);
    expect(one.required).toEqual([
      'id',
      'sentence',
      'evidence',
      'findingIds',
      'citations',
      'peopleAffected',
      'step',
    ]);
    // The rank is the stored order of the list and not a field of an entry: it is computed
    // from `peopleAffected` and `step`, so the model is never asked to report one.
    expect(Object.keys(one.properties as object)).not.toContain('rank');
  });

  it('shows the model every name a citation may use, and the sessions it may not cite', () => {
    const document = analysisAsk(input()).document;

    expect(document).toContain('`basket` (Basket)');
    expect(document).toContain('`aoi-delivery-cost`');
    expect(document).toContain('F-01');
    expect(document).toContain('### S-01 (a)');
    expect(document).toContain('`delivery` at 4000 ms');
    expect(document).toContain('Sessions you may not cite');
    expect(document).toContain('`S-04`');
    // The score the recommendations are written against, and the criterion the run ran.
    expect(document).toContain('friction score 61 of 100');
    expect(document).toContain('The page shows the text “Order complete”.');
    expect(document).toContain('the step people were slowest to reach the primary action on');
  });

  /**
   * A test of one URL names no control that advances the task (#418), so its score carries
   * no time to one (#422). The line is **dropped** rather than printed with an empty step:
   * "the step people were slowest to reach the primary action on: ``" is a sentence about
   * nothing, and every recommendation the model writes would rest on it.
   */
  it('drops the slowest-step line when the run had no control to time', () => {
    const notMeasured: Run = {
      ...RUN,
      scores: RUN.scores.map((score) => ({
        ...score,
        components: { ...score.components, timeToFirstFixationPrimary: null },
      })),
    };
    const document = analysisAsk(input({ run: notMeasured })).document;

    expect(document).toContain('friction score 61 of 100');
    expect(document).not.toContain('slowest to reach the primary action');
  });

  it('refuses to be built for a run with no session read', () => {
    expect(() => analysisAsk(input({ sessions: [] }))).toThrow(/sessions/);
  });
});

describe('the recommendations, offline', () => {
  it('turns a run’s scores, findings and sessions into ranked recommendations with no key and no network', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('the offline analysis reaches no network');
    });

    const answer = await writeAnalysis(createOfflineWonderProvider(), input());

    expect(() => recommendationsSchema.parse(answer.value)).not.toThrow();
    expect(answer.value.runId).toBe(RUN.runId);
    expect(answer.value.recommendations.map((one) => one.step)).toEqual(['delivery', 'basket']);
    expect(answer.value.nothingToRecommend).toBeUndefined();
    expect(answer.model).toBeNull();
    expect(answer.usage.estimatedCostUsd).toBe(0);
  });

  it('gives the same recommendations in the same order for the same run and the same seed', async () => {
    expect(await offline()).toEqual(await offline());

    // A fresh provider and a provider that has already answered answer alike: the seed is on
    // the ask and nothing is kept between calls.
    const provider = createOfflineWonderProvider();
    await writeAnalysis(provider, input({ seed: 99 }));
    expect((await writeAnalysis(provider, input())).value).toEqual(await offline());
  });

  it('ranks by how many people a change reaches, with dense unique ranks', async () => {
    const { recommendations } = await offline();

    expect(recommendations.map((one) => one.rank)).toEqual([1, 2]);
    expect(recommendations[0].peopleAffected).toBe(2);
    expect(recommendations[1].peopleAffected).toBe(1);
  });

  it('breaks a tie with the earlier funnel step, which everybody walked through', async () => {
    const tied = input({
      findings: [
        finding({ id: 'F-01', step: 'pay', aoiId: null, sessionIds: ['S-01'], sessionCount: 1 }),
        finding({ id: 'F-02', step: 'basket', aoiId: null, sessionIds: ['S-02'], sessionCount: 1 }),
      ],
    });

    const { recommendations } = await offline(tied);

    expect(recommendations.map((one) => one.step)).toEqual(['basket', 'pay']);
    expect(recommendations.map((one) => one.rank)).toEqual([1, 2]);
  });

  it('cites the session, the heatmap region and the funnel step the finding names', async () => {
    const { recommendations } = await offline();

    expect(recommendations[0].citations).toEqual(
      expect.arrayContaining([
        { kind: 'heatmap', variant: 'a', step: 'delivery', aoiId: 'aoi-delivery-cost' },
        { kind: 'funnel', stepId: 'delivery' },
      ]),
    );
    const cited = recommendations[0].citations.find((one) => one.kind === 'session');
    expect(cited).toBeDefined();
    expect(['S-01', 'S-02']).toContain(cited?.kind === 'session' ? cited.sessionId : '');
  });

  it('rests no recommendation on an automation failure, and writes none from our own breakage', async () => {
    const { recommendations } = await offline();
    const sessionsCited = recommendations.flatMap((one) =>
      one.citations.flatMap((citation) =>
        citation.kind === 'session' ? [citation.sessionId] : [],
      ),
    );

    expect(sessionsCited).not.toContain('S-04');
    expect(recommendations.flatMap((one) => one.findingIds)).not.toContain('F-03');
  });

  it('states no number of people for a finding whose every session is excluded', async () => {
    // The heatmap and the funnel are still behind it, so it is advice — but nobody citable
    // is, and a sentence reading “0 people” would be a figure nobody measured.
    const onlyExcluded = input({
      findings: [finding({ sessionIds: ['S-04'], sessionCount: 1 })],
    });

    const { recommendations } = await offline(onlyExcluded);

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].peopleAffected).toBe(0);
    expect(recommendations[0].sentence).not.toContain('0 people');
    expect(recommendations[0].sentence).toMatch(/step\.$/);
    expect(recommendations[0].citations.some((one) => one.kind === 'session')).toBe(false);
  });

  it('says in one sentence why a run with no finding recommends nothing', async () => {
    const value = await offline(input({ findings: [] }));

    expect(value.recommendations).toEqual([]);
    expect(value.nothingToRecommend).toContain('read 2 of 3 sessions');
    expect(value.sample).toEqual({
      read: 2,
      of: 3,
      strategy: 'the sessions handed to this ask',
      seed: 7,
    });
  });

  it('records the provenance the sampler drew, where the caller recorded one', async () => {
    const sample = { read: 20, of: 93, strategy: 'stratified by outcome, then segment', seed: 5 };

    expect((await offline(input({ sample }))).sample).toEqual(sample);
  });

  it('is read back through its own validator unchanged, so a document may be parsed twice', () => {
    const ask = analysisAsk(input());
    const once = ask.offline(7);

    expect(ask.parse(once)).toEqual(once);
  });
});

describe('the analysis through the model implementation', () => {
  it('reads the documented envelope into the same objects, and counts what it cost', async () => {
    const answer = await writeAnalysis(throughModel(reply(written())), input());

    expect(() => recommendationsSchema.parse(answer.value)).not.toThrow();
    expect(answer.value.recommendations).toEqual([{ ...written(), rank: 1 }]);
    expect(answer.model).toEqual({ mode: WONDER_PROVIDER_MODE, modelId: WONDER_MODEL_ID });

    const tokens = {
      inputTokens: FAKE_TOKENS.input_tokens,
      cachedInputTokens: FAKE_TOKENS.input_tokens_details.cached_tokens,
      outputTokens: FAKE_TOKENS.output_tokens,
      reasoningTokens: FAKE_TOKENS.output_tokens_details.reasoning_tokens,
    };
    expect(answer.usage).toEqual({
      ...tokens,
      estimatedCostUsd: estimateCostUsd(WONDER_MODEL_ID, tokens),
    });
    expect(answer.usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('stores its own dense ranks, whatever order the reply came in and whatever rank it claimed', async () => {
    const answered = reply(
      { ...written({ id: 'R-09', peopleAffected: 1, step: 'basket' }), rank: 7 },
      { ...written(), rank: 7 },
    );

    const { value } = await writeAnalysis(throughModel(answered), input());

    expect(value.recommendations.map((one) => [one.id, one.rank])).toEqual([
      ['R-01', 1],
      ['R-09', 2],
    ]);
  });
});

describe('a claim with no evidence', () => {
  it('is not emitted, and the recommendations that cite theirs keep dense ranks', async () => {
    const answered = reply(written({ id: 'R-02', citations: [], peopleAffected: 9 }), written());

    const { value } = await writeAnalysis(throughModel(answered), input());

    expect(value.recommendations.map((one) => [one.id, one.rank])).toEqual([['R-01', 1]]);
    expect(value.recommendations.every((one) => one.citations.length > 0)).toBe(true);
  });

  it('says so in one stored sentence rather than becoming an empty recommendation list', async () => {
    const answered = reply(written({ citations: [] }), written({ id: 'R-02', citations: [] }));

    const { value } = await writeAnalysis(throughModel(answered), input());

    expect(value.recommendations).toEqual([]);
    expect(value.nothingToRecommend).toBe(
      'Muse Wonder wrote 2 recommendations for this run and not one of them cited any evidence, so none is published — a claim with nothing to cite is not published.',
    );
  });

  it('is told apart from a reply that recommended nothing in the first place', async () => {
    const { value } = await writeAnalysis(throughModel(reply()), input());

    expect(value.recommendations).toEqual([]);
    expect(value.nothingToRecommend).toBe(
      'Muse Wonder read 2 of 3 sessions of this run and wrote no recommendation.',
    );
  });
});

describe('a citation naming something the run does not hold', () => {
  const refused = (...recommendations: readonly unknown[]): Promise<WonderReplyError> =>
    refusalOf(writeAnalysis(throughModel(reply(...recommendations)), input()));

  it('refuses an automation-failure session with the path and the rule', async () => {
    const error = await refused(
      written({ citations: [{ kind: 'session', sessionId: 'S-04', offsetMs: 10 }] }),
    );

    expect(error.paths).toContain('recommendations[0].citations[0].sessionId');
    expect(error.message).toContain('excluded from every figure');
    expect(error.use).toBe('analysis');
    expect(error.attribution).toBe('automation');
  });

  it('refuses a session the run does not list, with the path', async () => {
    const error = await refused(
      written({ citations: [{ kind: 'session', sessionId: 'S-99', offsetMs: 10 }] }),
    );

    expect(error.paths).toContain('recommendations[0].citations[0].sessionId');
    expect(error.message).toContain('names no session listed in run.json sessionIds');
  });

  it('refuses a timestamp past the end of the recording it cites', async () => {
    const error = await refused(
      written({ citations: [{ kind: 'session', sessionId: 'S-01', offsetMs: 99_000 }] }),
    );

    expect(error.paths).toContain('recommendations[0].citations[0].offsetMs');
    expect(error.message).toContain('8800 ms recording');
  });

  it('refuses a heatmap region whose variant, step or area the run does not declare', async () => {
    const error = await refused(
      written({
        citations: [{ kind: 'heatmap', variant: 'b', step: 'nowhere', aoiId: 'aoi-made-up' }],
      }),
    );

    expect(error.paths).toEqual([
      'recommendations[0].citations[0].variant',
      'recommendations[0].citations[0].step',
      'recommendations[0].citations[0].aoiId',
    ]);
  });

  it('refuses a funnel step the run does not declare', async () => {
    const error = await refused(written({ citations: [{ kind: 'funnel', stepId: 'nowhere' }] }));

    expect(error.paths).toContain('recommendations[0].citations[0].stepId');
  });

  it('refuses a finding the run never stated, and a step the funnel has not got', async () => {
    const error = await refused(written({ findingIds: ['F-77'], step: 'nowhere' }));

    expect(error.paths).toEqual(
      expect.arrayContaining(['recommendations[0].step', 'recommendations[0].findingIds[0]']),
    );
  });

  it('refuses one id used twice, rather than losing one of the two', async () => {
    const error = await refused(written(), written({ peopleAffected: 1 }));

    expect(error.paths).toContain('recommendations[1].id');
  });

  it('reports every place a reply is wrong, not the first', async () => {
    const error = await refused(
      written({
        findingIds: ['F-77'],
        citations: [
          { kind: 'session', sessionId: 'S-99', offsetMs: 1 },
          { kind: 'funnel', stepId: 'nowhere' },
        ],
      }),
    );

    expect(error.paths).toEqual([
      'recommendations[0].findingIds[0]',
      'recommendations[0].citations[0].sessionId',
      'recommendations[0].citations[1].stepId',
    ]);
  });
});

describe('a reply that could not be read', () => {
  const refused = (replyText: string): Promise<WonderReplyError> =>
    refusalOf(writeAnalysis(throughModel(replyText), input()));

  it('names the path of a field of the wrong type, and never an empty list', async () => {
    const error = await refused(reply(written({ peopleAffected: -3 })));

    expect(error.paths).toContain('recommendations[0].peopleAffected');
    expect(error.message).toContain('never turned into a partial, defaulted or empty answer');
  });

  it('names a recommendation written as two sentences', async () => {
    const error = await refused(
      reply(written({ sentence: 'Show the delivery cost. Then test it again.' })),
    );

    expect(error.paths).toContain('recommendations[0].sentence');
  });

  it('names a recommendation resting on no finding at all', async () => {
    const error = await refused(reply(written({ findingIds: [] })));

    expect(error.paths).toContain('recommendations[0].findingIds');
  });

  it('refuses a reply carrying no list of recommendations, rather than reading it as none', async () => {
    const error = await refused(JSON.stringify({ advice: 'make the site nicer' }));

    expect(error.paths).toContain('recommendations');
  });
});
