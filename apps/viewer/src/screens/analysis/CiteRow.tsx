import { Link } from 'react-router';
import type { Citation, Run } from '@personavision/contract';
import { citationLink } from '@/screens/summary/Citations';
import styles from './analysis.module.css';

/**
 * The evidence under one claim of the write-up, as links: the `.cites` row of
 * `#screen-analysis`.
 *
 * **This row renders citations; it never parses a sentence to find one.** A claim's prose is
 * printed as prose — a session id a paragraph happens to mention is words, not a link — and
 * every chip here is one of the three closed shapes the contract declares, turned into a URL
 * by the product's own builders in `shell/paths.ts` (`docs/FLOW.md` sections 14 and 16).
 *
 * The three destinations are the three the direction asks for: a session and a second to
 * that replay **paused on that frame**, a heatmap region to that version's step with the
 * area isolated and the overlay it is evidence for, and a funnel step to the funnel **at
 * that step**. The order of the chips is the write-up's own — the generator stores them
 * funnel first, then the people, then the region, as the prototype draws them — because a
 * screen that re-sorted them would be a screen with an opinion about the evidence.
 *
 * Where each chip leads and what it reads is `screens/summary/Citations.ts`'s `citationLink`,
 * imported rather than written again: the Summary's recommendation chips and these are the
 * same citations of the same run, and two copies of that mapping would be two answers to
 * *"which second does S-17 · 0:48 open on"*. What belongs to this screen is the row's own
 * place in a prose column, which is this file and `analysis.module.css`.
 *
 * The closing *simulated* chip is the prototype's and is not a link: every figure in the
 * claim above it is simulated, and saying so beside the evidence is cheaper than asking the
 * reader to carry the footnote down the page.
 */
export function CiteRow({ run, citations }: { run: Run; citations: readonly Citation[] }) {
  return (
    <p className={`cites ${styles.cites}`} data-part="cites">
      {citations.map((citation, position) => {
        const { to, label } = citationLink(run, citation);
        // Keyed by position: the contract does not hold two citations of one claim to being
        // different from each other, and this list is never reordered.
        return (
          <Link key={position} to={to}>
            {label}
          </Link>
        );
      })}
      <span>simulated</span>
    </p>
  );
}
