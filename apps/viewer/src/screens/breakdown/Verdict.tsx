import { Link } from 'react-router';
import type { Run } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { paths } from '@/shell/paths';
import { evidenceUrl } from '@/screens/verdict/evidenceLink';
import { variantName } from '@/screens/replay/runWords';
import { points } from './scoreBand';
import './BreakdownPage.css';

/**
 * The verdict line under the two cards: the gap in points, which version is the harder one,
 * how many seed groups agreed, and whether the ± 1σ bands came apart.
 *
 * The `.verdict` row of `#screen-breakdown`. The **sentence is the pipeline's own** —
 * `verdict.sentence`, rendered as it was written — and the three figures beside it are the
 * stored `gapPoints`, `seedGroupsAgreeing` and `bandsDisjoint`. Nothing here compares two
 * scores or counts a seed group: a screen that worked the comparison out a second time
 * could disagree with the sentence printed next to it.
 *
 * **A result that did not separate must not read like a clean win.** `bandsDisjoint` is
 * rendered as a statement of its own, in its own colour, rather than left inside the
 * sentence — so the reader is told the bands overlap by the screen and not only by a clause
 * two lines long.
 */

/** How many seed groups put the harder version higher, from the stored count. */
const agreement = (count: number): string => {
  if (count === 0) return 'No seed group put it higher';
  return count === 1 ? '1 seed group put it higher' : `${count} seed groups put it higher`;
};

export function Verdict({ run }: { run: Run }) {
  const { runId, verdict } = run;
  const harder = variantName(run, verdict.harderVariant);
  const hero = verdict.heroEvidence;
  // The same destination as the Verdict screen's Attention door, area included: the two
  // ways into the heatmap are not two different places.
  const attention =
    evidenceUrl(runId, {
      screen: 'attention',
      params: {
        variant: hero.variant,
        step: hero.step,
        ...(hero.aoiId === null ? {} : { aoi: hero.aoiId }),
      },
    }) ?? paths.attention(runId, hero.variant, hero.step);

  return (
    <div className="verdict" data-section="verdict" data-disjoint={String(verdict.bandsDisjoint)}>
      {/* A gap of nothing is not a gap: the sentence then says neither version is harder. */}
      {verdict.gapPoints > 0 && <span className="delta num">+{points(verdict.gapPoints)}</span>}
      {/* The version is named by its own name and its own colour — the sentence beside it
          is the pipeline's and calls it by its id. */}
      <span className={`tag tag-${verdict.harderVariant.toLowerCase()}`}>{harder}</span>
      <span className="verdict-text">{verdict.sentence}</span>
      <span className="verdict-flags">
        <span className={`tag ${verdict.bandsDisjoint ? 'tag-success' : 'tag-high'}`}>
          {verdict.bandsDisjoint
            ? 'The bands do not overlap'
            : 'The bands overlap — this test did not separate the two versions'}
        </span>
        <span className="tag tag-info">{agreement(verdict.seedGroupsAgreeing)}</span>
      </span>
      <Button asChild size="sm">
        <Link to={attention}>See where attention went</Link>
      </Button>
    </div>
  );
}
