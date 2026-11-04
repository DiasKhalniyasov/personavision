import type { ReactNode } from 'react';
import type { Run } from '@personavision/contract';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { AudienceLine } from './AudienceLine';
import { CompletionFigures } from './CompletionFigures';
import { DetailDoors } from './DetailDoors';
import { ExcludedBanner } from './ExcludedBanner';
import { HeadlineFindings } from './HeadlineFindings';
import { Headline } from './Headline';
import { HeroEvidence } from './HeroEvidence';
import { Reasons } from './Reasons';

/**
 * The Verdict: which version should I ship, for my audience.
 *
 * The lead screen, and the one the demo ends on. It is deliberately quiet — one headline
 * sentence, two completion figures, one or two reasons, **one** heatmap, at most three
 * findings, and the doors to the detail. Nothing else: no area-of-interest table, no
 * scanpath, no component bars, no session list, no friction score (`docs/FLOW.md`
 * sections 3 and 5).
 *
 * This file owns the composition and the page rhythm — three strips, separated by
 * whitespace rather than rules, as `#screen-verdict` draws them. Each section is its own
 * file so that #14, #15, #16 and #108 fill different ones at the same time.
 *
 * **It is the two-version lead of the Summary screen, mounted whole** (#266): a run with two
 * versions is a path-2 test, and its lead is this composition unchanged, with the ranked
 * recommendations under its findings (`docs/FLOW.md` section 14.1). The two slots are how
 * that happens without this screen being forked — `above` is the line a run says when more
 * than a fifth of its sessions were our own automation failing, and `under` is the
 * recommendations block. Both are empty on the Verdict's own route, and the composition and
 * its rhythm stay this file's.
 */
export function VerdictPage({
  above,
  run,
  under,
}: {
  /** Mounted at the top of the first strip, above the audience line. */
  above?: ReactNode;
  run: Run;
  /** Mounted under the findings, above the doors. */
  under?: ReactNode;
}) {
  return (
    <>
      <div className="strip strip-sm">
        <div className="wrap">
          {above}
          <AudienceLine run={run} />
          <ExcludedBanner run={run} />
          <Headline run={run} />
          <CompletionFigures run={run} />
          <Reasons run={run} />
        </div>
      </div>

      {/* The single piece of evidence on this screen, in the one tinted band. */}
      <div className="strip strip-tint">
        <div className="wrap">
          <HeroEvidence run={run} />
        </div>
      </div>

      <div className="strip">
        <div className="wrap">
          <HeadlineFindings run={run} />
          {under}
          <DetailDoors run={run} />
          <SimulatedDisclaimer />
        </div>
      </div>
    </>
  );
}
