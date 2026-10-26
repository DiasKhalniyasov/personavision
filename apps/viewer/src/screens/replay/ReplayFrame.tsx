import { useState } from 'react';
import type { Session } from '@personavision/contract';
import type { TimelineMoment } from '@/session/index.js';
import { GazeOverlay } from './GazeOverlay';
import { frameGeometry, gazeTrail } from './position';
import styles from './replay.module.css';
import type { Capture } from './runWords';

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
  //
  // What is remembered is **which** screenshot failed, not that one did: scrubbing on to
  // the next screen asks for a different file, and that one deserves its own chance.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);

  if (capture === null || screenshotUrl === null) {
    return (
      <div className={`${styles.frame} ${styles.dim}`} id="rp-frame">
        <div className={styles.page} id="rp-page">
          <p className={styles.missing}>
            This test holds no screenshot of the {screenLabel} screen on {variantName}, so there is
            nothing to show the gaze over.
          </p>
        </div>
      </div>
    );
  }

  const broken = brokenUrl === screenshotUrl;
  const scrollY = moment.scrollY ?? 0;
  const geometry = frameGeometry(capture, scrollY);
  const trail = gazeTrail(session, moment, capture);

  return (
    <div
      className={[styles.frame, geometry.portrait ? styles.mobile : '', styles.dim].join(' ')}
      id="rp-frame"
    >
      <div className={styles.page} id="rp-page">
        {broken ? (
          <p className={styles.missing}>
            The screenshot of the {screenLabel} screen could not be loaded. The gaze below is this
            person&rsquo;s own, at {scrollY} pixels down that page.
          </p>
        ) : (
          <img
            src={screenshotUrl}
            alt={`The ${screenLabel} screen of ${variantName} as this person saw it`}
            style={{ top: `${geometry.pageTopPct}%`, height: `${geometry.pageHeightPct}%` }}
            onError={() => setBrokenUrl(screenshotUrl)}
          />
        )}
      </div>
      <GazeOverlay trail={trail} />
      {geometry.foldTopPct === null ? null : (
        <div className={styles.fold} style={{ top: `${geometry.foldTopPct}%` }} data-fold>
          <span>fold</span>
        </div>
      )}
    </div>
  );
}
