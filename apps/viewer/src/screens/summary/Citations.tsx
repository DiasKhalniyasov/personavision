import { Link } from 'react-router';
import { HEATMAP_OVERLAYS } from '@personavision/contract';
import type { Citation, Run } from '@personavision/contract';
import { timeLabel } from '@/screens/replay/position';
import { stepLabel } from '@/screens/replay/runWords';
import { funnelLink, heatmapLink, sessionAtSecond } from '@/shell/paths';
import styles from './summary.module.css';

/**
 * The evidence under one recommendation, as links: the `.cites` of `#screen-results`.
 *
 * **Every link is built from structured fields and no sentence is ever parsed to find one**
 * (`docs/FLOW.md` sections 14 and 16). A citation is one of three closed shapes the
 * contract declares — a session with a millisecond offset, a heatmap region, a funnel step —
 * and each of them becomes a URL through the product's own builders in `shell/paths.ts`, so
 * which parameters a screen honours is answered in one place and a renamed route is one
 * edit there.
 *
 * The three destinations are the three the direction asks for: the session's replay **paused
 * on the second cited**, the heatmap of that version's step with the area isolated, and the
 * funnel **at that step**. The words on a chip are the reader's own — `S-07 · 0:48`,
 * `heatmap · Review · Place order`, `funnel · Review` — so a step and an area are named by
 * the label the run gives them rather than by the id the citation carries.
 *
 * The closing *simulated* chip is the prototype's, and it is not a link: the evidence a
 * recommendation rests on is simulated like every other figure on this screen, and saying so
 * beside the evidence is cheaper than asking the reader to remember the footnote.
 */

/**
 * Which overlay a heatmap citation opens on.
 *
 * A citation names a region and not a way of looking at it, so the screen picks the overlay
 * the citation is evidence *for*: **attention**, which is the overlay the product's own
 * heatmap draws (the Verdict's hero evidence) and the one a region cited as *where they
 * looked* is about. Typed against the contract's closed list, so an overlay renamed there
 * is a compile error here rather than a link the Heatmaps screen would ignore.
 */
const CITED_OVERLAY: (typeof HEATMAP_OVERLAYS)[number] = 'attention';

/** One citation as the screen renders it: where it leads, and what the chip reads. */
export interface CitationLink {
  readonly to: string;
  readonly label: string;
}

/** What this area of the page is called on screen — `Place order`, not `B-review-place`. */
const areaLabel = (run: Run, aoiId: string): string =>
  run.aois.find((area) => area.id === aoiId)?.label ?? aoiId;

/**
 * Where one citation leads, and what it reads.
 *
 * Exported so a test can hold a rendered chip to the URL the citation's own fields build,
 * rather than to a URL written out twice.
 */
export function citationLink(run: Run, citation: Citation): CitationLink {
  const { runId } = run;
  switch (citation.kind) {
    case 'session':
      // Seconds, as `t` means them and as the chip prints them: the contract stores the
      // moment in milliseconds and the replay opens paused on the second it names.
      return {
        to: sessionAtSecond(runId, citation.sessionId, citation.offsetMs / 1000),
        label: `${citation.sessionId} · ${timeLabel(citation.offsetMs)}`,
      };
    case 'heatmap': {
      const step = stepLabel(run, citation.step);
      const area = citation.aoiId === null ? null : areaLabel(run, citation.aoiId);
      return {
        to: heatmapLink(runId, citation.variant, citation.step, {
          overlay: CITED_OVERLAY,
          ...(citation.aoiId === null ? {} : { aoi: citation.aoiId }),
        }),
        label: `heatmap · ${step}${area === null ? '' : ` · ${area}`}`,
      };
    }
    case 'funnel':
      return {
        to: funnelLink(runId, { step: citation.stepId }),
        label: `funnel · ${stepLabel(run, citation.stepId)}`,
      };
  }
}

export function Citations({ run, citations }: { run: Run; citations: readonly Citation[] }) {
  return (
    <p className={`cites ${styles.cites}`} data-part="cites">
      {citations.map((citation, position) => {
        const { to, label } = citationLink(run, citation);
        // Keyed by position: the contract does not hold two citations of one recommendation
        // to being different from each other, and this list is never reordered.
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
