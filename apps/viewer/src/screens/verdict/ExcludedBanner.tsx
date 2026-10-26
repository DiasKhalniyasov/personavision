import type { Run } from '@personavision/contract';

/**
 * The banner naming the people whose session ended because our own automation broke, and saying plainly that they are excluded from both figures: the `.notice` of `#screen-verdict`.
 *
 * A placeholder: it holds the slot and the class the prototype draws it with, and renders
 * nothing. **#14** fills this file, and no sibling section has to be touched for it.
 */
export function ExcludedBanner({ run }: { run: Run }) {
  void run;
  return <div className="notice" data-section="excluded-banner" />;
}
