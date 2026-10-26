import { Link } from 'react-router';
import type { Run } from '@personavision/contract';
import { paths } from '@/shell/paths';
import styles from './doors.module.css';
import { evidenceUrl } from './evidenceLink';

/**
 * The four doors to the detail — Score breakdown, Attention, People, Watch one person.
 *
 * The `.doors` of `#screen-verdict`, and the whole mechanism by which the lead screen can
 * be quiet without the product losing anything (`docs/FLOW.md` section 2, step 4):
 * everything taken off this screen is one click away, and each door says in a sentence a
 * non-technical reader understands what is behind it. A door whose label does not say what
 * it opens defeats the point, so none of them is named after a screen alone.
 *
 * Every destination comes from `shell/paths`, and the two that need a version and a step
 * take them from the run's own `verdict.heroEvidence` — the moment the verdict turns on —
 * rather than from a choice made here. "Watch one person" opens the first person the run
 * lists: the viewer picks nobody on merit, and the People door beside it is how a reader
 * chooses someone else.
 */

const people = (count: number): string =>
  count === 1 ? '1 simulated person' : `${count} simulated people`;

export function DetailDoors({ run }: { run: Run }) {
  const { runId } = run;
  const hero = run.verdict.heroEvidence;
  // The same place a finding pointing at this step would open, area included: the door is
  // not a coarser link to the evidence than the finding above it.
  const attention =
    evidenceUrl(runId, {
      screen: 'attention',
      params: {
        variant: hero.variant,
        step: hero.step,
        ...(hero.aoiId === null ? {} : { aoi: hero.aoiId }),
      },
    }) ?? paths.attention(runId, hero.variant, hero.step);
  const firstPerson = run.sessionIds[0];

  return (
    <div className={`doors ${styles.doors}`} data-section="detail-doors">
      <Door
        blurb="How sure is this, and what drove it? The friction score, its four parts and the run-to-run spread."
        name="Score breakdown"
        to={paths.breakdown(runId)}
      />
      <Door
        blurb="Every heatmap, the order attention moved in, and the numbers per area of the page."
        name="Attention"
        to={attention}
      />
      <Door
        blurb={`All ${people(run.sessionIds.length)}: what each one did, how long it took and where it ended.`}
        name="People"
        to={paths.sessions(runId)}
      />
      <Door
        blurb="Replay a single person's gaze, scrolling, clicks and the moment they gave up."
        name="Watch one person"
        to={firstPerson === undefined ? null : paths.session(runId, firstPerson)}
      />
    </div>
  );
}

/**
 * One door: what is behind it, in a sentence. `to` is `null` when there is nothing to open
 * — a test with no people has nobody to watch — and the card then says so instead of
 * offering a click that leads nowhere.
 */
function Door({ name, blurb, to }: { name: string; blurb: string; to: string | null }) {
  if (to === null) {
    return (
      <div className={styles.door}>
        <h3>{name}</h3>
        <p>{blurb}</p>
        <span className={styles.closed}>Nobody was simulated in this test</span>
      </div>
    );
  }
  return (
    <Link className={styles.door} to={to}>
      <h3>{name}</h3>
      <p>{blurb}</p>
      <span className={styles.more}>Open →</span>
    </Link>
  );
}
