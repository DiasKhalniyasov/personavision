import { createSeededRandom, recommendationsSchema, SCHEMA_VERSION } from '@personavision/contract';
import type {
  Citation,
  Findings,
  Recommendation,
  Recommendations,
  Run,
  SampleProvenance,
  Session,
} from '@personavision/contract';
import { z } from 'zod';
import type { WonderAsk, WonderEffort, WonderProvider, WonderReply } from './wonder.js';

/**
 * The third of the four things Muse Wonder answers: **what the model makes of a finished
 * run** (`docs/FLOW.md` section 14, the Analysis section and *"The recommendations"*; step
 * #219; #261).
 *
 * A run's scores, its findings and its sessions go in; **ranked recommendations, one plain
 * sentence each, every one carrying the evidence it rests on** come out, in
 * `recommendations.json`'s own shape. The Summary screen leads with them and the Analysis
 * screen renders the write-up generated from them; both *render* citations rather than
 * inventing them, which is why this use produces objects and never prose.
 *
 * Five things are load-bearing here, and all five are in this file rather than in a prompt,
 * because `docs/meta-model-api.md` is blunt that a schema-constrained reply is a guarantee
 * about JSON and not about truth — the live change call named a file that was in no request:
 *
 * 1. **A claim with no evidence is not published.** A recommendation that cites nothing is
 *    **dropped**, not refused: the reply is readable and the rest of it is worth publishing.
 *    What is emitted therefore always carries at least one citation, which is also what
 *    `recommendationsSchema` enforces on the way out.
 * 2. **No recommendation may rest on an excluded session** (`docs/FLOW.md` section 11). An
 *    automation failure is out of every figure, so a citation naming one is **refused** with
 *    the path — as is a citation naming a session, a variant, a step, an area of interest or
 *    a finding the run does not hold. Nothing cited is repaired: a link to nothing is worse
 *    than a refusal somebody can read.
 * 3. **A malformed reply is reported in words**, never turned into an empty recommendation
 *    list. The two are different answers and the contract spells them differently: a refusal
 *    is a `WonderReplyError` naming the path, and a run that genuinely produced no
 *    recommendation carries `nothingToRecommend` — one stored sentence the Summary states in
 *    words rather than showing an empty section.
 * 4. **The rank is ours, not the model's.** `rank` is not asked for. The two keys the
 *    ranking is stored from are on the shape — how many people a change would reach, and
 *    the funnel step it sits on — so the order is computed here from the data and stored
 *    dense and unique, rather than hoped for from a reply that could repeat a 1.
 * 5. **Deterministic and seeded**, like every other use: the same run and the same seed give
 *    the same recommendations in the same order, with no key and no network.
 *
 * **The aggregate is not here yet.** The funnel by step, the time-per-step distribution, the
 * click and scroll bins and the common paths are the aggregate's (step #223), and this use
 * neither waits for them nor invents a field for them: {@link analysisAsk}'s document gains
 * those sections when that lands, and the output shape does not change. Writing
 * `recommendations.json` into a run directory belongs to whoever runs the run; this use
 * returns the objects.
 */

/**
 * The reasoning effort this shape is worth, from the four calls timed in
 * `docs/meta-model-api.md` (2026-11-03): ranked recommendations with citations were answered
 * at `low` — 1,208 output tokens of which 903 were reasoning, $0.0255, 11.0s. `minimal` is
 * what the audience and the goal are worth; reading a whole run is not that shape.
 */
export const ANALYSIS_EFFORT: WonderEffort = 'low';

/** The name the model is told the reply shape is called. */
export const ANALYSIS_REPLY_SCHEMA_NAME = 'wonder_analysis';

/**
 * One finding, exactly as `findings.json` carries it. Taken off the contract's own document
 * rather than restated, so a finding field added there arrives here without an edit.
 */
export type AnalysisFinding = Findings['findings'][number];

/** Everything one analysis is written from. */
export interface AnalysisAskInput {
  /**
   * The run the recommendations are about: its id, its task and goal, its variants, its
   * steps, its areas of interest, and its scores. Every name a citation may use is declared
   * in here, and a citation naming anything else is refused.
   */
  readonly run: Run;
  /** The findings a recommendation names in `findingIds`: what happened, to its what-to-do. */
  readonly findings: readonly AnalysisFinding[];
  /**
   * The sessions the model reads whole — the sample, on a run too big to read entirely.
   * Automation failures may be in here: they are named to the model as sessions it may not
   * cite, and they are what the excluded-session rule is checked against.
   */
  readonly sessions: readonly Session[];
  /** The run's or the request's seed, which is what makes the offline answer repeatable. */
  readonly seed: number;
  /**
   * How much of the run was read, as the sampler that drew it recorded it — what the
   * Analysis screen prints as *"Read 20 of 93 sessions"*.
   *
   * Handed in rather than computed, because only the sampler knows how it drew: the
   * strategy is its own words and the seed is the one it drew with. Absent, it is derived
   * from what this ask carries, so the use works for a caller that did no sampling.
   */
  readonly sample?: SampleProvenance;
  /** Overrides {@link ANALYSIS_EFFORT}; a caller in a hurry can ask for less thinking. */
  readonly effort?: WonderEffort;
}

/** A refused reply, in the shape `parseWonderReply` reads issues out of. */
class AnalysisReplyRefused extends Error {
  readonly issues: readonly { readonly path: readonly unknown[]; readonly message: string }[];

  constructor(issues: readonly { readonly path: readonly unknown[]; readonly message: string }[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'AnalysisReplyRefused';
    this.issues = issues;
  }
}

/** The contract's own recommendation, field by field, and the citation union inside it. */
const recommendationFields = recommendationsSchema.shape.recommendations.element.shape;

/**
 * One recommendation as the model is asked for it: every field of the contract's own, except
 * the two this file stamps on.
 *
 * `rank` is **not** asked for. It is the stored order, and the order is a function of
 * `peopleAffected` and `step` — both of which are asked for — so a model reporting a rank
 * would be reporting a conclusion about a list it writes one entry of at a time. It is
 * computed in {@link ranked} and stored dense and unique.
 *
 * `citations` is asked for as an array with **no minimum**, where the contract's own carries
 * one. That is the drop rule rather than a relaxation: a recommendation with nothing to cite
 * is not published, and a schema that refused the reply over one would take the
 * recommendations that *did* cite their evidence down with it. What is emitted goes back
 * through `recommendationsSchema`, where the minimum is enforced on the way out.
 */
const replyRecommendationSchema = z.strictObject({
  id: recommendationFields.id,
  sentence: recommendationFields.sentence,
  evidence: recommendationFields.evidence,
  findingIds: recommendationFields.findingIds,
  citations: z.array(recommendationFields.citations.element),
  peopleAffected: recommendationFields.peopleAffected,
  step: recommendationFields.step,
});

/** The reply shape: the list, and nothing about the run the model is in no position to say. */
const analysisReplySchema = z.strictObject({
  recommendations: z.array(replyRecommendationSchema),
});

/** A recommendation before the ranking: everything but its position in the list. */
type Unranked = Omit<Recommendation, 'rank'>;

/** `z.toJSONSchema` labels its output; the structured-reply parameter takes the schema. */
const jsonSchemaOf = (schema: z.ZodType): Readonly<Record<string, unknown>> => {
  const schemaObject = z.toJSONSchema(schema) as Record<string, unknown>;
  delete schemaObject.$schema;
  return schemaObject;
};

const isLoose = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Every name of the run a citation, or a recommendation, is allowed to use. */
interface Declared {
  readonly sessions: ReadonlySet<string>;
  readonly excluded: ReadonlySet<string>;
  readonly variants: ReadonlySet<string>;
  readonly steps: ReadonlySet<string>;
  readonly aois: ReadonlySet<string>;
  readonly findings: ReadonlySet<string>;
  /** The recorded length of each session's video, for the sessions this ask carries. */
  readonly videoMs: ReadonlyMap<string, number>;
}

/**
 * A session is excluded when it says so either way: `outcome.excludedFromScores` is derived
 * once in the pipeline and stored, and `status` is what it was derived from. Both are read,
 * so the two spellings cannot disagree their way into a citation.
 */
const isExcluded = (session: Session): boolean =>
  session.outcome.excludedFromScores || session.outcome.status === 'automation_failure';

const declaredBy = (input: AnalysisAskInput): Declared => ({
  sessions: new Set(input.run.sessionIds),
  excluded: new Set(input.sessions.filter(isExcluded).map((session) => session.sessionId)),
  variants: new Set(input.run.variants.map((variant) => variant.id)),
  steps: new Set(input.run.steps.map((step) => step.id)),
  aois: new Set(input.run.aois.map((aoi) => aoi.id)),
  findings: new Set(input.findings.map((finding) => finding.id)),
  videoMs: new Map(
    input.sessions.flatMap((session) =>
      session.video !== undefined && session.video.state === 'recorded'
        ? [[session.sessionId, session.video.durationMs] as const]
        : [],
    ),
  ),
});

/**
 * Everything about one citation that a JSON Schema cannot say: that it names something this
 * run holds, that it is not an excluded session, and that a cited timestamp lands inside the
 * recording it cites.
 *
 * The three kinds are checked against the same declarations `@personavision/contract`'s
 * reference check holds a written `recommendations.json` to, so a reply refused here is
 * exactly a file that would have been refused on the way to disk — reported at the call,
 * where there is still somebody to tell, instead of after the run directory is written.
 */
const checkCitation = (
  citation: Citation,
  declared: Declared,
  cited: (field: string, message: string) => void,
): void => {
  switch (citation.kind) {
    case 'session': {
      if (!declared.sessions.has(citation.sessionId)) {
        cited(
          'sessionId',
          `"${citation.sessionId}" names no session listed in run.json sessionIds: a citation the Analysis screen cannot open is a link to nothing`,
        );
        break;
      }
      if (declared.excluded.has(citation.sessionId)) {
        cited(
          'sessionId',
          `"${citation.sessionId}" is an automation failure, which is excluded from every figure: no recommendation may rest on an excluded session (docs/FLOW.md section 11)`,
        );
        break;
      }
      const durationMs = declared.videoMs.get(citation.sessionId);
      if (durationMs !== undefined && citation.offsetMs > durationMs) {
        cited(
          'offsetMs',
          `${citation.offsetMs} ms is past the end of ${citation.sessionId}'s ${durationMs} ms recording: a cited timestamp lands inside the video it cites`,
        );
      }
      break;
    }
    case 'heatmap': {
      if (!declared.variants.has(citation.variant)) {
        cited('variant', `"${citation.variant}" names no variant this run declares`);
      }
      if (!declared.steps.has(citation.step)) {
        cited('step', `"${citation.step}" names no step this run declares`);
      }
      if (citation.aoiId !== null && !declared.aois.has(citation.aoiId)) {
        cited('aoiId', `"${citation.aoiId}" names no area of interest this run declares`);
      }
      break;
    }
    case 'funnel': {
      if (!declared.steps.has(citation.stepId)) {
        cited('stepId', `"${citation.stepId}" names no step this run declares`);
      }
      break;
    }
  }
};

/**
 * The recommendations worth publishing, and the refusals the rest earn.
 *
 * **Uncited is dropped; wrongly cited is refused.** A recommendation with no citation is not
 * published and costs the reply nothing — `docs/FLOW.md` section 14 says a claim with no
 * evidence link is not published, and the recommendations that did cite their evidence are
 * still worth having. A recommendation whose citation names something this run does not
 * hold, or an excluded session, is a *wrong* claim rather than an unsupported one, and is
 * refused with the path.
 *
 * Every failure is collected before any is thrown, so a reply that is wrong in three places
 * is reported in three places rather than one call at a time.
 */
const published = (
  written: readonly z.infer<typeof replyRecommendationSchema>[],
  declared: Declared,
): readonly Unranked[] => {
  const issues: { readonly path: readonly unknown[]; readonly message: string }[] = [];
  const kept: Unranked[] = [];
  const seen = new Set<string>();

  written.forEach((recommendation, index) => {
    // A recommendation with nothing to cite is not published, so nothing else about it is
    // worth reporting: it is not going to be rendered, and a path naming it would read as
    // though it might have been.
    if (recommendation.citations.length === 0) return;

    const at = (field: string, position: number | null, message: string): void => {
      issues.push({
        path:
          position === null
            ? ['recommendations', index, field]
            : ['recommendations', index, 'citations', position, field],
        message,
      });
    };

    if (seen.has(recommendation.id)) {
      at(
        'id',
        null,
        `"${recommendation.id}" is the id of two recommendations in one reply: a recommendation is addressed by its id — by the screen that links to it and by the change that answers it — so two of one name is one of them lost`,
      );
    }
    seen.add(recommendation.id);

    if (!declared.steps.has(recommendation.step)) {
      at(
        'step',
        null,
        `"${recommendation.step}" names no step this run declares: the step is the second key the ranking is stored from, so a recommendation sits on a step the funnel has`,
      );
    }

    recommendation.findingIds.forEach((findingId, position) => {
      if (!declared.findings.has(findingId)) {
        issues.push({
          path: ['recommendations', index, 'findingIds', position],
          message: `"${findingId}" names no finding this run stated: a recommendation states what to do about a finding, and one resting on a finding nothing recorded is advice with nothing behind it`,
        });
      }
    });

    recommendation.citations.forEach((citation, position) => {
      checkCitation(citation, declared, (field, message) => at(field, position, message));
    });

    kept.push(recommendation);
  });

  if (issues.length > 0) throw new AnalysisReplyRefused(issues);
  return kept;
};

/**
 * The ranking, stored: **worst first, and deterministic**.
 *
 * `recommendationSchema` names the two keys it is stored from — how many people a change
 * would reach, and the funnel step it sits on, *"so a tie is broken by how far through it
 * is"*. Most people first; a tie goes to the **earlier** step, because everybody who reached
 * a later step walked through the earlier one, so fixing that is what unblocks the rest; and
 * a tie there goes to the id, which is arbitrary and that is the point — the same run and
 * the same seed give the same order in every process and on every platform.
 *
 * The rank stored is the position, so it is dense and unique by construction, whatever the
 * reply thought its ranks were.
 */
const ranked = (written: readonly Unranked[], run: Run): Recommendation[] => {
  const depthOf = new Map(run.steps.map((step, index) => [step.id, index] as const));
  // A step this run does not declare is refused before the sort, so an unknown depth can
  // only be a step the sort was never given — placed last rather than compared as NaN.
  const depth = (step: string): number => depthOf.get(step) ?? run.steps.length;
  return [...written]
    .sort(
      (a, b) =>
        b.peopleAffected - a.peopleAffected ||
        depth(a.step) - depth(b.step) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((recommendation, index) => ({ ...recommendation, rank: index + 1 }));
};

/**
 * What the Analysis screen prints above the write-up, where the caller recorded none: what
 * this ask was given.
 *
 * `of` leaves the automation failures out, exactly as the sampler does — the provenance line
 * is about the sessions the run is *about* and not about everything that landed on the disk.
 */
const sampleOf = (input: AnalysisAskInput, declared: Declared): SampleProvenance => {
  if (input.sample !== undefined) return input.sample;
  const read = input.sessions.filter(
    (session) => declared.sessions.has(session.sessionId) && !isExcluded(session),
  ).length;
  return {
    read,
    of: Math.max(declared.sessions.size - declared.excluded.size, read),
    strategy: 'the sessions handed to this ask',
    seed: input.seed,
  };
};

/**
 * Why a run recommends nothing, in one stored sentence (`recommendationsSchema`'s own rule:
 * a run either recommends something or says why it could not).
 *
 * It is written here rather than asked of the model, for the reason this whole file exists: a
 * reply that could not be read is a refusal, and this sentence is a *fact about the reply* —
 * how many recommendations it carried and how many of them cited anything. A model asked for
 * the sentence would be asked to describe the fate of a list it cannot see.
 */
const nothingToRecommend = (written: number, sample: SampleProvenance): string =>
  written === 0
    ? `Muse Wonder read ${sample.read} of ${sample.of} sessions of this run and wrote no recommendation.`
    : `Muse Wonder wrote ${written} recommendation${written === 1 ? '' : 's'} for this run and not one of them cited any evidence, so none is published — a claim with nothing to cite is not published.`;

/**
 * The document the caller is handed: the contract's own `recommendations.json`, ranked,
 * validated, and carrying either recommendations or the reason there are none.
 *
 * `writeUp` is deliberately absent. It is generated from the recommendations below rather
 * than written beside them, and that generation is `@personavision/scoring`'s (#260) — this
 * use produces the objects the write-up is generated from, and a block invented here would
 * be the prose section 14 forbids.
 */
const documentFrom = (
  written: readonly Unranked[],
  input: AnalysisAskInput,
  declared: Declared,
  count: number,
): Recommendations => {
  const sample = sampleOf(input, declared);
  const recommendations = ranked(written, input.run);
  return recommendationsSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    runId: input.run.runId,
    sample,
    recommendations,
    ...(recommendations.length === 0 && {
      nothingToRecommend: nothingToRecommend(count, sample),
    }),
  });
};

/**
 * The reply, held to the described shape, then to everything above it, then to the
 * contract's own.
 *
 * Two shapes reach it: the list a model answers, and a whole `Recommendations` — which is
 * what the offline generator produces and what a caller is handed back, so a document may be
 * run through here twice. Either way the run's own facts are **stamped and never read**: the
 * schema version, the run id and the sample come from this ask, because a reply is in no
 * position to say which run it is about, and the rank is recomputed, because a dense unique
 * order is a property of the list and not of any entry in it.
 */
const parseAnalysis = (reply: unknown, input: AnalysisAskInput): Recommendations => {
  const listed = isLoose(reply) ? reply.recommendations : reply;
  // Both shapes carry `recommendations`; a whole document carries a stored `rank` on each
  // entry as well, which is recomputed here rather than read. Anything that is not a list is
  // handed to the schema as it is, so a reply with no list in it is refused at
  // `recommendations` — a missing list is a malformed reply and never an empty one.
  const stripped = Array.isArray(listed)
    ? listed.map((one: unknown) =>
        isLoose(one)
          ? Object.fromEntries(Object.entries(one).filter(([field]) => field !== 'rank'))
          : one,
      )
    : listed;
  const written = analysisReplySchema.parse({ recommendations: stripped }).recommendations;
  const declared = declaredBy(input);
  return documentFrom(published(written, declared), input, declared, written.length);
};

/** One line per screen of one session, as a reader of the sample would skim it. */
const sessionLines = (session: Session): readonly string[] => {
  const { outcome, video } = session;
  const moments = session.screens.map((screen, index) => {
    const offsetMs =
      video !== undefined && video.state === 'recorded' ? video.screenOffsetsMs[index] : undefined;
    const at =
      offsetMs === undefined || offsetMs === null ? 'not in the recording' : `${offsetMs} ms`;
    return `  - \`${screen.step}\` at ${at} — wanted: ${screen.intent}; did: ${screen.decidedAction}`;
  });
  return [
    `### ${session.sessionId} (${session.variant})`,
    `Ended ${outcome.status} on \`${outcome.step}\` after ${session.durationMs} ms: ${outcome.reason}`,
    ...(moments.length === 0 ? ['  - no screen recorded'] : moments),
    '',
  ];
};

/**
 * What the model reads: the run, its scores, its findings and the sessions read whole.
 *
 * The aggregate's sections — the funnel by step, the time-per-step distribution, the click
 * and scroll bins, the common paths — belong between the scores and the findings when step
 * #223 lands. Nothing is reserved for them here and no field of them is guessed at: the
 * reply shape does not change when they arrive.
 */
const documentOf = (input: AnalysisAskInput): string => {
  const { run } = input;
  const citable = input.sessions.filter((session) => !isExcluded(session));
  const excluded = input.sessions.filter(isExcluded);
  return [
    'Read a finished PersonaVision test — simulated people attempting one task on a website — and write what the site owner should change.',
    '',
    '## The run',
    '',
    `- id: ${run.runId}`,
    `- task: ${run.task.prompt}`,
    ...(run.goal === undefined
      ? []
      : [`- goal: ${run.goal.task}`, `- success: ${run.goal.successCriterion}`]),
    ...(run.feature === undefined
      ? []
      : [`- the feature, in the user's own words: ${run.feature}`]),
    `- variants: ${run.variants.map((variant) => `\`${variant.id}\` (${variant.name})`).join(', ')}`,
    `- steps, in order: ${run.steps.map((step) => `\`${step.id}\` (${step.label})`).join(' → ')}`,
    ...(run.aois.length === 0
      ? []
      : [
          `- areas of interest: ${run.aois
            .map((aoi) => `\`${aoi.id}\` (${aoi.label}, \`${aoi.variant}\`/\`${aoi.step}\`)`)
            .join(', ')}`,
        ]),
    '',
    '## The scores',
    '',
    ...(run.scores.length === 0
      ? ['None recorded.']
      : run.scores.flatMap((score) => [
          `- \`${score.variant}\`: ${score.scoredSessionCount} sessions scored — ${score.outcomeCounts.success} completed, ${score.outcomeCounts.abandoned} abandoned, ${score.outcomeCounts.failed} failed, ${score.outcomeCounts.automationFailure} automation failures; completion rate ${score.completionRate}; friction score ${score.frictionScore.median} of 100`,
          `  the step people were slowest to reach the primary action on: \`${score.components.timeToFirstFixationPrimary.worstStep}\``,
        ])),
    '',
    '## The findings this run stated',
    '',
    ...(input.findings.length === 0
      ? [
          'None: this run stated no finding, so there is nothing to rest a recommendation on and the answer is an empty list.',
          '',
        ]
      : input.findings.flatMap((finding) => [
          `### ${finding.id} (${finding.severity}, ${finding.attribution})`,
          `What happened: ${finding.claim}`,
          `Evidence: ${finding.evidence}`,
          `Where: \`${finding.step}\`${finding.variant === null ? ' (the run itself, not one variant)' : ` on \`${finding.variant}\``}${finding.aoiId === null ? '' : `, area \`${finding.aoiId}\``}`,
          `Sessions: ${finding.sessionIds.length === 0 ? 'none named' : finding.sessionIds.map((id) => `\`${id}\``).join(', ')} (${finding.sessionCount} in all)`,
          '',
        ])),
    '## The sessions read whole',
    '',
    ...(citable.length === 0 ? ['None.', ''] : citable.flatMap(sessionLines)),
    ...(excluded.length === 0
      ? []
      : [
          '## Sessions you may not cite',
          '',
          `These ended in an automation failure — our own breakage, not the site's — so they are out of every figure and no recommendation may rest on one: ${excluded
            .map((session) => `\`${session.sessionId}\``)
            .join(', ')}.`,
          '',
        ]),
    '## What to answer',
    '',
    '- `recommendations`: what to change, one entry per thing worth changing, and an empty list where there is nothing worth changing.',
    '- `sentence`: one plain sentence a site owner could act on. Two sentences is refused.',
    '- `evidence`: why, in the words the Summary prints under the sentence.',
    '- `findingIds`: the findings above this one rests on, by their ids. At least one, and an id that is not above is refused with the path named.',
    '- `citations`: the evidence itself, structured and never a URL — `{"kind":"session","sessionId":"S-07","offsetMs":48000}` for a moment in a recording, `{"kind":"heatmap","variant":"a","step":"basket","aoiId":null}` for a region, `{"kind":"funnel","stepId":"basket"}` for a step. Every name has to be one declared above, and a session timestamp has to land inside that session\'s recording.',
    '- **A recommendation with no citation is not published.** It is dropped rather than rendered: a claim with no evidence behind it is not an answer.',
    '- A citation naming a session, a variant, a step or an area this run does not hold, or one of the excluded sessions, is refused with the path named rather than rendered as a link to nothing.',
    '- `peopleAffected`: how many of the people above a change would reach. `step`: the step above it sits on. The two are what the ranking is stored from, so neither is a guess.',
    '- Do not write a rank, a run id or a write-up: the order is computed from the two keys above, and the write-up is generated from these objects.',
  ].join('\n');
};

/**
 * The recommendations when there is no model: deterministic, seeded, and the project's
 * default — one recommendation per **product** finding, resting on that finding and citing
 * what it names.
 *
 * It is a stand-in and reads like one. The findings already say what happened, to how many
 * people and where, so the seed is spent on the one thing they do not say, which is how to
 * put it as something to do — and on which of a finding's sessions to cite. An automation
 * finding produces none: it is our breakage, and advice about our harness is not advice
 * about the site (`docs/FLOW.md` section 11).
 *
 * It never cites an excluded session and never cites a name this run does not declare, which
 * is why the default path exercises the same rules a model's reply is held to rather than
 * only the happy half of them.
 */
const offlineAnalysis = (input: AnalysisAskInput, seed: number): Recommendations => {
  const random = createSeededRandom(seed);
  const declared = declaredBy(input);
  const byId = new Map(input.sessions.map((session) => [session.sessionId, session] as const));
  const openings = [
    (where: string): string => `Make the ${where} step easier to get past`,
    (where: string): string => `Change the ${where} step`,
    (where: string): string => `Fix what stops people on the ${where} step`,
  ];

  const written = input.findings.flatMap((finding, index): Unranked[] => {
    if (finding.attribution !== 'product') return [];

    const citable = finding.sessionIds.filter(
      (sessionId) => declared.sessions.has(sessionId) && !declared.excluded.has(sessionId),
    );
    const citations: Citation[] = [];
    // One moment in one recording, so a screen has a frame to open on. The session is drawn
    // off the stream and the offset is that session's own: the step the finding is about
    // where the recording reaches it, and the start of the recording where it does not.
    if (citable.length > 0) {
      const sessionId = citable[Math.floor(random() * citable.length)];
      const session = byId.get(sessionId);
      const video = session?.video;
      const screenIndex =
        session?.screens.findIndex((screen) => screen.step === finding.step) ?? -1;
      const offsetMs =
        video !== undefined && video.state === 'recorded' && screenIndex >= 0
          ? (video.screenOffsetsMs[screenIndex] ?? 0)
          : 0;
      citations.push({ kind: 'session', sessionId, offsetMs });
    }
    if (
      finding.variant !== null &&
      declared.variants.has(finding.variant) &&
      declared.steps.has(finding.step)
    ) {
      citations.push({
        kind: 'heatmap',
        variant: finding.variant,
        step: finding.step,
        aoiId: finding.aoiId !== null && declared.aois.has(finding.aoiId) ? finding.aoiId : null,
      });
    }
    if (declared.steps.has(finding.step)) citations.push({ kind: 'funnel', stepId: finding.step });

    // The drop rule applies to the generator as well: a finding with nothing this run can
    // show is not advice, and emitting it would be refused by the validator this answer goes
    // through anyway.
    if (citations.length === 0) return [];

    const label = input.run.steps.find((step) => step.id === finding.step)?.label ?? finding.step;
    const opening = openings[Math.floor(random() * openings.length)](label);
    // A finding whose every session is excluded or is one the run does not list still has
    // the heatmap and the funnel behind it, so it is advice; what it has not got is a number
    // of people, and *"where 0 people ran into trouble"* would be a figure nobody measured.
    // The clause is left off rather than filled in, and `peopleAffected` stays the citable
    // count, which puts such a recommendation last in the ranking where it belongs.
    const who =
      citable.length === 0
        ? ''
        : `, where ${citable.length === 1 ? 'one person' : `${citable.length} people`} of this run ran into trouble`;
    return [
      {
        id: `R-${String(index + 1).padStart(2, '0')}`,
        sentence: `${opening}${who}.`,
        evidence: finding.evidence,
        findingIds: [finding.id],
        citations,
        peopleAffected: citable.length,
        step: finding.step,
      },
    ];
  });

  return documentFrom(written, input, declared, written.length);
};

/**
 * One ask for the analysis of one run. The use owns its words, its schema, its validation
 * and its offline answer; the seam and every implementation of it own none of the four
 * (`wonder.ts`).
 */
export const analysisAsk = (input: AnalysisAskInput): WonderAsk<Recommendations> => {
  if (input.sessions.length === 0) {
    throw new TypeError(
      'an analysis is written from the sessions a run produced, and this ask carries none: a run with nothing read has no recommendation to make and nothing to cite for one',
    );
  }
  return {
    use: 'analysis',
    document: documentOf(input),
    seed: input.seed,
    replySchema: {
      name: ANALYSIS_REPLY_SCHEMA_NAME,
      schema: jsonSchemaOf(analysisReplySchema),
    },
    effort: input.effort ?? ANALYSIS_EFFORT,
    parse: (reply) => parseAnalysis(reply, input),
    offline: (seed) => offlineAnalysis(input, seed),
  };
};

/**
 * The analysis, through whichever implementation the caller selected. The reply carries the
 * five usage figures a decision reports, so an analysis call adds to a run's usage through
 * the one `totalUsage` and there is no second block for it (#32).
 *
 * Writing `recommendations.json` into the run directory is the caller's: this returns the
 * objects.
 */
export const writeAnalysis = async (
  provider: WonderProvider,
  input: AnalysisAskInput,
): Promise<WonderReply<Recommendations>> => provider.ask(analysisAsk(input));
