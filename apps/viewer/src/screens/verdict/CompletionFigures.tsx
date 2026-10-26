import type { Run } from '@personavision/contract';

/**
 * The two completion figures side by side, each with the number of people behind it, banded by the `--completion-threshold-*` tokens: the `.figures` of `#screen-verdict`.
 *
 * A placeholder: it holds the slot and the class the prototype draws it with, and renders
 * nothing. **#15** fills this file, and no sibling section has to be touched for it.
 */
export function CompletionFigures({ run }: { run: Run }) {
  void run;
  return <div className="figures" data-section="completion-figures" />;
}
