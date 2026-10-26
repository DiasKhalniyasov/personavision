import type { Run } from '@personavision/contract';

/**
 * The one or two reasons, in plain words, drawn from the top findings: the `.reasons` of `#screen-verdict`.
 *
 * A placeholder: it holds the slot and the class the prototype draws it with, and renders
 * nothing. **#15** fills this file, and no sibling section has to be touched for it.
 */
export function Reasons({ run }: { run: Run }) {
  void run;
  return <div className="reasons" data-section="reasons" />;
}
