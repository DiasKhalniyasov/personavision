import type { Run } from '@personavision/contract';

/**
 * At most three findings, each a claim with its evidence: the *What to fix first* section of `#screen-verdict`.
 *
 * A placeholder: it holds the slot and the class the prototype draws it with, and renders
 * nothing. **#16** fills this file, and no sibling section has to be touched for it.
 */
export function HeadlineFindings({ run }: { run: Run }) {
  void run;
  return <div className="section" data-section="headline-findings" />;
}
