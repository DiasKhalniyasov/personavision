import type { Run, WriteUpClaim } from '@personavision/contract';
import { CiteRow } from './CiteRow';
import styles from './analysis.module.css';

/**
 * One claim of the write-up: a heading, the paragraph that argues it, and the evidence it
 * rests on — the `h2`, the `.lede` and the `.cites` row of `#screen-analysis`.
 *
 * Every claim of the write-up renders this way, the closing *"What I did not find"* claim
 * included: it is one of the claims the generator produced and the last of them, in the
 * shape of the others, which is how the section that stops silence reading as a verdict
 * stays part of the write-up rather than an afterthought under it (`docs/FLOW.md` section
 * 14.6).
 *
 * **Nothing here writes, shortens or re-words a claim.** The heading and the body are the
 * generator's own prose (`@personavision/scoring`'s `writeUp`, generated from the
 * recommendation objects and the aggregate), and this screen renders them.
 */
export function Claim({ run, claim }: { run: Run; claim: WriteUpClaim }) {
  return (
    <div className={styles.claim} data-part="claim">
      <h2 className={styles.heading}>{claim.heading}</h2>
      <p className={`lede ${styles.body}`}>{claim.body}</p>
      <CiteRow run={run} citations={claim.citations} />
    </div>
  );
}

/**
 * Whether a claim may be published, which this screen **asserts rather than assumes**.
 *
 * Two rules, both `docs/FLOW.md`'s and both already held by the pipeline that writes the
 * file — the contract refuses to write a document that breaks either (`validateRecommendations`).
 * They are checked again here because this screen renders a file on disk: a run written
 * before a rule existed, or a file somebody edited, is exactly the case where a claim a
 * reader cannot check would reach the page.
 *
 * 1. **A claim with nothing to cite is not published** (section 14). The whole screen is
 *    claims whose evidence is one click away; a sentence with no evidence beside it is the
 *    one thing that makes the cited ones look optional.
 * 2. **No claim rests on an excluded session** (section 11). A claim whose every cited
 *    person is one our own browser automation broke is a claim about our harness, not about
 *    somebody's site, and the closing footnote promises it is not on the screen. One
 *    excluded session cited beside people the run did measure is not that: the excluded one
 *    is simply not one of the people the claim is about, which is the rule the contract
 *    spells out and this is the same reading of it.
 *
 * A dropped claim is dropped quietly, because the file the pipeline writes never carries
 * one: the reporting of a dropped claim belongs where the claim is generated, and
 * `writeUp`'s own `report` is where it is already said in words.
 */
export const publishable = (claim: WriteUpClaim, ourBreakage: ReadonlySet<string>): boolean => {
  if (claim.citations.length === 0) return false;

  const people = claim.citations.filter((citation) => citation.kind === 'session');
  return people.length === 0 || !people.every((citation) => ourBreakage.has(citation.sessionId));
};
