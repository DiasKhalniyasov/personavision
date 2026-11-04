import styles from './landing.module.css';

/**
 * *Where the heatmaps come from*: the four stages, drawn, on the signed-out front page.
 *
 * The owner's complaint this answers (#431, from their input on #1) is that the page says
 * what the product does and never says where its numbers come from. So this is the one
 * section of the page that is about the machinery, and the only section whose whole point
 * is that **every claim on it is true of this repository today**.
 *
 * Two of those claims are load-bearing and easy to inflate, so they are pinned by
 * `HowAttentionIsMeasured.test.tsx` rather than by care:
 *
 * 0. **Stage 1 claims only what it records.** `tools/eyetrack` holds two tools, and the
 *    second of them drives a live site, so a sentence denying that anything there touches
 *    a live page would be contradicted by the directory the link lands on. The stage says
 *    what the recordings behind this product are — gaze over screenshots, one at a time,
 *    in the shape `packages/calibration` reads — and promises nothing about live pages.
 * 1. **No model fitted on human gaze ships today.** `packages/calibration` is where the
 *    comparison against human eye tracking lives, and it can fit the engine's
 *    configuration — hence *can be used to fit*, which is the owner's own phrase and is
 *    asserted verbatim. What the package measures today is a committed synthetic stand-in
 *    corpus: `docs/calibration/report.md` says so in its own heading and
 *    `packages/calibration/src/dataset/manifest.json` still records
 *    `verifiedAgainstArchive: false`.
 * 2. **No human-likeness figure belongs here.** The header badge is where a number lives,
 *    with the run's own calibration block behind it. A test asserts this section prints no
 *    figure at all, so a later edit cannot quietly put one back.
 *
 * The drawings are inline SVG — no image file, no third-party host, nothing fetched — and
 * carry no colour of their own: every one comes from a class in `landing.module.css` which
 * names a token of `docs/design/tokens.css`, which is what makes them read in the dark
 * theme. Geometry lives in SVG attributes rather than in the stylesheet, because the
 * stylesheet may restate no unit (`tests/skeleton.test.ts`).
 *
 * There are no connector arrows between the stages. A left-to-right arrow drawn between
 * the cards would point the wrong way the moment the row stacks at 390px, and the numbered
 * stages already carry the order; the one arrow on the section is inside stage 2's drawing,
 * where it is the content — recorded gaze going into a model — and not decoration.
 *
 * Nothing here is read from a run, so the section has no loading and no error state, and
 * nothing animates: it is complete and still on first paint at any motion setting.
 */

/** The eye tracker of #430, which stage 1 is a true claim about because it exists. */
export const EYETRACKER_URL =
  'https://github.com/DiasKhalniyasov/personavision/tree/main/tools/eyetrack';

/** The phrase the owner fixed on stage 2. A test asserts it, verbatim, is on the page. */
export const CAN_BE_USED_TO_FIT = 'can be used to fit';

/** The section's own heading, exported because two suites place the section by it. */
export const MEASURED_HEADING = 'Where the heatmaps come from';

/**
 * A real person at a screen, their gaze landing on it.
 *
 * The screen is a screenshot, which is what the tool actually shows — one at a time, at a
 * fixed size — so the drawing does not depict a live site being instrumented.
 */
function RecordedDrawing() {
  return (
    <svg
      className={styles.drawing}
      viewBox="0 0 96 56"
      role="img"
      aria-label="A person at a screen showing a screenshot, with two gaze marks on the screenshot and the gaze drawn from their eyes."
      focusable="false"
    >
      <rect className={styles.drawFrame} x="4" y="6" width="50" height="36" rx="4" />
      <line className={styles.drawRule} x1="11" y1="14" x2="35" y2="14" />
      <line className={styles.drawRule} x1="11" y1="20" x2="46" y2="20" />
      <line className={styles.drawRule} x1="11" y1="33" x2="30" y2="33" />
      <line className={styles.drawGaze} x1="68" y1="21" x2="30" y2="14" strokeDasharray="4 3" />
      <line className={styles.drawGaze} x1="68" y1="23" x2="22" y2="33" strokeDasharray="4 3" />
      <circle className={styles.drawFixation} cx="30" cy="14" r="4" />
      <circle className={styles.drawFixation} cx="22" cy="33" r="3" />
      <circle className={styles.drawInk} cx="76" cy="20" r="9" />
      <path className={styles.drawInk} d="M63 48a13 13 0 0 1 26 0z" />
    </svg>
  );
}

/**
 * Recorded gaze going into a small model: the honest half of stage 2's picture, where the
 * arrow is the content. What comes out of the model is drawn as a prediction, not as a
 * score, because there is no score against human gaze to draw.
 */
function TaughtDrawing() {
  return (
    <svg
      className={styles.drawing}
      viewBox="0 0 96 56"
      role="img"
      aria-label="Recorded gaze marks on the left, an arrow, and a small model of linked nodes on the right."
      focusable="false"
    >
      <rect className={styles.drawFrame} x="4" y="10" width="30" height="30" rx="4" />
      <circle className={styles.drawFixation} cx="13" cy="19" r="3" />
      <circle className={styles.drawFixation} cx="25" cy="25" r="3" />
      <circle className={styles.drawFixation} cx="16" cy="33" r="3" />
      <path className={styles.drawGaze} d="M13 19 25 25 16 33" fill="none" />
      <path className={styles.drawArrow} d="M39 25h14" fill="none" />
      <path className={styles.drawArrow} d="M49 21l5 4-5 4" fill="none" />
      <line className={styles.drawNodeLink} x1="66" y1="14" x2="82" y2="25" />
      <line className={styles.drawNodeLink} x1="66" y1="25" x2="82" y2="25" />
      <line className={styles.drawNodeLink} x1="66" y1="36" x2="82" y2="25" />
      <circle className={styles.drawNode} cx="66" cy="14" r="4" />
      <circle className={styles.drawNode} cx="66" cy="25" r="4" />
      <circle className={styles.drawNode} cx="66" cy="36" r="4" />
      <circle className={styles.drawNode} cx="83" cy="25" r="5" />
    </svg>
  );
}

/** Three generated people walking a page in a browser. */
function GeneratedDrawing() {
  return (
    <svg
      className={styles.drawing}
      viewBox="0 0 96 56"
      role="img"
      aria-label="Three generated people in front of a browser window, walking the same page."
      focusable="false"
    >
      <rect className={styles.drawFrame} x="30" y="4" width="62" height="34" rx="4" />
      <line className={styles.drawRule} x1="30" y1="12" x2="92" y2="12" />
      <line className={styles.drawRule} x1="37" y1="20" x2="64" y2="20" />
      <line className={styles.drawRule} x1="37" y1="27" x2="78" y2="27" />
      <circle className={styles.drawInk} cx="12" cy="10" r="6" />
      <path className={styles.drawInk} d="M3 30a9 9 0 0 1 18 0z" />
      <circle className={styles.drawInk} cx="30" cy="20" r="6" />
      <path className={styles.drawInk} d="M21 40a9 9 0 0 1 18 0z" />
      <circle className={styles.drawInk} cx="48" cy="30" r="6" />
      <path className={styles.drawInk} d="M39 50a9 9 0 0 1 18 0z" />
    </svg>
  );
}

/** What comes out: heat where the audience looked, and one person's numbered path over it. */
function ResultDrawing() {
  return (
    <svg
      className={styles.drawing}
      viewBox="0 0 96 56"
      role="img"
      aria-label="A page with three warm patches where the audience looked, and a numbered path joining them."
      focusable="false"
    >
      <rect className={styles.drawFrame} x="4" y="6" width="88" height="44" rx="4" />
      <circle className={styles.drawHeatLow} cx="70" cy="36" r="13" />
      <circle className={styles.drawHeatMid} cx="30" cy="34" r="12" />
      <circle className={styles.drawHeatHigh} cx="26" cy="17" r="10" />
      <path className={styles.drawGaze} d="M26 17 30 34 70 36" fill="none" />
      <circle className={styles.drawFixation} cx="26" cy="17" r="4" />
      <circle className={styles.drawFixation} cx="30" cy="34" r="4" />
      <circle className={styles.drawFixation} cx="70" cy="36" r="4" />
    </svg>
  );
}

/** One stage: its number, its name, its drawing and what it actually does. */
type Stage = {
  readonly name: string;
  readonly drawing: () => React.JSX.Element;
  readonly body: React.ReactNode;
};

const STAGES: readonly Stage[] = [
  {
    name: 'Real people, recorded locally',
    drawing: RecordedDrawing,
    body: (
      <>
        A webcam eye tracker you run on your own machine records where real people look at
        screenshots of a site, on a desktop or a phone &mdash; one screenshot at a time, in the
        shape <code className={styles.stagePath}>packages/calibration</code> reads. Nothing leaves
        your computer.{' '}
        <a className={styles.stageLink} href={EYETRACKER_URL} target="_blank" rel="noreferrer">
          Try the eye tracker
        </a>
      </>
    ),
  },
  {
    name: 'Their gaze teaches the agents',
    drawing: TaughtDrawing,
    body: (
      <>
        Those recordings become few-shot gaze examples a test is shown, and {CAN_BE_USED_TO_FIT}{' '}
        small models that reproduce how real people look at a page.{' '}
        <strong className={styles.stageStress}>No model fitted on human gaze ships today.</strong>{' '}
        The comparison against human eye tracking lives in{' '}
        <code className={styles.stagePath}>packages/calibration</code>, and what it measures today
        is a committed synthetic stand-in corpus &mdash; so this section claims no measured result
        against real human gaze, and prints no figure.
      </>
    ),
  },
  {
    name: 'Generated people test the site',
    drawing: GeneratedDrawing,
    body: (
      <>
        Muse Spark, which is strong at reading screens, drives a generated audience through the site
        in real browsers, on mobile and on desktop.
      </>
    ),
  },
  {
    name: 'What you get',
    drawing: ResultDrawing,
    body: (
      <>
        Heatmaps, attention and a path per person, aggregated across the audience &mdash; and Muse
        Wonder&rsquo;s analysis, citing the moments it relies on.
      </>
    ),
  },
];

export function HowAttentionIsMeasured() {
  return (
    <section className={styles.measured} data-section="landing-measured">
      <h2 className={styles.howHeading}>{MEASURED_HEADING}</h2>
      <p className={styles.measuredLede}>
        Real gaze recorded on your own machine, what it is &mdash; and is not &mdash; used for, and
        what comes out the other end.
      </p>
      <ol className={styles.stages}>
        {STAGES.map((stage, index) => (
          <li className={`card ${styles.stage}`} key={stage.name}>
            <div className={styles.stageArt}>{stage.drawing()}</div>
            <p className={`microlabel ${styles.stageNumber}`}>Stage {index + 1}</p>
            <h3 className={styles.stageName}>{stage.name}</h3>
            <p className={styles.stageBody}>{stage.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
