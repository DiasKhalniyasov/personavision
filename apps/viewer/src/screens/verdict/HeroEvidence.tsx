import type { Run } from '@personavision/contract';

/**
 * The one heatmap that proves the headline, framed on a neutral mat with its caption and a link into Attention: the `.mat` of `#screen-verdict`. It is the only chart on this screen.
 *
 * A placeholder: it holds the slot and the class the prototype draws it with, and renders
 * nothing. **#108** fills this file, and no sibling section has to be touched for it.
 */
export function HeroEvidence({ run }: { run: Run }) {
  void run;
  return <div className="mat" data-section="hero-evidence" />;
}
