import type { Audience, Verdict } from '@personavision/contract';
import type { Finding } from './findings/index.js';
import type { VariantScore } from './score.js';

/**
 * The verdict: what the product leads with, produced once by the pipeline and stored.
 *
 * Which variant is harder and by how many points, whether the ± 1σ bands overlap and how
 * many seed groups agreed; and for the Verdict screen, the variant the audience completes,
 * the headline sentence in the audience's words, one or two reasons, at most three
 * headline findings and the one heatmap the screen embeds (`docs/FLOW.md` section 5).
 *
 * It takes the findings and the audience because the reasons are drawn from the findings
 * and the headline sentence names the audience.
 */

/** The signature #27 implements. */
export type VerdictWriter = (
  scores: readonly VariantScore[],
  findings: readonly Finding[],
  audience: Audience,
) => Verdict;

/**
 * Not built yet: **#27** fills this in, together with the acceptance gate from section 5's
 * table. It is declared here, with its agreed signature, so that #27, #28 and #29 can be
 * worked at the same time rather than queueing behind one barrel file.
 */
export const verdict: VerdictWriter = () => {
  throw new Error('verdict() is not implemented yet: the verdict and its gate are ticket #27');
};
