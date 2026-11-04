import { recommendationsSchema, SCHEMA_VERSION } from '@personavision/contract';
import type {
  Aggregate,
  Citation,
  Recommendation,
  Recommendations,
  Run,
  SampleProvenance,
  Session,
} from '@personavision/contract';
import { scoredSessions } from '../aggregate/index.js';
import type { Finding } from '../findings/index.js';
import { rankRecommendations, wholeRunFunnel, type UnrankedRecommendation } from './rank.js';
import type { SessionSample } from './sample.js';

/**
 * The recommendations builder: the **caller** of Muse Wonder, not the writer of its words.
 *
 * It assembles what Wonder reads — the aggregate of every session, plus the twenty whole
 * sessions `sampleSessions` draws — calls the one-shot seam, checks the reply is the shape
 * the contract declares, attaches the findings each recommendation rests on and the citations
 * behind them, ranks them and stores the rank. The prompt and the sentences belong to the
 * Muse Wonder step (#219, by the handoff on #224); nothing in this package writes either, and
 * the model call is passed in rather than made here.
 *
 * Four things are this caller's own, and each is here because the seam cannot do it:
 *
 * 1. **The two ranking keys are read off the aggregate**, in `rank.ts`: `peopleAffected` is
 *    the `reached` of the step in the whole-run funnel slice and is never a number a model
 *    reported or this package counted on the side, so the ranking key and the funnel the
 *    reader is looking at cannot disagree.
 * 2. **No recommendation rests only on our own breakage.** Wonder is handed the sample, which
 *    the sampler has already cleared of automation failures — so the ask never *sees* an
 *    excluded session and is in no position to notice one being cited. This builder holds
 *    every session of the run, so it is where the check belongs: a citation naming a session
 *    the run is not about is dropped, and a recommendation left resting on nothing the
 *    product did is dropped whole (`docs/FLOW.md` section 11).
 * 3. **The citation kinds a recommendation can honestly make are attached from its findings**
 *    — the heatmap region a finding names and the funnel step the recommendation sits on are
 *    facts about the run, not sentences for a model to compose, and the screen wants all
 *    three kinds of chip.
 * 4. **A dropped recommendation is reported in words.** Section 14's rule is that a claim
 *    with nothing to cite is not published; a claim that disappears without a line saying so
 *    is the other failure, so every drop goes to `report` with its reason.
 */

/** What Wonder is given for one analysis: the ask's own input, field for field (#219). */
export interface WonderAnalysisRequest {
  /** The run the analysis is about: its id, its steps, its people and its areas. */
  readonly run: Run;
  /** The findings a recommendation names in `findingIds`. */
  readonly findings: readonly Finding[];
  /** The whole sessions it reads — the sample, never the whole run and never a failure. */
  readonly sessions: readonly Session[];
  /** The run's own seed, so the same run gives the same answer offline. */
  readonly seed: number;
  /** What the Analysis screen prints as *"Read 20 of 93 sessions"*. */
  readonly sample: SampleProvenance;
}

/**
 * The Muse Wonder seam, as this builder needs it: one analysis ask in, the document out.
 *
 * It is a **function and not the provider's interface**, because `@personavision/scoring`
 * depends on the artifact contract and on nothing else — the model call is handed in, exactly
 * as a decision policy is handed to the engine. A caller wires the real one up with
 * `(request) => writeAnalysis(provider, request).then((reply) => reply.value)`; the offline
 * deterministic implementation of #219 is the project's default, so a test makes no network
 * call and needs no key.
 *
 * **It refuses by throwing**, with the paths it was wrong at — `WonderReplyError` does, and so
 * does any `zod` refusal. This builder does not catch it: a malformed reply is reported to the
 * caller and never turned into an empty recommendation list (`docs/FLOW.md` section 16).
 */
export type WonderAnalysis = (request: WonderAnalysisRequest) => Promise<Recommendations>;

/** What the builder is given. */
export interface RecommendationsInput {
  /** The run the recommendations are about: its id, its steps and its personas. */
  readonly run: Run;
  /**
   * Every session the run produced, automation failures among them. They are **not** what
   * Wonder reads — the sample is — but they are what makes the exclusion check above
   * possible, so they are the whole run and not the twenty.
   */
  readonly sessions: readonly Session[];
  /** The findings a recommendation names in `findingIds`: what happened, to its what-to-do. */
  readonly findings: readonly Finding[];
  /** What the sample was drawn with — the run's own seed, so the same run reads the same twenty. */
  readonly seed: number;
  /** Every figure of the run, computed once: where the two ranking keys are read from. */
  readonly aggregate: Aggregate;
  /** The whole sessions Wonder reads and the provenance of the draw, from `sampleSessions`. */
  readonly sample: SessionSample;
  /** The model call, handed in. */
  readonly wonder: WonderAnalysis;
  /**
   * Where a dropped recommendation is reported, one line each. Absent swallows them, which
   * is for a caller that has nowhere to put a line and never the default of a pipeline.
   */
  readonly report?: (line: string) => void;
}

/** The signature #258 implements. Asynchronous: the body of it is one model call. */
export type RecommendationsBuilder = (input: RecommendationsInput) => Promise<Recommendations>;

/** The chip order of `#screen-results`: the sessions first, then the region, then the step. */
const CITATION_ORDER: Readonly<Record<Citation['kind'], number>> = {
  session: 0,
  heatmap: 1,
  funnel: 2,
};

/**
 * Where in a session's recording a finding about one step is: the frame that step begins on,
 * and the start of the recording where the recording does not reach it.
 *
 * It is the offset `sessionVideoSchema` stores positionally for that screen, so a chip reading
 * *S-62 · 1:08* opens on the frame it means. A session with no recording, or one truncated
 * before the step, has no such frame and is cited at 0 rather than at a frame showing
 * something else.
 */
const offsetOf = (session: Session, step: string): number => {
  const { video } = session;
  if (video === undefined || video.state !== 'recorded') return 0;
  const index = session.screens.findIndex((screen) => screen.step === step);
  if (index < 0) return 0;
  return video.screenOffsetsMs[index] ?? 0;
};

/** The same citation twice is one chip: a citation as a key, so a kind is never attached twice. */
const keyOf = (citation: Citation): string =>
  citation.kind === 'session'
    ? `session\u0000${citation.sessionId}\u0000${citation.offsetMs}`
    : citation.kind === 'heatmap'
      ? `heatmap\u0000${citation.variant}\u0000${citation.step}\u0000${citation.aoiId ?? ''}`
      : `funnel\u0000${citation.stepId}`;

/** What one recommendation of the reply is held to, and what it is completed from. */
interface Publishing {
  /** The sessions the run is about: scored, so never an automation failure and never unknown. */
  readonly scored: ReadonlyMap<string, Session>;
  readonly findingById: ReadonlyMap<string, Finding>;
  readonly report: (line: string) => void;
}

/**
 * One recommendation, cleared of what it may not rest on and completed with what it can
 * honestly cite — or `null` where there is nothing left to publish, with the reason reported.
 *
 * **Dropped, not refused.** A reply whose claims are the wrong shape is a refusal and the seam
 * has already made it; a claim that rests on our own breakage is readable, wrong to publish,
 * and no reason to throw away the claims beside it that rest on the product.
 */
const publishable = (
  recommendation: Recommendations['recommendations'][number],
  { scored, findingById, report }: Publishing,
): UnrankedRecommendation | null => {
  const named = `"${recommendation.id}"`;

  // A finding this run never stated is the seam's refusal and cannot reach here; a finding it
  // stated about our own harness can, and advice about our harness is not advice about the
  // site.
  const supporting = recommendation.findingIds
    .map((findingId) => findingById.get(findingId))
    .filter((finding): finding is Finding => finding !== undefined);
  const product = supporting.filter((finding) => finding.attribution === 'product');
  if (product.length === 0) {
    report(
      `${named} is not published: it rests on ${supporting.length === 0 ? 'no finding this run stated' : 'nothing the product did — every finding it names is our own automation failing'}.`,
    );
    return null;
  }

  const cited = recommendation.citations.filter((citation) => {
    if (citation.kind !== 'session' || scored.has(citation.sessionId)) return true;
    report(
      `${named} cites session ${citation.sessionId}, which is not among the sessions this run is about: the citation is dropped.`,
    );
    return false;
  });
  if (cited.length === 0) {
    report(`${named} is not published: it cites no evidence this run is about.`);
    return null;
  }

  // One citation of each kind this recommendation can honestly make, so the screen's three
  // chips are all there: the region a supporting finding names, and the step it sits on. A
  // kind the reply already carries is left exactly as it came back.
  const attached = [...cited];
  const carried = new Set(cited.map((citation) => citation.kind));
  const seen = new Set(cited.map(keyOf));
  const attach = (citation: Citation): void => {
    if (seen.has(keyOf(citation))) return;
    seen.add(keyOf(citation));
    attached.push(citation);
  };

  if (!carried.has('session')) {
    for (const finding of product) {
      const sessionId = finding.sessionIds.find((candidate) => scored.has(candidate));
      const session = sessionId === undefined ? undefined : scored.get(sessionId);
      if (session !== undefined) {
        attach({
          kind: 'session',
          sessionId: session.sessionId,
          offsetMs: offsetOf(session, finding.step),
        });
        break;
      }
    }
  }
  if (!carried.has('heatmap')) {
    // `variant: null` is a finding about the run itself rather than about one version, and a
    // heatmap is addressed per version: there is no region to point at, so none is invented.
    const regional = product.find((finding) => finding.variant !== null);
    const variant = regional?.variant;
    if (regional !== undefined && variant !== null && variant !== undefined) {
      attach({ kind: 'heatmap', variant, step: regional.step, aoiId: regional.aoiId });
    }
  }
  if (!carried.has('funnel')) attach({ kind: 'funnel', stepId: recommendation.step });

  return {
    id: recommendation.id,
    sentence: recommendation.sentence,
    evidence: recommendation.evidence,
    findingIds: [...recommendation.findingIds],
    citations: attached.sort(
      (left, right) => CITATION_ORDER[left.kind] - CITATION_ORDER[right.kind],
    ),
    step: recommendation.step,
  };
};

/**
 * Why a run recommends nothing, in the one stored sentence `recommendationsSchema` asks for —
 * the Summary states it in words rather than showing an empty section (the decision on #224).
 *
 * The reply's own reason is preferred where it has one, because Wonder writing nothing and
 * this builder publishing nothing are two different facts about the run and the first is the
 * better sentence. Where every claim was dropped here, the reason is written here: the reply
 * had no way to know.
 */
const nothingToRecommend = (document: Recommendations): string => {
  const written = document.recommendations.length;
  if (written === 0) {
    return (
      document.nothingToRecommend ?? 'Muse Wonder read this run and wrote no recommendation for it.'
    );
  }
  return `Muse Wonder wrote ${written} recommendation${written === 1 ? '' : 's'} for this run and none of them is published, because a claim resting only on our own automation failures, or citing nothing this run is about, is advice with nothing behind it.`;
};

/**
 * The recommendations of one run: ranked, stored in that order, and the contract's own shape.
 *
 * `writeUp` is deliberately absent. It is generated from these recommendations rather than
 * written beside them, and that generation is `writeUp.ts`'s (#260).
 */
export const buildRecommendations: RecommendationsBuilder = async (input) => {
  const document = await input.wonder({
    run: input.run,
    findings: input.findings,
    sessions: input.sample.sessions,
    seed: input.seed,
    sample: input.sample.sample,
  });

  const publishing: Publishing = {
    scored: new Map(
      scoredSessions(input.sessions).sessions.map(
        (session) => [session.sessionId, session] as const,
      ),
    ),
    findingById: new Map(input.findings.map((finding) => [finding.id, finding] as const)),
    report: input.report ?? (() => {}),
  };

  const written = document.recommendations
    .map((recommendation) => publishable(recommendation, publishing))
    .filter((recommendation): recommendation is UnrankedRecommendation => recommendation !== null);

  const recommendations: Recommendation[] = rankRecommendations(
    written,
    wholeRunFunnel(input.aggregate, input.run),
  );

  // Back through the contract's own schema: the one-sentence rule, at least one citation, at
  // least one finding, and a dense unique rank are enforced on the way out, so a document this
  // builder hands back is one the reader and the screens accept.
  return recommendationsSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    runId: input.run.runId,
    // The run's own facts are stamped, never read off the reply: a reply is in no position to
    // say which run it is about or how much of it was read.
    sample: input.sample.sample,
    recommendations,
    ...(recommendations.length === 0 && {
      nothingToRecommend: nothingToRecommend(document),
    }),
  });
};
