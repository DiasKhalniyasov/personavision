/**
 * Every citation held to the run it belongs to.
 *
 * A citation that cannot be opened is worse than no citation: it is a claim that looks
 * checkable and is not. So this module resolves each one against the run before
 * `recommendations.json` is written — a session id that is not in the run, a heatmap region
 * the run never captured, a funnel step the aggregate does not carry, a finding
 * `findings.json` does not hold — and reports each offence as a `Violation` at the JSON
 * path of the value that is wrong. `validate`, `readRun` and `writeRun` all run it, so a
 * citation that would not resolve is a refusal rather than a dead link on a screen.
 *
 * It is the **run-level** half of the contract, and the half the per-file schema cannot
 * do: `recommendationsSchema` holds one document to its own shape with nothing else in
 * hand, while these rules need the sessions, the areas of interest, the findings and the
 * aggregate at once.
 *
 * It also enforces the one rule of `docs/FLOW.md` section 11 that is about our own honesty
 * rather than about shape — **no recommendation may rest on an excluded session**. A claim
 * whose every cited session is our own automation failing is a claim about our harness, and
 * the product does not publish it as advice about somebody's site.
 *
 * Pure, and reaching no file system: the reader in `io.ts` calls it with what it parsed,
 * and a caller holding a run artifact in memory calls it with that.
 */

import { runPaths } from './paths.js';
import type { Aggregate, Citation, Findings, Recommendations, Run, Session } from './schemas.js';
import type { Violation } from './violations.js';
import { at } from './violations.js';

/**
 * The layout, addressed relatively, for the `file` of a violation. Annotated pure for the
 * same reason `io.ts` annotates its own: `apps/viewer` imports this package in the browser,
 * and a call left at the top level would keep this module in its bundle.
 */
const relative = /* @__PURE__ */ runPaths('');

/**
 * A run with the recommendations that are about it: everything a citation is resolved
 * against. A `RunArtifact` is one of these, so the reader passes what it parsed straight in.
 *
 * `findings` and `aggregate` are optional because the reader may be holding a directory
 * whose `findings.json` did not parse, and because `aggregate.json` is optional in a run
 * directory at all. `recommendations` is optional by the same rule as the file: a run that
 * produced none is no violations rather than an empty list somebody has to check.
 */
export interface CitedRun {
  readonly run: Run;
  readonly sessions: ReadonlyArray<Session>;
  readonly findings?: Findings;
  readonly aggregate?: Aggregate;
  readonly recommendations?: Recommendations;
}

/**
 * Whether a session is out of the run the recommendations are about — the same question
 * `@personavision/scoring`'s sampler asks, spelt the same way.
 *
 * `excludedFromScores` is the stored answer and is read, never re-derived; the status is
 * checked beside it rather than instead of it, because the two are set together in one
 * place (`packages/swarm/src/outcome.ts`) and a file that says one without the other is a
 * file this check must not read as product evidence.
 */
const isExcluded = (session: Session): boolean =>
  session.outcome.excludedFromScores || session.outcome.status === 'automation_failure';

/** The list a cited claim sits in: the ranked recommendations, or the write-up's own claims. */
type CitingList = 'recommendations' | 'writeUp';

/** What one entry of that list is called, for a message about the whole of it. */
const KIND_OF_CLAIM: Record<CitingList, string> = {
  recommendations: 'recommendation',
  writeUp: 'write-up claim',
};

/** The people one claim cites, as the run knows them. */
interface CitedPeople {
  /** Distinct sessions the run holds and our automation did not break. */
  counted: string[];
  /** Distinct sessions the run holds that it did. */
  excluded: string[];
}

const ALL_EXCLUDED =
  'every session it cites is an automation failure — our own, excluded from every figure — so the claim is about our harness and not about the site (docs/FLOW.md section 11)';

/**
 * Every violation in one run's recommendations, each at the JSON path of the offending
 * value. It does not stop at the first one, and an empty array means every citation in the
 * document resolves against the run.
 */
export const validateRecommendations = (cited: CitedRun): Violation[] => {
  const { run, sessions, findings, aggregate, recommendations } = cited;
  if (recommendations === undefined) return [];
  const violations: Violation[] = [];

  const declaredSessions = new Set(run.sessionIds);
  const declaredVariants = new Set(run.variants.map((variant) => variant.id));
  const declaredSteps = new Set(run.steps.map((step) => step.id));
  const declaredAois = new Set(run.aois.map((aoi) => aoi.id));
  const declaredFindings = new Set(findings?.findings.map((finding) => finding.id) ?? []);
  const excludedSessions = new Set(sessions.filter(isExcluded).map((session) => session.sessionId));

  /**
   * The steps a funnel citation can anchor. The Funnel and timing screen draws its rows
   * from `aggregate.json`, so when the run has an aggregate that file is what a funnel
   * anchor has to be found in — a step the run declares but nobody walked is a row that
   * screen does not render. A run with no aggregate has no funnel to carry a step either,
   * and the most the contract can hold a citation to there is the task's own steps.
   */
  const funnelSteps =
    aggregate === undefined
      ? undefined
      : new Set(aggregate.funnelSlices.flatMap((slice) => slice.funnel.map((row) => row.step)));

  const inFile = (path: ReadonlyArray<PropertyKey>, message: string): void => {
    violations.push(at(relative.recommendations, path, message));
  };

  /**
   * Each kind of citation against the declarations it addresses — the same ones a finding
   * is held to. The Analysis screen builds every citation into a deep link, a replay at the
   * millisecond named, a heatmap route, a funnel anchor, so a citation naming anything this
   * run does not hold is a link to nothing.
   */
  const checkCitations = (
    list: CitingList,
    index: number,
    citations: ReadonlyArray<Citation>,
  ): void => {
    citations.forEach((citation, position) => {
      const where = (field: string): PropertyKey[] => [list, index, 'citations', position, field];
      switch (citation.kind) {
        case 'session':
          if (!declaredSessions.has(citation.sessionId)) {
            inFile(
              where('sessionId'),
              `"${citation.sessionId}" names no session listed in run.json sessionIds`,
            );
          }
          break;
        case 'heatmap':
          if (!declaredVariants.has(citation.variant)) {
            inFile(
              where('variant'),
              `"${citation.variant}" names no variant declared in this run's variants`,
            );
          }
          if (!declaredSteps.has(citation.step)) {
            inFile(where('step'), `"${citation.step}" names no step declared in this run's steps`);
          }
          if (citation.aoiId !== null && !declaredAois.has(citation.aoiId)) {
            inFile(
              where('aoiId'),
              `"${citation.aoiId}" names no area of interest declared in this run's aois`,
            );
          }
          break;
        case 'funnel':
          if (funnelSteps === undefined) {
            if (!declaredSteps.has(citation.stepId)) {
              inFile(
                where('stepId'),
                `"${citation.stepId}" names no step declared in this run's steps`,
              );
            }
          } else if (!funnelSteps.has(citation.stepId)) {
            inFile(
              where('stepId'),
              `"${citation.stepId}" names no step the funnel in ${relative.aggregate} carries`,
            );
          }
          break;
      }
    });
  };

  /**
   * The people a claim cites, as the run knows them: distinct session ids the run holds,
   * split into the ones a figure may rest on and the ones our own automation broke. A
   * citation into a session the run does not hold is left out — it is already a violation of
   * its own, and counting it here would report one mistake twice.
   */
  const citedPeople = (citations: ReadonlyArray<Citation>): CitedPeople => {
    const ids = new Set(
      citations.flatMap((citation) =>
        citation.kind === 'session' && declaredSessions.has(citation.sessionId)
          ? [citation.sessionId]
          : [],
      ),
    );
    const counted: string[] = [];
    const excluded: string[] = [];
    for (const sessionId of ids) {
      (excludedSessions.has(sessionId) ? excluded : counted).push(sessionId);
    }
    return { counted, excluded };
  };

  /**
   * `docs/FLOW.md` section 11, held here: a claim resting on nothing but our own breakage is
   * a claim about our harness. One cited session among several is fine — the excluded one is
   * simply not one of the people the claim is about, and `peopleAffected` does not count it.
   */
  const checkNotOnlyOurBreakage = (list: CitingList, index: number, people: CitedPeople): void => {
    if (people.excluded.length === 0 || people.counted.length > 0) return;
    inFile(
      [list, index, 'citations'],
      `this ${KIND_OF_CLAIM[list]} rests on an excluded session: ${ALL_EXCLUDED}`,
    );
  };

  /**
   * How many people the run measured at all, which is the most a change can reach. The
   * aggregate's own count is it where there is one, and the sessions our automation did not
   * break where there is not — either way a number somebody counted, and never a bound this
   * module invents.
   */
  const measured =
    aggregate === undefined
      ? {
          count: run.sessionIds.filter((sessionId) => !excludedSessions.has(sessionId)).length,
          source: 'the run holds',
          of: 'sessions our own automation did not break',
        }
      : {
          count: aggregate.scoredSessionCount,
          source: `${relative.aggregate} is of`,
          of: 'scored sessions',
        };

  recommendations.recommendations.forEach((recommendation, index) => {
    checkCitations('recommendations', index, recommendation.citations);
    // The schema holds a recommendation to naming the findings it rests on; which file
    // those names are in is only knowable here. A recommendation resting on a finding that
    // findings.json does not carry is the drift that rule exists to prevent.
    if (findings !== undefined) {
      recommendation.findingIds.forEach((findingId, position) => {
        if (!declaredFindings.has(findingId)) {
          inFile(
            ['recommendations', index, 'findingIds', position],
            `"${findingId}" names no finding in ${relative.findings}`,
          );
        }
      });
    }
    const people = citedPeople(recommendation.citations);
    checkNotOnlyOurBreakage('recommendations', index, people);

    // `peopleAffected` is the first key the ranking is stored from, so a number nobody
    // measured would reorder the screen. It is held between the two counts that exist: the
    // people the claim itself cites, and the people the run measured at all.
    const where = ['recommendations', index, 'peopleAffected'] as const;
    if (recommendation.peopleAffected < people.counted.length) {
      inFile(
        where,
        `peopleAffected is the people a change would reach, and this recommendation cites ${people.counted.length} of them by session: ${recommendation.peopleAffected} is fewer than its own evidence`,
      );
    }
    if (recommendation.peopleAffected > measured.count) {
      inFile(
        where,
        `peopleAffected is the ranking key, and it cannot be a number nobody measured: this says ${recommendation.peopleAffected}, and ${measured.source} ${measured.count} ${measured.of}`,
      );
    }
  });

  recommendations.writeUp?.forEach((claim, index) => {
    checkCitations('writeUp', index, claim.citations);
    checkNotOnlyOurBreakage('writeUp', index, citedPeople(claim.citations));
  });

  return violations;
};
