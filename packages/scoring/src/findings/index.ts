import type { Findings, Session } from '@personavision/contract';
import { FINDING_RULE_IDS, scoringConfig, type FindingRuleId, type Severity } from '../config.js';
import type { Aoi, AoiMetric, VariantScore } from '../score.js';
import { readRun } from './readings.js';
import { fire, type RuleHit } from './rules.js';

/**
 * The findings generator: a run's conclusions in words.
 *
 * One finding per rule that fires, each a claim sentence a business reader could repeat,
 * an evidence sentence with the numbers behind it, a severity from `scoringConfig`, the
 * area and step it concerns, the sessions behind it and a link to the screen that proves
 * it. Ranked by severity, then by how many sessions are behind it
 * (`docs/FLOW.md` section 6).
 *
 * Pure: contract types only, no disk, no network, no browser. The rules live in
 * `rules.ts`, the readings they compare in `readings.ts` and the phrases they are written
 * from in `wording.ts`, so a rule reads as a statement about the product rather than as
 * arithmetic over fixations.
 *
 * **Every finding is returned.** The Verdict screen shows at most three and the cap is
 * presentation: it lives in `verdict.headlineFindingIds` (#27), which names the top three
 * of this list, so the pipeline ranks once and no screen re-ranks.
 */

/** One finding, as `findings.json` records it. */
export type Finding = Findings['findings'][number];

/** The signature #28 implements: the run's sessions and aggregates in, ranked words out. */
export type FindingsGenerator = (
  sessions: readonly Session[],
  aois: readonly Aoi[],
  aoiMetrics: readonly AoiMetric[],
  scores: readonly VariantScore[],
) => Finding[];

/** Worst first. The order of the `--sev-*` tokens, and the first key the ranking sorts on. */
const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Separates a finding's rule from the version it is about inside its `id`. */
const ID_SEPARATOR = '@';

/** What a finding about the run itself, rather than about one version, is addressed as. */
const RUN_SCOPE = 'run';

/**
 * A finding's id: its rule, and the version it is about.
 *
 * `findings.json` has no field for the rule that produced a finding, and three things need
 * one — the planted-defect evaluation matches by rule id (#29), the demo shop declares its
 * defects by rule id, and `verdict.headlineFindingIds` has to name a finding in a way that
 * survives another rule firing and shifting every rank. So the id carries it:
 * `never-fixated-primary-action@B`. A positional `F-1` would satisfy none of the three.
 *
 * A rule fires at most once per version, which is what makes this unique.
 */
const idOf = (hit: RuleHit): string => `${hit.ruleId}${ID_SEPARATOR}${hit.variant ?? RUN_SCOPE}`;

/**
 * The rule behind a finding, or `null` when its id was not written by this generator.
 *
 * The supported way to read a rule back off a finding — #29 and the demo step use this
 * rather than splitting the id themselves, so the scheme above stays this package's
 * business.
 */
export const findingRuleIdOf = (finding: Finding): FindingRuleId | null => {
  const [ruleId] = finding.id.split(ID_SEPARATOR);
  return (FINDING_RULE_IDS as readonly string[]).includes(ruleId)
    ? (ruleId as FindingRuleId)
    : null;
};

/**
 * Severity first, then the number of sessions behind it, then the finding's own id.
 *
 * `docs/FLOW.md` section 6 fixes the first two keys. The third is the tie-break that makes
 * the order total: two findings of equal severity with equal numbers of sessions would
 * otherwise come back in whatever order the rules were written in, and the rank a screen
 * links by would change under an edit that changed no reading.
 */
const ranked = (hits: readonly RuleHit[]): RuleHit[] =>
  [...hits].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(scoringConfig.severityByRule[a.ruleId]) -
        SEVERITY_ORDER.indexOf(scoringConfig.severityByRule[b.ruleId]) ||
      b.sessionIds.length - a.sessionIds.length ||
      idOf(a).localeCompare(idOf(b)),
  );

export const findings: FindingsGenerator = (sessions, aois, aoiMetrics, scores) =>
  ranked(fire(readRun(sessions, aois, aoiMetrics, scores))).map((hit, position) => ({
    id: idOf(hit),
    rank: position + 1,
    severity: scoringConfig.severityByRule[hit.ruleId],
    claim: hit.claim,
    evidence: hit.evidence,
    variant: hit.variant,
    step: hit.step,
    aoiId: hit.aoiId,
    sessionIds: [...hit.sessionIds],
    sessionCount: hit.sessionIds.length,
    attribution: hit.attribution,
    evidence_link: { screen: hit.evidenceLink.screen, params: { ...hit.evidenceLink.params } },
  }));
