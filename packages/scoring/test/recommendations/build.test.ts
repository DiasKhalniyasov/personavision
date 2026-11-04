import {
  createSeededRandom,
  recommendationsSchema,
  runPaths,
  SCHEMA_VERSION,
  sessionSchema,
  type Citation,
  type Recommendations,
  type Session,
} from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import {
  aggregateComputedAt,
  buildRecommendations,
  composeAggregate,
  WHOLE_RUN_STRATEGY,
  type Finding,
  type SessionSample,
} from '../../src/index.js';
import type { WonderAnalysis } from '../../src/recommendations/build.js';
import { smallRun, smallRunSessions } from '../fixtures/aggregate.js';

/**
 * The recommendations builder: the caller of Muse Wonder.
 *
 * **What is under test, and what is handed in.** The sentences, the prompt and the offline
 * deterministic answer are #219's, in `@personavision/provider`; this package depends on the
 * artifact contract and on nothing else, so the seam is handed in here as the function
 * `RecommendationsInput` takes — exactly as a real caller hands it
 * `(request) => writeAnalysis(provider, request).then((reply) => reply.value)`. The replies
 * below are built **through `recommendationsSchema`**, so none of them is a straw man: each is
 * a document the real seam could have returned, and what these tests assert is what this
 * builder does to one.
 *
 * The run is the aggregate step's small run — six people, four steps, two versions, one of
 * them our own harness failing — because its funnel can be counted by hand, and because its
 * first two steps are reached by the **same five people**, which is the one shape that makes
 * the second ranking key observable at all.
 */

/** The whole-run funnel of the five scored sessions, counted off the fixture by hand. */
const REACHED: Readonly<Record<string, number>> = {
  // S-01, S-02, S-03, S-04, S-06 — everybody who was not our own harness failing.
  landing: 5,
  // The same five: nobody is lost between the first two steps, so depth is the only key left.
  prompt: 5,
  // S-03 failed on the prompt step.
  generate: 4,
  // S-02 gave up on the generate step.
  preview: 3,
};

/** The same session with a recording, so a session citation has a frame to name. */
const withVideo = (session: Session): Session =>
  sessionSchema.parse({
    ...session,
    video: {
      state: 'recorded',
      path: runPaths('').video(session.sessionId),
      durationMs: session.durationMs,
      truncated: null,
      // One second per screen, so the frame a citation opens on is readable in an assertion.
      screenOffsetsMs: session.screens.map((_screen, index) => index * 1000),
      actionOffsetsMs: session.actions.map((action) => action.tMs),
    },
  });

const RUN = smallRun;
const SESSIONS: readonly Session[] = smallRunSessions.map(withVideo);
const AGGREGATE = composeAggregate({
  run: RUN,
  sessions: SESSIONS,
  computedAt: aggregateComputedAt(RUN),
});

const SEED = 7;

/** Every scored session, read whole: a five-session run is smaller than the sample. */
const SAMPLE: SessionSample = {
  sessions: SESSIONS.filter((session) => !session.outcome.excludedFromScores),
  sample: { read: 5, of: 5, strategy: WHOLE_RUN_STRATEGY, seed: SEED },
};

const findingOf = (
  id: string,
  step: string,
  variant: string | null,
  aoiId: string | null,
  sessionIds: readonly string[],
  attribution: Finding['attribution'] = 'product',
): Finding => ({
  id,
  rank: Number(id.slice(2)),
  severity: 'high',
  claim: `Something happens on ${step}`,
  evidence: `${sessionIds.length} of the 5 people, on ${step}`,
  variant,
  step,
  aoiId,
  sessionIds: [...sessionIds],
  sessionCount: sessionIds.length,
  attribution,
  evidence_link: { screen: 'sessions', params: { step } },
});

/**
 * Five findings: one per step the recommendations below sit on, one about the run itself
 * rather than about a version — which can cite no heatmap region, because a region is
 * addressed per version — and one that is **our own harness failing**.
 */
const FINDINGS: readonly Finding[] = [
  findingOf('F-1', 'landing', 'A', 'a-landing-primary', ['S-01', 'S-02']),
  findingOf('F-2', 'prompt', 'B', 'b-prompt-primary', ['S-04', 'S-06']),
  findingOf('F-3', 'generate', null, null, ['S-01', 'S-02', 'S-04', 'S-06']),
  findingOf('F-4', 'preview', 'A', null, ['S-01']),
  findingOf('F-5', 'prompt', 'B', null, ['S-05'], 'automation'),
];

/** One recommendation as a reply carries it: everything but the rank, which is stored here. */
interface Written {
  readonly id: string;
  readonly sentence: string;
  readonly evidence: string;
  readonly findingIds: readonly string[];
  readonly citations: readonly Citation[];
  readonly step: string;
  /** What the reply claims; this builder reads the funnel instead. Defaults to a wrong one. */
  readonly peopleAffected?: number;
}

const sessionCitation = (sessionId: string, offsetMs: number): Citation => ({
  kind: 'session',
  sessionId,
  offsetMs,
});

/** A Muse Wonder stand-in answering exactly this, as a document the contract accepts. */
const wonderReturning =
  (...written: readonly Written[]): WonderAnalysis =>
  (request) => {
    const recommendations = written.map((one, index) => ({
      ...one,
      rank: index + 1,
      // A figure the reply reports and this builder never reads: it comes off the funnel.
      peopleAffected: one.peopleAffected ?? 999,
    }));
    return Promise.resolve(
      recommendationsSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        runId: request.run.runId,
        sample: request.sample,
        recommendations,
        ...(recommendations.length === 0 && {
          nothingToRecommend: 'Muse Wonder found nothing in this run worth changing.',
        }),
      }),
    );
  };

/**
 * Four recommendations, one per step, written so that **both ranking keys matter**:
 *
 * - `LANDING` and `PROMPT` are a change for the same five people, so only how far through the
 *   funnel they sit separates them — and `R-2` is the later step, so it comes first although
 *   its id sorts second and the reply listed it second. Neither the reply's order nor the id
 *   can produce that order, which is what makes it an assertion about the funnel.
 * - `GENERATE` reaches four people and `PREVIEW` three, so the first key puts `R-3` above
 *   `R-4` although `R-4` sits deeper. Depth is the tiebreak, never the lead.
 */
const LANDING: Written = {
  id: 'R-1',
  sentence: 'Say what the landing page is for above the fold.',
  evidence: '5 of the 5 people reached it and 2 of them looked no further (simulated).',
  findingIds: ['F-1'],
  citations: [sessionCitation('S-01', 0)],
  step: 'landing',
};

const PROMPT: Written = {
  id: 'R-2',
  sentence: 'Name the prompt box so it reads as somewhere to type.',
  evidence: '5 of the 5 people reached the prompt and 1 of them never wrote one (simulated).',
  findingIds: ['F-2'],
  citations: [sessionCitation('S-04', 2000)],
  step: 'prompt',
};

const GENERATE: Written = {
  id: 'R-3',
  sentence: 'Tell people how long the render will take before they press Generate.',
  evidence: '4 of the 5 people reached the render and 1 gave up there (simulated).',
  findingIds: ['F-3'],
  citations: [sessionCitation('S-02', 1500)],
  step: 'generate',
};

const PREVIEW: Written = {
  id: 'R-4',
  sentence: 'Put the download control where the preview is.',
  evidence: '3 of the 5 people reached the preview (simulated).',
  findingIds: ['F-4'],
  citations: [sessionCitation('S-01', 3000)],
  step: 'preview',
};

const FOUR: readonly Written[] = [LANDING, PROMPT, GENERATE, PREVIEW];

const build = (wonder: WonderAnalysis, report?: (line: string) => void): Promise<Recommendations> =>
  buildRecommendations({
    run: RUN,
    sessions: SESSIONS,
    findings: FINDINGS,
    seed: SEED,
    aggregate: AGGREGATE,
    sample: SAMPLE,
    wonder,
    ...(report !== undefined && { report }),
  });

/** The lines a run reported, and what it produced. */
const buildReporting = async (
  wonder: WonderAnalysis,
): Promise<{ document: Recommendations; reported: string[] }> => {
  const reported: string[] = [];
  const document = await build(wonder, (line) => reported.push(line));
  return { document, reported };
};

describe('buildRecommendations', () => {
  it('ranks by who a change would reach, then by how far through the funnel it sits', async () => {
    const { recommendations } = await build(wonderReturning(...FOUR));

    expect(recommendations.map((one) => [one.rank, one.id, one.step, one.peopleAffected])).toEqual([
      // The two that reach five people, the later step first.
      [1, 'R-2', 'prompt', 5],
      [2, 'R-1', 'landing', 5],
      // Then by people, which outranks depth: four before three.
      [3, 'R-3', 'generate', 4],
      [4, 'R-4', 'preview', 3],
    ]);
  });

  it('breaks a tie on neither the reply order nor the position in the list', async () => {
    // The same four, listed by the reply in the other order: the stored order does not move.
    const { recommendations } = await build(wonderReturning(...[...FOUR].reverse()));

    expect(recommendations.map((one) => one.id)).toEqual(['R-2', 'R-1', 'R-3', 'R-4']);
  });

  it('reads peopleAffected off the aggregate funnel rather than off the reply', async () => {
    const { recommendations } = await build(wonderReturning(...FOUR));
    const funnel = AGGREGATE.funnelSlices.find(
      (slice) => slice.variant === null && slice.segment === null,
    );

    expect(recommendations.map((one) => one.peopleAffected)).not.toContain(999);
    // The figure the Funnel screen draws its bar from, for the step each one sits on.
    for (const one of recommendations) {
      expect(one.peopleAffected).toBe(funnel?.funnel.find((row) => row.step === one.step)?.reached);
      expect(one.peopleAffected).toBe(REACHED[one.step]);
    }
  });

  it('attaches the heatmap region and the funnel step, in the order the screen prints them', async () => {
    const { recommendations } = await build(wonderReturning(PROMPT));

    // The sessions first, then the region, then the step: the chip order of `#screen-results`.
    expect(recommendations[0]?.citations).toEqual([
      { kind: 'session', sessionId: 'S-04', offsetMs: 2000 },
      { kind: 'heatmap', variant: 'B', step: 'prompt', aoiId: 'b-prompt-primary' },
      { kind: 'funnel', stepId: 'prompt' },
    ]);
  });

  it('cites no heatmap region for a finding about the run rather than about one version', async () => {
    // `F-3` carries `variant: null`, and a heatmap is addressed per version: there is no
    // region to point at, so none is invented — the other two kinds are still there.
    const { recommendations } = await build(wonderReturning(GENERATE));

    expect(recommendations[0]?.citations.map((citation) => citation.kind)).toEqual([
      'session',
      'funnel',
    ]);
  });

  it('attaches a session citation on the frame the finding is about', async () => {
    const { recommendations } = await build(
      // A reply that named the step and nobody.
      wonderReturning({ ...PROMPT, citations: [{ kind: 'funnel', stepId: 'prompt' }] }),
    );

    // `F-2` is about the prompt step, and the prompt step is the second screen of S-04: one
    // second into the recording, by the offsets the fixture records.
    expect(recommendations[0]?.citations[0]).toEqual({
      kind: 'session',
      sessionId: 'S-04',
      offsetMs: 1000,
    });
  });

  it('names at least one finding and carries at least one citation on every one it publishes', async () => {
    const { recommendations } = await build(wonderReturning(...FOUR));

    for (const one of recommendations) {
      expect(one.findingIds.length).toBeGreaterThanOrEqual(1);
      expect(one.citations.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('drops a recommendation whose only evidence is an excluded session, and says why', async () => {
    // S-05 is the automation failure. A reply citing it is readable and wrong to publish:
    // our own breakage is never the evidence for advice about the site.
    const { document, reported } = await buildReporting(
      wonderReturning(
        { ...LANDING, id: 'R-9', citations: [sessionCitation('S-05', 500)] },
        GENERATE,
      ),
    );

    expect(document.recommendations.map((one) => one.id)).toEqual(['R-3']);
    expect(reported).toEqual([
      '"R-9" cites session S-05, which is not among the sessions this run is about: the citation is dropped.',
      '"R-9" is not published: it cites no evidence this run is about.',
    ]);
  });

  it('publishes no recommendation that rests only on an automation failure', async () => {
    const { document, reported } = await buildReporting(
      // `F-5` is the automation finding: advice about our harness is not advice about the
      // site, whatever it cites.
      wonderReturning({ ...PROMPT, id: 'R-8', findingIds: ['F-5'] }, GENERATE),
    );

    expect(document.recommendations.map((one) => one.findingIds)).toEqual([['F-3']]);
    expect(reported).toEqual([
      '"R-8" is not published: it rests on nothing the product did — every finding it names is our own automation failing.',
    ]);
  });

  /**
   * The names a published recommendation may use.
   *
   * `io.ts` holds a recommendation's `findingIds`, a heatmap citation's version, step and area
   * and a funnel citation's step to the run's own declarations exactly as strictly as it holds
   * a session id, and one dangling reference stops the **whole run artifact** from being
   * written. The seam is a function a caller hands in, so none of these is unreachable: each
   * costs a chip, or the one claim, and never the run.
   */
  describe('drops what the run does not declare rather than making the run unwritable', () => {
    it('drops a finding id the run never stated, and keeps the ones it did', async () => {
      const { document, reported } = await buildReporting(
        wonderReturning({ ...PROMPT, findingIds: ['F-2', 'F-404'] }),
      );

      expect(document.recommendations[0]?.findingIds).toEqual(['F-2']);
      expect(reported).toEqual([
        '"R-2" rests on finding F-404, which this run never stated: the reference is dropped.',
      ]);
    });

    it('drops a heatmap citation naming a version, a step or an area the run has not', async () => {
      const { document, reported } = await buildReporting(
        wonderReturning({
          ...PROMPT,
          citations: [
            sessionCitation('S-04', 0),
            { kind: 'heatmap', variant: 'Z', step: 'prompt', aoiId: null },
            { kind: 'heatmap', variant: 'B', step: 'checkout', aoiId: null },
            { kind: 'heatmap', variant: 'B', step: 'prompt', aoiId: 'b-prompt-nothing' },
          ],
        }),
      );

      // The three bad ones are gone, and the region the finding itself names is attached.
      expect(document.recommendations[0]?.citations).toEqual([
        { kind: 'session', sessionId: 'S-04', offsetMs: 0 },
        { kind: 'heatmap', variant: 'B', step: 'prompt', aoiId: 'b-prompt-primary' },
        { kind: 'funnel', stepId: 'prompt' },
      ]);
      expect(reported).toEqual([
        '"R-2" cites the version "Z", which this run does not declare: the citation is dropped.',
        '"R-2" cites the step "checkout", which this run does not declare: the citation is dropped.',
        '"R-2" cites the area of interest "b-prompt-nothing", which this run does not declare: the citation is dropped.',
      ]);
    });

    it('drops a funnel citation naming a step the run has not', async () => {
      const { document, reported } = await buildReporting(
        wonderReturning({
          ...PROMPT,
          citations: [sessionCitation('S-04', 0), { kind: 'funnel', stepId: 'checkout' }],
        }),
      );

      expect(document.recommendations[0]?.citations.map((one) => one.kind)).toEqual([
        'session',
        'heatmap',
        'funnel',
      ]);
      expect(reported).toEqual([
        '"R-2" cites the step "checkout", which this run does not declare: the citation is dropped.',
      ]);
    });

    it('publishes no recommendation sitting on a step the run does not declare', async () => {
      // The step is the second ranking key and the one chip the screen always expects, so
      // there is nothing here to publish rather than a chip to drop.
      const { document, reported } = await buildReporting(
        wonderReturning({ ...PROMPT, step: 'checkout' }, GENERATE),
      );

      expect(document.recommendations.map((one) => one.id)).toEqual(['R-3']);
      expect(reported).toEqual([
        '"R-2" is not published: it sits on "checkout", which names no step this run declares.',
      ]);
    });

    it('publishes one recommendation per id', async () => {
      // `recommendationsSchema` does not hold ids apart, and the screens key their rows by id:
      // two of one name is one of them lost.
      const { document, reported } = await buildReporting(
        wonderReturning(PROMPT, { ...GENERATE, id: 'R-2' }),
      );

      expect(document.recommendations.map((one) => one.step)).toEqual(['prompt']);
      expect(reported).toEqual([
        '"R-2" is not published: a recommendation of this run already has that id.',
      ]);
    });
  });

  it('reports the reason a run recommends nothing rather than returning a bare empty list', async () => {
    const { document, reported } = await buildReporting(
      wonderReturning({ ...PROMPT, id: 'R-7', findingIds: ['F-5'] }),
    );

    expect(document.recommendations).toEqual([]);
    expect(document.nothingToRecommend).toBe(
      'Muse Wonder wrote 1 recommendation for this run and none of them is published, because a claim resting only on our own automation failures, or citing nothing this run is about, is advice with nothing behind it.',
    );
    expect(reported).toHaveLength(1);
  });

  it("keeps Wonder's own reason where Wonder wrote nothing at all", async () => {
    const document = await build(wonderReturning());

    expect(document.recommendations).toEqual([]);
    expect(document.nothingToRecommend).toBe(
      'Muse Wonder found nothing in this run worth changing.',
    );
  });

  it('reports a malformed reply in words naming the path, and never as an empty list', async () => {
    const refused: WonderAnalysis = () =>
      Promise.reject(
        new Error(
          'Muse Wonder answered the analysis with a reply the use refused: recommendations[0].sentence — expected string, received number',
        ),
      );

    await expect(build(refused)).rejects.toThrow(/recommendations\[0\]\.sentence/u);
  });

  it('hands the seam the run seed, so the same seed draws the same evidence', async () => {
    /** A stand-in that reads the seed, as the offline implementation of #219 does. */
    const drawing: WonderAnalysis = (request) => {
      const random = createSeededRandom(request.seed);
      const drawn = request.sessions[Math.floor(random() * request.sessions.length)];
      if (drawn === undefined) throw new Error('the seam was handed an empty sample');
      return wonderReturning({ ...GENERATE, citations: [sessionCitation(drawn.sessionId, 0)] })(
        request,
      );
    };

    const once = await build(drawing);
    const again = await build(drawing);

    expect(again).toEqual(once);
    // The session seed 7 draws, written down: "deterministic" asserted by running a function
    // twice only proves it was not random **this** time.
    expect(once.recommendations[0]?.citations[0]).toEqual({
      kind: 'session',
      sessionId: 'S-01',
      offsetMs: 0,
    });
  });

  it('gives the same recommendations, in the same order, with the same citations', async () => {
    const document = await build(wonderReturning(...FOUR));

    expect(document).toEqual({
      schemaVersion: SCHEMA_VERSION,
      runId: 'aggregate-fixture-run',
      sample: { read: 5, of: 5, strategy: WHOLE_RUN_STRATEGY, seed: SEED },
      recommendations: [
        {
          id: 'R-2',
          rank: 1,
          sentence: 'Name the prompt box so it reads as somewhere to type.',
          evidence:
            '5 of the 5 people reached the prompt and 1 of them never wrote one (simulated).',
          findingIds: ['F-2'],
          citations: [
            { kind: 'session', sessionId: 'S-04', offsetMs: 2000 },
            { kind: 'heatmap', variant: 'B', step: 'prompt', aoiId: 'b-prompt-primary' },
            { kind: 'funnel', stepId: 'prompt' },
          ],
          peopleAffected: 5,
          step: 'prompt',
        },
        {
          id: 'R-1',
          rank: 2,
          sentence: 'Say what the landing page is for above the fold.',
          evidence: '5 of the 5 people reached it and 2 of them looked no further (simulated).',
          findingIds: ['F-1'],
          citations: [
            { kind: 'session', sessionId: 'S-01', offsetMs: 0 },
            { kind: 'heatmap', variant: 'A', step: 'landing', aoiId: 'a-landing-primary' },
            { kind: 'funnel', stepId: 'landing' },
          ],
          peopleAffected: 5,
          step: 'landing',
        },
        {
          id: 'R-3',
          rank: 3,
          sentence: 'Tell people how long the render will take before they press Generate.',
          evidence: '4 of the 5 people reached the render and 1 gave up there (simulated).',
          findingIds: ['F-3'],
          citations: [
            { kind: 'session', sessionId: 'S-02', offsetMs: 1500 },
            { kind: 'funnel', stepId: 'generate' },
          ],
          peopleAffected: 4,
          step: 'generate',
        },
        {
          id: 'R-4',
          rank: 4,
          sentence: 'Put the download control where the preview is.',
          evidence: '3 of the 5 people reached the preview (simulated).',
          findingIds: ['F-4'],
          citations: [
            { kind: 'session', sessionId: 'S-01', offsetMs: 3000 },
            { kind: 'heatmap', variant: 'A', step: 'preview', aoiId: null },
            { kind: 'funnel', stepId: 'preview' },
          ],
          peopleAffected: 3,
          step: 'preview',
        },
      ],
    });
  });

  it('carries no write-up: it is generated from these recommendations and not beside them', async () => {
    const document = await build(wonderReturning(...FOUR));

    expect(document.writeUp).toBeUndefined();
  });
});
