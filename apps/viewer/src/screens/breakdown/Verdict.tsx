import { Link } from 'react-router';
import type { Run } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { paths } from '@/shell/paths';
import { evidenceUrl } from '@/screens/verdict/evidenceLink';
import { variantName } from '@/screens/replay/runWords';
import { comparableSeedGroups, points, scoresOfTask } from './scoreBand';
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

/**
 * How many of the seed groups that could be compared put the harder version higher.
 *
 * The count is the run's own; what is said beside it is how many there were. A run of real
 * sessions carries no seed at all, so there is nothing to pair — and `0 of 0` must read as
 * *nothing to compare* and not as *no group agreed*, which is a result.
 */
const agreement = (count: number, comparable: number): string => {
  if (comparable === 0) return 'No seed groups to compare';
  return `${count} of ${comparable} seed group${comparable === 1 ? '' : 's'} put it higher`;
};

/**
 * Whether the bands say anything at all, and what.
 *
 * `bandsDisjoint` is stored as `false` for a run with only one scored version, where there
 * was never a second band — so the three readings are kept apart here. Saying *the bands
 * overlap* about a comparison that was never made is as wrong as calling an overlap a win.
 */
const bandsFlag = (compared: boolean, disjoint: boolean): string => {
  if (!compared) return 'Only one version was scored — there is no second band to compare';
  return disjoint
    ? 'The bands do not overlap'
    : 'The bands overlap — this test did not separate the two versions';
};

/** The two version ids the tokens carry a colour for; a third reads as information. */
const VARIANT_TAGS = ['a', 'b'];

const variantTag = (variant: string): string => {
  const word = variant.toLowerCase();
  return VARIANT_TAGS.includes(word) ? `tag-${word}` : 'tag-info';
};

export function Verdict({ run }: { run: Run }) {
  const { runId, verdict } = run;
  const harder = variantName(run, verdict.harderVariant);
  // Two versions with a score for this run's task, or there was no comparison to report.
  const compared = scoresOfTask(run).length >= 2;
  // A run that separated nothing names no harder version: the tie-break still fills the
  // field, and a coloured chip beside a sentence saying neither is harder would contradict
  // it in the one place a reader looks first.
  const named = compared && verdict.gapPoints > 0;
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
      {named && <span className="delta num">+{points(verdict.gapPoints)}</span>}
      {/* The version is named by its own name and its own colour — the sentence beside it
          is the pipeline's and calls it by its id. */}
      {named && <span className={`tag ${variantTag(verdict.harderVariant)}`}>{harder}</span>}
      <span className="verdict-text">{verdict.sentence}</span>
      <span className="verdict-flags">
        <span className={`tag ${compared && verdict.bandsDisjoint ? 'tag-success' : 'tag-high'}`}>
          {bandsFlag(compared, verdict.bandsDisjoint)}
        </span>
        <span className="tag tag-info">
          {agreement(verdict.seedGroupsAgreeing, comparableSeedGroups(run))}
        </span>
      </span>
      <Button asChild size="sm">
        <Link to={attention}>See where attention went</Link>
      </Button>
    </div>
  );
}
