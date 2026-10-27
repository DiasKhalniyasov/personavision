import type { Run } from '@personavision/contract';
import { useCurrentRunId, useOptionalRun } from './useRun';

/**
 * The line every results screen ends with: the numbers rank versions for this audience and
 * are not an estimate of conversion lift (`docs/FLOW.md` section 3) — the closing
 * `.footnote` of `#screen-verdict`.
 *
 * One component, reused by the Verdict, Score breakdown, Attention, Sessions and Session
 * replay screens, so the sentence is written once. The audience it names and the
 * calibration figures it carries are the run's own, read through the shell's single read of
 * it: the claim and the number behind the claim are on the screen together.
 */

const figure = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** A figure the run does not record says so, rather than reading as a zero. */
const metric = (value: number | null): string =>
  value === null ? 'not recorded' : figure.format(value);

/** What is behind the claim: the benchmark figures, or that none are recorded. */
const calibrationSentence = (calibration: Run['calibration']): string =>
  calibration === null
    ? 'No calibration against real human gaze is recorded for this test.'
    : `Similarity to real human gaze on the ${calibration.benchmark} benchmark: CC ${metric(calibration.cc)} / NSS ${metric(calibration.nss)} / ScanMatch ${metric(calibration.scanMatch)}.`;

/**
 * `run` is for the two public pages, which are about a test their route does not name:
 * the landing page (#123) and the demo (#124) both read the committed example run and
 * hand it here, so the sentence names that run's audience rather than no audience at all.
 * Every signed-in screen leaves it out and the route answers for it, as before.
 */
export function SimulatedDisclaimer({ run: given }: { run?: Run | null }) {
  // The run the route is about, and no other: on a route about no test this names no
  // audience rather than the workspace's most recent one.
  const state = useOptionalRun(useCurrentRunId());
  const run = given ?? (state?.status === 'ready' ? state.run : null);

  return (
    <p className="footnote" data-shell="simulated-disclaimer">
      Every figure on this screen is <b>simulated</b>, for the audience named at the top
      {run === null ? '' : ` — ${run.audience.name}`}. It ranks your two versions and locates
      friction; it is not a conversion-lift estimate and does not replace a test on real customers.
      {run === null ? '' : ` ${calibrationSentence(run.calibration)}`}
    </p>
  );
}
