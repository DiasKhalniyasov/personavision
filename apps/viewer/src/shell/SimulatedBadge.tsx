import type { Run } from '@personavision/contract';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * `Simulated audience · gaze similarity 0.68` — the persistent badge of `docs/FLOW.md`
 * section 3, in the chrome of every screen. The word *Simulated* is on screen wherever the
 * product shows a figure.
 *
 * The number is the run's own `calibration.cc`, and the three benchmark metrics are **text
 * in the document**, not a `title` tooltip: a reader who cannot hover still has them, and
 * a run with no calibration recorded says so in words rather than showing a zero.
 */

const figure = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** The product's copy is English, so a figure reads the same in the demo and in a test. */
const metric = (value: number | null): string =>
  value === null ? 'not recorded' : figure.format(value);

export function SimulatedBadge({ calibration }: { calibration: Run['calibration'] }) {
  const similarity = calibration?.cc ?? null;
  const headline =
    similarity === null
      ? 'Simulated audience · no calibration recorded'
      : `Simulated audience · gaze similarity ${figure.format(similarity)}`;

  const detail =
    calibration === null
      ? 'Your audience is simulated. No calibration against real human gaze has been recorded for this test, so how human-like its attention is on this run is not known.'
      : `Your audience is simulated. Similarity to real human gaze on the ${calibration.benchmark} benchmark: CC ${metric(calibration.cc)} / NSS ${metric(calibration.nss)} / ScanMatch ${metric(calibration.scanMatch)}.`;

  return (
    <Tooltip>
      <TooltipTrigger className="sim-badge" data-shell="simulated-badge">
        <i className="dot" aria-hidden="true" />
        {headline}
        {/* The figures as text, so they are not hover-only. */}
        <span className="sr-only">{detail}</span>
      </TooltipTrigger>
      <TooltipContent aria-hidden="true">{detail}</TooltipContent>
    </Tooltip>
  );
}

/** The badge while the run is still being read: the same shape, saying nothing yet. */
export function SimulatedBadgePlaceholder() {
  return (
    <span className="sim-badge" data-shell="simulated-badge" aria-hidden="true">
      <i className="dot" />
      Simulated audience
    </span>
  );
}
