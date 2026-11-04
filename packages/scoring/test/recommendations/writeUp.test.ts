import {
  recommendationsSchema,
  SCHEMA_VERSION,
  validateRecommendations,
  type Citation,
  type Recommendation,
  type Recommendations,
  type SampleProvenance,
} from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import {
  aggregateComputedAt,
  composeAggregate,
  WHOLE_RUN_STRATEGY,
  type Finding,
} from '../../src/index.js';
import { WHAT_I_DID_NOT_FIND, writeUp } from '../../src/recommendations/writeUp.js';
import { smallRun, smallRunSessions } from '../fixtures/aggregate.js';

/**
 * The write-up generator: the recommendations of a run, read as prose a site owner reads
 * top to bottom.
 *
 * **Nothing here is a straw man.** The recommendations are built through
 * `recommendationsSchema`, so each one is a document the builder could have handed over, and
 * the finished write-up is put back through that schema and then through
 * `validateRecommendations` — the run-level citation validator of #254 — so *"every claim
 * carries a citation that resolves"* is asserted by the thing that enforces it on the way to
 * disk rather than by a second opinion about it.
 *
 * The run is the aggregate step's small run: six people, four steps, two versions, one of
 * them our own harness failing, and a funnel that can be counted by hand — 5 on the landing
 * and prompt steps, 4 on generate, 3 on preview, with the biggest drop on `prompt`.
 */

const RUN = smallRun;
const SESSIONS = smallRunSessions;
const AGGREGATE = composeAggregate({
  run: RUN,
  sessions: SESSIONS,
  computedAt: aggregateComputedAt(RUN),
});
/** The same run with nothing excluded, for the footnote that is absent when there is none. */
const NO_FAILURES = composeAggregate({
  run: RUN,
  sessions: SESSIONS.filter((session) => !session.outcome.excludedFromScores),
  computedAt: aggregateComputedAt(RUN),
});

const SAMPLE: SampleProvenance = { read: 5, of: 6, strategy: WHOLE_RUN_STRATEGY, seed: 7 };

const findingOf = (
  id: string,
  step: string,
  variant: string | null,
  aoiId: string | null,
  evidence: string,
  sessionIds: readonly string[],
): Finding => ({
  id,
  rank: Number(id.slice(2)),
  severity: 'high',
  claim: `Something happens on ${step}`,
  evidence,
  variant,
  step,
  aoiId,
  sessionIds: [...sessionIds],
  sessionCount: sessionIds.length,
  attribution: 'product',
  evidence_link: { screen: 'sessions', params: { step } },
});

/** Three findings: two a recommendation rests on, and one no claim is behind. */
const FINDINGS: readonly Finding[] = [
  findingOf('F-1', 'prompt', 'B', 'b-prompt-primary', '2 of the 5 people got no further', [
    'S-03',
    'S-04',
  ]),
  findingOf('F-2', 'generate', 'A', null, 'one person waited 41 s and gave up', ['S-02']),
  findingOf('F-3', 'preview', 'A', null, 'nobody scrolled past the first screenful', ['S-01']),
];

/** One recommendation as the builder stores it, before the schema stamps the rank. */
interface Stored {
  readonly id: string;
  readonly sentence: string;
  readonly evidence: string;
  readonly findingIds: readonly string[];
  readonly citations: readonly Citation[];
  readonly peopleAffected: number;
  readonly step: string;
}

const PROMPT: Stored = {
  id: 'R-prompt',
  sentence: 'Say what the prompt box needs before people start typing',
  evidence: 'The prompt step is where this run loses people first',
  findingIds: ['F-1'],
  citations: [
    { kind: 'heatmap', variant: 'B', step: 'prompt', aoiId: 'b-prompt-primary' },
    { kind: 'session', sessionId: 'S-04', offsetMs: 0 },
    { kind: 'funnel', stepId: 'prompt' },
  ],
  // The `reached` of the prompt row of the whole-run funnel, which is where the ranking
  // reads it from: a number this test does not get to choose.
  peopleAffected: 5,
  step: 'prompt',
};

const GENERATE: Stored = {
  id: 'R-generate',
  sentence: 'Show how long the video will take before anybody presses Generate',
  evidence: 'The wait on the generate step is the second thing that loses people',
  findingIds: ['F-2'],
  citations: [
    { kind: 'session', sessionId: 'S-02', offsetMs: 0 },
    { kind: 'funnel', stepId: 'generate' },
  ],
  peopleAffected: 4,
  step: 'generate',
};

/** The stored document, through the contract's own schema: ranks dense, citations non-empty. */
const documentOf = (...stored: readonly Stored[]): Recommendations =>
  recommendationsSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    runId: RUN.runId,
    sample: SAMPLE,
    recommendations: stored.map((recommendation, index) => ({
      ...recommendation,
      rank: index + 1,
    })),
  });

const recommendationsOf = (...stored: readonly Stored[]): Recommendation[] => [
  ...documentOf(...stored).recommendations,
];

const generate = (
  recommendations: readonly Recommendation[],
  options: {
    readonly aggregate?: typeof AGGREGATE;
    readonly findings?: readonly Finding[];
    readonly report?: (line: string) => void;
  } = {},
) =>
  writeUp({
    run: RUN,
    aggregate: options.aggregate ?? AGGREGATE,
    recommendations,
    findings: options.findings ?? FINDINGS,
    sample: SAMPLE,
    ...(options.report !== undefined && { report: options.report }),
  });

/** The whole write-up as one piece of prose, for the checks that are about the words. */
const prose = (claims: ReadonlyArray<{ heading: string; body: string }>): string =>
  claims.map((claim) => `${claim.heading} ${claim.body}`).join('\n');

describe('the claims it generates', () => {
  it('is the same write-up for the same recommendations, stated as values', () => {
    expect(generate(recommendationsOf(PROMPT, GENERATE))).toEqual([
      {
        heading: 'The prompt step is where this run loses people first.',
        body: [
          '5 of 5 simulated people — 100% of them — reached the prompt step.',
          '1 of them left it there.',
          'It is where this run lost the most people, and most of them left for one reason: the prompt was rejected.',
          '2 of the 5 people got no further.',
          'Say what the prompt box needs before people start typing.',
        ].join(' '),
        // The prototype's chip order on `#screen-analysis`: the funnel step, then the person
        // with the second of their recording, then the heatmap region.
        citations: [
          { kind: 'funnel', stepId: 'prompt' },
          { kind: 'session', sessionId: 'S-04', offsetMs: 0 },
          { kind: 'heatmap', variant: 'B', step: 'prompt', aoiId: 'b-prompt-primary' },
        ],
      },
      {
        heading: 'The wait on the generate step is the second thing that loses people.',
        body: [
          '4 of 5 simulated people — 80% of them — reached the generate step.',
          '1 of them left it there.',
          'One person waited 41 s and gave up.',
          'Show how long the video will take before anybody presses Generate.',
        ].join(' '),
        citations: [
          { kind: 'funnel', stepId: 'generate' },
          { kind: 'session', sessionId: 'S-02', offsetMs: 0 },
        ],
      },
      {
        heading: WHAT_I_DID_NOT_FIND,
        body: [
          'Nothing in what these people did pointed at a change on the landing step and the preview step, and this write-up claims none.',
          'One finding this run stated is behind no claim above: no recommendation rests on it.',
          'This write-up rests on the aggregate of all 6 simulated sessions, with 5 of them read whole.',
          'Automation failures — 1 of the 6 — are excluded from every number above, and no claim rests on one.',
          'These are 6 simulated people generated from the audience you described, People making a short video, and not your customers: nothing here says what real customers would do.',
        ].join(' '),
        citations: [
          { kind: 'funnel', stepId: 'landing' },
          { kind: 'funnel', stepId: 'preview' },
        ],
      },
    ]);
  });

  it('is one claim per recommendation in the stored rank, and the closing claim last', () => {
    const claims = generate(recommendationsOf(PROMPT, GENERATE));

    expect(claims).toHaveLength(3);
    expect(claims.map((claim) => claim.heading).slice(0, 2)).toEqual([
      'The prompt step is where this run loses people first.',
      'The wait on the generate step is the second thing that loses people.',
    ]);
    expect(claims.at(-1)?.heading).toBe(WHAT_I_DID_NOT_FIND);
  });

  it('never emits a claim with an empty citation list', () => {
    for (const claim of generate(recommendationsOf(PROMPT, GENERATE))) {
      expect(claim.citations.length).toBeGreaterThan(0);
    }
  });
});

describe('every citation resolves against the run', () => {
  it('passes the run-level citation validator, write-up and all', () => {
    const document = documentOf(PROMPT, GENERATE);
    const stored = recommendationsSchema.parse({
      ...document,
      writeUp: generate([...document.recommendations]),
    });

    expect(
      validateRecommendations({
        run: RUN,
        sessions: SESSIONS,
        findings: { schemaVersion: SCHEMA_VERSION, runId: RUN.runId, findings: [...FINDINGS] },
        aggregate: AGGREGATE,
        recommendations: stored,
      }),
    ).toEqual([]);
  });

  it('drops a claim whose every citation names something this run does not hold, and says which', () => {
    const lines: string[] = [];
    const dangling: Stored = {
      ...GENERATE,
      citations: [
        { kind: 'session', sessionId: 'S-99', offsetMs: 0 },
        { kind: 'funnel', stepId: 'checkout' },
      ],
    };

    const claims = generate(recommendationsOf(PROMPT, dangling), {
      report: (line) => lines.push(line),
    });

    expect(claims.map((claim) => claim.heading)).toEqual([
      'The prompt step is where this run loses people first.',
      WHAT_I_DID_NOT_FIND,
    ]);
    expect(lines).toEqual([
      'The claim "The wait on the generate step is the second thing that loses people." is not published: every citation recommendation R-generate carries names something this run does not hold, so the claim has nothing to cite.',
    ]);
  });

  it('keeps the citations of a claim that resolve and drops only the ones that do not', () => {
    const half: Stored = {
      ...PROMPT,
      citations: [
        { kind: 'heatmap', variant: 'C', step: 'prompt', aoiId: null },
        { kind: 'session', sessionId: 'S-04', offsetMs: 0 },
        { kind: 'funnel', stepId: 'prompt' },
      ],
    };

    expect(generate(recommendationsOf(half))[0]?.citations).toEqual([
      { kind: 'funnel', stepId: 'prompt' },
      { kind: 'session', sessionId: 'S-04', offsetMs: 0 },
    ]);
  });
});

describe('the closing claim', () => {
  it('is present whenever there is a write-up, and names what was looked for and not seen', () => {
    const closing = generate(recommendationsOf(PROMPT, GENERATE)).at(-1);

    expect(closing?.heading).toBe(WHAT_I_DID_NOT_FIND);
    // The steps the run walked that no claim above is about: looked at, nothing found.
    expect(closing?.body).toContain('the landing step and the preview step');
    expect(closing?.body).toContain('behind no claim above');
    expect(closing?.citations).toEqual([
      { kind: 'funnel', stepId: 'landing' },
      { kind: 'funnel', stepId: 'preview' },
    ]);
  });

  it('says the people are simulated and generated from the audience the user described', () => {
    const closing = generate(recommendationsOf(PROMPT, GENERATE)).at(-1);

    expect(closing?.body).toContain(
      'These are 6 simulated people generated from the audience you described, People making a short video, and not your customers',
    );
  });

  it('says so when every step has a change recommended on it', () => {
    const everyStep = (['landing', 'prompt', 'generate', 'preview'] as const).map(
      (step, index): Stored => ({
        ...PROMPT,
        id: `R-${step}`,
        step,
        evidence: `Something to change on ${step}`,
        peopleAffected: [5, 5, 4, 3][index] ?? 0,
        citations: [{ kind: 'funnel', stepId: step }],
      }),
    );

    expect(generate(recommendationsOf(...everyStep)).at(-1)?.body).toContain(
      'Every step of this run has a change recommended on it, so there is no step this write-up passed over in silence.',
    );
  });

  it('states the automation-failure line with its count, and leaves it out when there is none', () => {
    const line =
      'Automation failures — 1 of the 6 — are excluded from every number above, and no claim rests on one.';

    expect(generate(recommendationsOf(PROMPT, GENERATE)).at(-1)?.body).toContain(line);

    const clean = generate(recommendationsOf(PROMPT, GENERATE), { aggregate: NO_FAILURES });
    expect(clean.at(-1)?.body).not.toContain('Automation failures');
    expect(clean.at(-1)?.body).not.toContain('excluded from every number above');
  });
});

/**
 * The two promises about the words, both read off the **text** rather than off the figures
 * that went into it: the promise is about what a reader sees, and a reader cannot see an
 * intention.
 */
describe('the words it uses', () => {
  /**
   * What a measurement looks like in the finished prose — the same five shapes
   * `@personavision/improve` holds its pull request comment to, which are the shapes
   * `wording.ts` emits: a percentage, a *33 of 54*, a count of people, a duration, a number
   * of times.
   */
  const MEASUREMENT =
    /\d[\d,.]*\s*%|\b\d+\s+(?:of|in)\s+(?:the\s+)?\d+\b|\b\d+\s+people\b|\b\d[\d,.]*\s*m?s\b|\b\d+\s+times\b/;
  const LABELLED = /simulated/i;

  it('labels every claim that carries a figure simulated', () => {
    const claims = generate(recommendationsOf(PROMPT, GENERATE));

    // Not a vacuous pass: each of these claims does carry figures.
    for (const claim of claims) {
      const text = `${claim.heading} ${claim.body}`;
      expect(text).toMatch(MEASUREMENT);
      expect(text).toMatch(LABELLED);
    }
  });

  it('reads as no conversion-lift claim anywhere in it', () => {
    // The vocabulary the screens are held to (`apps/viewer/tests/replay/video.test.tsx`), run
    // over the generated prose. The no-conversion-lift line itself is the screen's footnote
    // and is deliberately not a sentence in here.
    expect(prose(generate(recommendationsOf(PROMPT, GENERATE)))).not.toMatch(
      /conversion lift|conversion-lift|uplift|revenue|conversion rate/i,
    );
  });
});

describe('the runs that generate no write-up', () => {
  /**
   * A run with no recommendation has no claim of its own — and the Analysis screen draws that
   * state as the stored nothing-to-recommend reason *beside* the *"What I did not find"* claim
   * (`#screen-analysis`), so the write-up of such a run is that one claim and nothing else.
   * The reason itself is the stored sentence `build.ts` writes and is not generated here.
   */
  it('generates the closing claim alone for a run with no recommendations, and says why', () => {
    const lines: string[] = [];

    const claims = generate([], { report: (line) => lines.push(line) });

    expect(claims.map((claim) => claim.heading)).toEqual([WHAT_I_DID_NOT_FIND]);
    expect(claims[0]?.body).toContain(
      'Nothing in what these people did pointed at a change on the landing step, the prompt step, the generate step and the preview step, and this write-up claims none.',
    );
    expect(claims[0]?.body).toContain('3 findings this run stated are behind no claim above');
    expect(claims[0]?.citations).toEqual([
      { kind: 'funnel', stepId: 'landing' },
      { kind: 'funnel', stepId: 'prompt' },
      { kind: 'funnel', stepId: 'generate' },
      { kind: 'funnel', stepId: 'preview' },
    ]);
    expect(lines).toEqual([
      'No claim of its own: this run published no recommendation, so its write-up is the closing claim alone and the stored nothing-to-recommend reason stands in place of the claims.',
    ]);
  });

  it('generates none while the run is still open, rather than half of one', () => {
    const lines: string[] = [];
    const open = { ...AGGREGATE, runStatus: 'open' as const };

    expect(
      generate(recommendationsOf(PROMPT, GENERATE), {
        aggregate: open,
        report: (line) => lines.push(line),
      }),
    ).toEqual([]);
    expect(lines).toEqual([
      "No write-up: this run is open, and the figures a claim would argue from are the ones so far rather than the run's.",
    ]);
  });
});
