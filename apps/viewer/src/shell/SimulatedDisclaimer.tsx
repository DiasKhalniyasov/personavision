import type { Run } from '@personavision/contract';
import { useCurrentRunId, useOptionalRun } from './useRun';

/**
 * The line every results screen ends with: the numbers rank versions for this audience and
 * are not an estimate of conversion lift (`docs/FLOW.md` section 3) — the closing
 * `.footnote` of `#screen-verdict`.
 *
 * One component, reused by the Summary, Verdict, Score breakdown, Attention, Sessions and
 * Session replay screens, so the sentence is written once. The audience it names and the
 * calibration figures it carries are the run's own, read through the shell's single read of
 * it: the claim and the number behind the claim are on the screen together.
 *
 * **What the figures are for depends on the run, so the middle clause does.** A run with two
 * versions ranks those two; a run with one has nothing to compare and ranks *what to fix for
 * these people*, which is `#screen-results`' own wording for it (`docs/FLOW.md` section
 * 14.1). The claim that matters is the same either way and is never dropped: these numbers
 * are not a conversion-lift estimate.
 */

/** The two versions a test compares. One version is a reading; it is not a comparison. */
const COMPARISON = 2;

/** What this screen's figures are for, on a run with two versions and on a run with one. */
const ranks = (run: Run | null): string =>
  run === null || run.variants.length >= COMPARISON
    ? 'It ranks your two versions and locates friction'
    : 'It ranks what to fix for these people';

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
      {run === null ? '' : ` — ${run.audience.name}`}. {ranks(run)}; it is not a conversion-lift
      estimate and does not replace a test on real customers.
      {run === null ? '' : ` ${calibrationSentence(run.calibration)}`}
    </p>
  );
}
