import type { Run } from '@personavision/contract';

/**
 * The audience the result is about, and the people it generated: the `.audbar` of `#screen-verdict`.
 *
 * A placeholder: it holds the slot and the class the prototype draws it with, and renders
 * nothing. **#15** fills this file, and no sibling section has to be touched for it.
 */
export function AudienceLine({ run }: { run: Run }) {
  void run;
  return <div className="audbar" data-section="audience-line" />;
}
