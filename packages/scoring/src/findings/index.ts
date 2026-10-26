import type { Findings, Session } from '@personavision/contract';
import type { Aoi, AoiMetric, VariantScore } from '../score.js';

/**
 * The findings generator: a run's conclusions in words.
 *
 * One finding per rule that fires, each a claim sentence a business reader could repeat,
 * an evidence sentence with the numbers behind it, a severity from `scoringConfig`, the
 * area and step it concerns, the sessions behind it and a link to the screen that proves
 * it. Ranked by severity, then by how many sessions are behind it
 * (`docs/FLOW.md` section 6).
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

/**
 * Not built yet: **#28** fills this in. It is declared here, with its agreed signature, so
 * that #27, #28 and #29 can be worked at the same time rather than queueing behind one
 * barrel file — each replaces one body and nobody else touches the entry point.
 */
export const findings: FindingsGenerator = () => {
  throw new Error('findings() is not implemented yet: the findings generator is ticket #28');
};
