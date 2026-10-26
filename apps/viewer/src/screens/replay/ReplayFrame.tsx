import { useState } from 'react';
import type { Session } from '@personavision/contract';
import type { TimelineMoment } from '@/session/index.js';
import { GazeOverlay } from './GazeOverlay';
import { frameGeometry, gazeTrail } from './position';
import type { Capture } from './position';

/**
 * `#rp-frame`: the page as this person saw it at the scrubber's moment.
 *
 * The frame holds **one viewport** of the device the screenshot was captured on, and the
 * captured page slides behind it to that screen's `scrollY` — so the frame is a position in
 * the session, not a picture of a whole page. The fold is drawn where the first viewport
 * ends, measured from the same offset, and the gaze layer sits on top in register with
 * both, because all three are placed as percentages of the same box.
 */
export function ReplayFrame({
  session,
  moment,
  capture,
  screenshotUrl,
  screenLabel,
  variantName,
}: {
  session: Session;
  moment: TimelineMoment;
  /** `null` when the run holds no capture of this screen's step. */
  capture: Capture | null;
  screenshotUrl: string | null;
  /** The step's own label from the run, for the screenshot's alternative text. */
  screenLabel: string;
  variantName: string;
}) {
  // A screenshot that will not load is stated in words rather than left blank: the seed
  // run's screenshots are rendered placeholders, and an empty frame would read as "the
  // agent saw nothing", which is the one thing this screen must never say.
  const [broken, setBroken] = useState(false);

  if (capture === null || screenshotUrl === null) {
    return (
      <div className="frame dim" id="rp-frame">
        <div className="page" id="rp-page">
          <p className="missing">
            This test holds no screenshot of the {screenLabel} screen on {variantName}, so there is
            nothing to show the gaze over.
          </p>
        </div>
      </div>
    );
  }

  const scrollY = moment.scrollY ?? 0;
  const geometry = frameGeometry(capture, scrollY);
  const trail = gazeTrail(session, moment, capture);

  return (
    <div className={geometry.portrait ? 'frame is-mobile dim' : 'frame dim'} id="rp-frame">
      <div className="page" id="rp-page">
        {broken ? (
          <p className="missing">
            The screenshot of the {screenLabel} screen could not be loaded. The gaze below is this
            person&rsquo;s own, at {scrollY} pixels down that page.
          </p>
        ) : (
          <img
            src={screenshotUrl}
            alt={`The ${screenLabel} screen of ${variantName} as this person saw it`}
            style={{ top: `${geometry.pageTopPct}%`, height: `${geometry.pageHeightPct}%` }}
            onError={() => setBroken(true)}
          />
        )}
      </div>
      <GazeOverlay trail={trail} />
      {geometry.foldTopPct === null ? null : (
        <div className="fold" style={{ top: `${geometry.foldTopPct}%` }} data-fold>
          <span>fold</span>
        </div>
      )}
    </div>
  );
}
