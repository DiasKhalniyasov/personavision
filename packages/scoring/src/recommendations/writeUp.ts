import type { Recommendation, SampleProvenance, WriteUpClaim } from '@personavision/contract';
import type { Finding } from '../findings/index.js';

/**
 * The write-up: Wonder's full reading of the run, as the ordered claims the Analysis screen
 * renders (`docs/FLOW.md` section 14, item 6).
 *
 * One claim per thing worth saying — a heading, a body, and the citations it rests on,
 * because a claim with nothing to cite is not published — closing with the *"What I did
 * not find"* claim, whose wording and whose position are #260's and are deliberately not
 * frozen in the schema (the decision on #249). It is a block inside
 * `recommendations.json` rather than a file of its own, so the Analysis screen fetches one
 * thing.
 */

/**
 * What the generator is given. #260 settles the rest of this shape in this file; the
 * barrel re-exports it by name, so adding to it costs that file no edit.
 */
export interface WriteUpInput {
  /** The ranked recommendations the write-up is generated from, never from prose. */
  readonly recommendations: readonly Recommendation[];
  /** Every finding of the run, so the closing claim can say what produced no advice. */
  readonly findings: readonly Finding[];
  /** How much of the run was read: the provenance the Analysis screen prints above this. */
  readonly sample: SampleProvenance;
}

/** The signature #260 implements. */
export type WriteUpGenerator = (input: WriteUpInput) => WriteUpClaim[];

/**
 * Not built yet: **#260** fills this in. Declared here for the same reason the builder
 * beside it is: the surface was agreed before either body existed, so the two tickets run
 * at the same time and neither touches a shared file.
 */
export const writeUp: WriteUpGenerator = () => {
  throw new Error('writeUp() is not implemented yet: the write-up generator is ticket #260');
};
