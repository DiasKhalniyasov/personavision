import type { Run, Session } from '@personavision/contract';
import type { AttentionArea } from './useAttentionAreas';
import { fixationsOnStep, reachedStep } from './useAttentionStepSessions';
import type { AttentionStepSessions, Fixation } from './useAttentionStepSessions';
import styles from './attentionPage.module.css';

/**
 * The "This step" panel of `#screen-attention`: what this step's aggregate amounts to, in
 * five readings.
 *
 * Every one of them is a **median across the people whose session was scored**, never one
 * person's numbers — which is what the screen's footnote says and what makes the panel
 * readable beside a heatmap drawn from all of them at once. A median is taken over the
 * sessions that actually reached this step: somebody who never got here contributes no
 * zero, because they did not look at this step briefly, they did not look at it at all.
 *
 * With an area isolated the first two readings narrow to that area, as the prototype's do,
 * and the last names it. The same rule holds one level down: the median is then over the
 * people who looked **inside that area**, because somebody who never looked there did not
 * give it a brief glance either. Counting them as zeros would print `0 median per session`
 * and `0.0 s` for an area four of nine people studied, and the same for one nobody ever saw
 * — the mistakable zero `docs/FLOW.md` section 3 forbids, where the honest reading is
 * `never` and `0%`. An area nobody looked at therefore reads *none* here, and the words for
 * it belong to the isolate caption.
 *
 * The earliest-fixated area is the artifact's own `timeToFirstFixationMs`, not a time this
 * screen works out from fixations.
 */

const seconds = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const count = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** The middle value, or the midpoint of the two middle ones. `null` for nothing to take. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** This session's fixations on this step, narrowed to one area when one is isolated. */
const lookedAt = (session: Session, step: string, isolated: string | null): Fixation[] => {
  const here = fixationsOnStep(session, step);
  return isolated === null ? here : here.filter((fixation) => fixation.aoiId === isolated);
};

/**
 * One list of looks per person the median is taken over: everybody who reached the step, or
 * — with an area isolated — everybody who looked inside it. Somebody who looked nowhere near
 * the isolated area is not a person who looked at it briefly.
 */
const perPerson = (
  sessions: readonly Session[],
  step: string,
  isolated: string | null,
): Fixation[][] => {
  const looks = sessions
    .filter((session) => reachedStep(session, step))
    .map((session) => lookedAt(session, step, isolated));
  return isolated === null ? looks : looks.filter((one) => one.length > 0);
};

/** The area of this step the audience fixated first, as the run's own metrics record it. */
export function earliestArea(areas: readonly AttentionArea[]): AttentionArea | null {
  let earliest: AttentionArea | null = null;
  for (const area of areas) {
    const at = area.metric?.timeToFirstFixationMs;
    // `null` is a never-fixated area, which is a result and not a very large time: it can
    // never be the earliest one.
    if (at === null || at === undefined) continue;
    const best = earliest?.metric?.timeToFirstFixationMs;
    if (best === undefined || best === null || at < best) earliest = area;
  }
  return earliest;
}

export interface ThisStepPanelProps {
  readonly step: Run['steps'][number];
  readonly sessions: AttentionStepSessions;
  readonly areas: readonly AttentionArea[];
  /** The area the screen isolates, or `null` for all of them. */
  readonly isolated: AttentionArea | null;
}

export function ThisStepPanel({ step, sessions, areas, isolated }: ThisStepPanelProps) {
  const isolatedId = isolated?.aoi.id ?? null;
  const perSession = perPerson(sessions.sessions, step.id, isolatedId);

  const fixations = median(perSession.map((looks) => looks.length));
  const dwellMs = median(
    perSession.map((looks) => looks.reduce((total, look) => total + look.durationMs, 0)),
  );
  const earliest = earliestArea(areas);
  const reading = sessions.status === 'loading';

  return (
    <dl className={styles.kv}>
      <dt>Fixations</dt>
      <dd className="num">
        {reading ? (
          <span className="faint">reading the sessions…</span>
        ) : fixations === null ? (
          'none'
        ) : (
          `${count.format(fixations)} median per session`
        )}
      </dd>

      <dt>Total dwell</dt>
      <dd className="num">
        {reading ? (
          <span className="faint">reading the sessions…</span>
        ) : dwellMs === null ? (
          'none'
        ) : (
          `${seconds.format(dwellMs / 1000)} s`
        )}
      </dd>

      <dt>Earliest area</dt>
      <dd>
        {earliest === null ? <span className="faint">nobody looked yet</span> : earliest.aoi.label}
      </dd>

      <dt>Reached this step</dt>
      <dd className="num">
        {reading ? (
          <span className="faint">reading the sessions…</span>
        ) : (
          `${sessions.reachedCount} of ${sessions.scoredSessionCount}`
        )}
      </dd>

      <dt>Isolated</dt>
      <dd>{isolated === null ? <span className="faint">all areas</span> : isolated.aoi.label}</dd>
    </dl>
  );
}
