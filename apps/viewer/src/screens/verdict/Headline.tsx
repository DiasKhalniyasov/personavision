import type { Run } from '@personavision/contract';

/**
 * The one headline sentence naming the version the audience completes, in the user's words: the `.hero` of `#screen-verdict`.
 *
 * A placeholder: it holds the slot and the class the prototype draws it with, and renders
 * nothing. **#15** fills this file, and no sibling section has to be touched for it.
 */
export function Headline({ run }: { run: Run }) {
  void run;
  return <div className="hero" data-section="headline" />;
}
