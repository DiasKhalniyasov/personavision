import type { Run } from '@personavision/contract';

/**
 * The four doors to the detail — score breakdown, attention, people, watch one person: the `.doors` of `#screen-verdict`.
 *
 * A placeholder: it holds the slot and the class the prototype draws it with, and renders
 * nothing. **#16** fills this file, and no sibling section has to be touched for it.
 */
export function DetailDoors({ run }: { run: Run }) {
  void run;
  return <div className="doors" data-section="detail-doors" />;
}
