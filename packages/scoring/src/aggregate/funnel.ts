import type { FunnelSlice, Run, Session } from '@personavision/contract';
import { stepWalk, type FunnelSliceSpec } from './sessions.js';

/**
 * The funnel of one slice: one row per step in the order `run.json` declares them — how
 * many reached it, how many completed it, how many abandoned there and how many failed
 * there — with the step that lost the most people and the commonest stored reason among
 * them (`docs/FLOW.md` section 14, and the funnel rows of `#screen-funnel`).
 *
 * Two readings meet here, and which one answers which question is the whole of this file:
 *
 * - **the walk** says who got where. A step is *reached* when it appears among the
 *   session's screens, and *completed* when the session went on to reach the step declared
 *   after it — for the last step, when the session finished the task;
 * - **the session's own stored outcome** says what became of them. *Abandoned* and *failed*
 *   are `outcome.step` with `outcome.status`, never guessed from the walk, and the reason
 *   beside the biggest drop is a real `outcome.reason` off a real session rather than a
 *   phrase this code writes.
 *
 * Where the two could disagree the stored outcome wins: a session that went forward, came
 * back and gave up on a step it had already got past is **one** of completed, abandoned and
 * failed on that step — the one its outcome names — so the three never add up past the
 * people who reached it.
 */

/**
 * What the funnel is given: the run, for the steps and their order, and one slice with the
 * sessions left after its filter. **#289 settles the rest of this shape in this file** —
 * `index.ts` re-exports it by name, so adding a field costs that file no edit.
 */
export interface FunnelInput {
  /** The run, read for `steps` and their declared order and for nothing else. */
  readonly run: Run;
  /** The slice and its sessions, as `funnelSliceSpecs` enumerated them. */
  readonly slice: FunnelSliceSpec;
}

/** The signature #289 implements: the two funnel fields of a stored slice. */
export type FunnelBuilder = (input: FunnelInput) => Pick<FunnelSlice, 'funnel' | 'biggestDrop'>;

/**
 * A share of the aggregate, rounded the way the contract stores one: four decimal places,
 * so that the same sessions aggregate to the same file on every machine.
 */
const SHARE_PLACES = 4;
const roundShare = (value: number): number =>
  Math.round(value * 10 ** SHARE_PLACES) / 10 ** SHARE_PLACES;

/** One session, read once: the steps it touched and what its outcome says became of it. */
interface Walk {
  readonly reached: ReadonlySet<string>;
  readonly endedOn: string;
  readonly status: Session['outcome']['status'];
  readonly reason: string;
}

const walkOf = (session: Session): Walk => ({
  reached: new Set(stepWalk(session).map((span) => span.step)),
  endedOn: session.outcome.step,
  status: session.outcome.status,
  reason: session.outcome.reason,
});

/**
 * The commonest stored reason among the people a step lost, and on a tie the first of them
 * alphabetically — a tie broken by the order the sessions happened to arrive in would make
 * the file differ between two aggregations of the same run.
 */
const commonestReason = (lost: readonly Walk[]): string => {
  const tally = new Map<string, number>();
  for (const walk of lost) tally.set(walk.reason, (tally.get(walk.reason) ?? 0) + 1);
  const [commonest] = [...tally.entries()].sort(
    ([aReason, aCount], [bReason, bCount]) =>
      bCount - aCount || (aReason < bReason ? -1 : aReason > bReason ? 1 : 0),
  );
  return commonest?.[0] ?? '';
};

/**
 * The funnel and the biggest drop of one slice.
 *
 * The drop of a step is the people who reached it and did not complete it, which for every
 * step but the last is the step's own loss to the one after it and for the last is the
 * people who got to the end without finishing. **The last step can therefore be the biggest
 * drop**, which is the whole point on a slice where everybody got to the final screen and
 * gave up on it. On a tie the earliest step in the run's declared order carries it, so the
 * sentence under the funnel reads the same on every machine.
 */
export const funnelOfSlice: FunnelBuilder = ({ run, slice }) => {
  const walks = slice.sessions.map(walkOf);
  const steps = run.steps.map((step) => step.id);

  const rows = steps.map((step, index) => {
    const nextStep = steps[index + 1];
    const reached = walks.filter((walk) => walk.reached.has(step));
    const endedHere = (walk: Walk, status: Walk['status']): boolean =>
      walk.endedOn === step && walk.status === status;
    const completed = (walk: Walk): boolean =>
      nextStep === undefined
        ? walk.status === 'success'
        : walk.reached.has(nextStep) && !endedHere(walk, 'abandoned') && !endedHere(walk, 'failed');
    const lost = reached.filter((walk) => !completed(walk));

    return {
      lost,
      row: {
        step,
        reached: reached.length,
        completed: reached.length - lost.length,
        abandoned: reached.filter((walk) => endedHere(walk, 'abandoned')).length,
        failed: reached.filter((walk) => endedHere(walk, 'failed')).length,
        reachedShare: walks.length === 0 ? 0 : roundShare(reached.length / walks.length),
      },
    };
  });

  const worst = rows.reduce<(typeof rows)[number] | undefined>(
    (deepest, row) =>
      deepest === undefined || row.lost.length > deepest.lost.length ? row : deepest,
    undefined,
  );

  return {
    funnel: rows.map((row) => row.row),
    biggestDrop:
      worst === undefined || worst.lost.length === 0
        ? null
        : {
            step: worst.row.step,
            left: worst.lost.length,
            ofReached: worst.row.reached,
            reason: commonestReason(worst.lost),
          },
  };
};
