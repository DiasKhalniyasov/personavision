import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { runPaths } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { isNeverFixated } from '@/screens/attention/attentionWording';
import { useAttentionStage } from '@/screens/attention/stage/AttentionStage';
import { HEATMAP_LAYER, HeatmapLayer } from '@/screens/attention/stage/HeatmapLayer';
import {
  OVERLAY_SPAN,
  boxToOverlay,
  foldMark,
  isDrawable,
  overlaySpanY,
} from '@/screens/attention/stage/overlayTransform';
import type { Capture, Transform } from '@/screens/attention/stage/overlayTransform';
import { attentionAreas } from '@/screens/attention/useAttentionAreas';
import type { AttentionArea } from '@/screens/attention/useAttentionAreas';
import { useAttentionStepSessions } from '@/screens/attention/useAttentionStepSessions';
import { AOI_PARAM } from '@/screens/sessions/filters';
import { paths } from '@/shell/paths';
import styles from './heroEvidence.module.css';

/**
 * The one heatmap that proves the headline, framed on a neutral mat with its caption and a
 * link into Attention: the `.mat` of `#screen-verdict`. It is the only chart on this screen
 * (`docs/FLOW.md` sections 3 and 5), and beat 3 of the demo is this block.
 *
 * **Which heatmap is not this screen's decision.** `verdict.heroEvidence` — `{ variant,
 * step, aoiId }` — is what the pipeline stored as the moment the verdict turns on, and this
 * reads it and renders that. Nothing here ranks a step, weighs a version or picks an area.
 *
 * **Nothing here draws heat, resolves a capture or converts a coordinate either.** The
 * dwell-weighted heatmap is #71's layer, mounted as it is; the page's box, the fold's
 * position, a bounding box in overlay units and the screenshot's URL all come from #58's
 * stage (`overlayTransform.ts`, `useAttentionStage`). A second heat accumulation or a
 * second page-to-overlay conversion would drift from the first, and the two screens would
 * then disagree about where the audience looked — which is the one thing the product cannot
 * afford to be unsure about. The session reader behind the aggregate caches per run, so the
 * Attention screen the caption links to costs no second read.
 *
 * **No scanpath, no numbered fixations, no second chart.** The order attention moved in is
 * what the Attention screen is for. The one exception the direction allows is the outline of
 * the area nobody looked at, when `heroEvidence.aoiId` names one: the absence is the point,
 * and an outline with nothing in it says it better than a sentence does.
 *
 * Two stated refinements of the prototype:
 *
 * 1. The frame takes **the capture's own aspect ratio** rather than the prototype's 16:10
 *    window. See the stylesheet's header: this screen has no scroll and no zoom, and a crop
 *    would cut away exactly the part of the page the caption is about.
 * 2. The mat's heading is an `h2`, not the prototype's `h3`. It sits between the screen's
 *    `h1` and the findings' `h2`, so an `h3` here would be a skipped level — and the
 *    direction counts accessibility as part of itself, not a later pass. Its type role is
 *    the prototype's `.mat-head h3` unchanged.
 */

/** What the run names as the moment its verdict turns on. */
type HeroEvidenceRef = Run['verdict']['heroEvidence'];

/** The areas whose heat the caption names: the two the audience held on longest. */
const CAPTION_AREAS = 2;

/**
 * The hero evidence, read as if the field might not be there.
 *
 * `runSchema` holds every run to carrying one, so this is not a state a parsed artifact
 * reaches — but the screen renders over a file on disk, and a block that threw on a run
 * written by an older pipeline would take the whole Verdict screen down with it. A run that
 * names no moment says so instead.
 */
const heroEvidenceOf = (run: Run): HeroEvidenceRef | null => {
  const hero = (run.verdict as { heroEvidence?: HeroEvidenceRef | null }).heroEvidence ?? null;
  if (hero === null || hero.variant === '' || hero.step === '') return null;
  return hero;
};

/**
 * What the capture was taken on, in the audience's own words.
 *
 * `screenshots[].viewport` carries the size and not the name, and the audience's device mix
 * carries both — so `mobile 390 × 844` is the artifact's own label for that viewport rather
 * than a word this screen invented from a width. A viewport no device of the mix has is
 * named by its figures alone.
 */
const deviceLabel = (run: Run, capture: Capture): string => {
  const { width, height } = capture.viewport;
  const device = run.audience.devices.find(
    (candidate) => candidate.viewport.width === width && candidate.viewport.height === height,
  );
  const size = `${width} × ${height}`;
  return device === undefined ? size : `${device.name} ${size}`;
};

/** `9 people`, as the prototype's label reads it. */
const people = (count: number): string => (count === 1 ? '1 person' : `${count} people`);

/** `“A”` or `“A” and “B”`: the areas the caption names, in the artifact's own words. */
const quoted = (areas: readonly AttentionArea[]): string => {
  const labels = areas.map((area) => `“${area.aoi.label}”`);
  return labels.length < 2
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1] as string}`;
};

/**
 * The areas of this version's step the audience held on longest, hottest first.
 *
 * `aoiMetrics[].totalDwellMs` is the pipeline's own aggregate — the same dwell the heatmap
 * is drawn from, already added up per area — so the caption and the colours on the page are
 * two readings of one number rather than two measurements. An area with no dwell is not
 * among them: `0 ms` there means nobody ever looked, which is the other sentence's subject.
 */
const hottestAreas = (areas: readonly AttentionArea[]): AttentionArea[] =>
  areas
    .filter((area) => (area.metric?.totalDwellMs ?? 0) > 0)
    .sort((one, other) => (other.metric?.totalDwellMs ?? 0) - (one.metric?.totalDwellMs ?? 0))
    .slice(0, CAPTION_AREAS);

/** The area `heroEvidence.aoiId` names, when it names one of this version's step. */
const namedArea = (areas: readonly AttentionArea[], aoiId: string | null): AttentionArea | null =>
  aoiId === null || aoiId === '' ? null : (areas.find((area) => area.aoi.id === aoiId) ?? null);

/**
 * The step's primary action, when the run records no fixation in it at all.
 *
 * The caption's second sentence is about the place the heat does *not* reach, and with no
 * area named by the run this is the absence worth saying out loud: an unseen Confirm
 * purchase is the whole finding, and a button four people in nine looked at is not.
 */
const unseenPrimaryAction = (areas: readonly AttentionArea[]): AttentionArea | null =>
  areas.find(
    (area) => area.aoi.isPrimaryAction && area.metric !== null && isNeverFixated(area.metric),
  ) ?? null;

/**
 * Whether the run records no fixation in this area at all.
 *
 * An area the run holds no figures for counts as one: the honest reading of a gap is not a
 * claim that somebody looked. `isNeverFixated` is the areas table's own rule, so the
 * caption and that table can never disagree about the word *never*.
 */
const neverLooked = (area: AttentionArea): boolean =>
  area.metric === null || isNeverFixated(area.metric);

/**
 * The caption's second sentence: the place the heat does not land, or the area the verdict
 * turns on when the audience did reach it.
 *
 * `heroEvidence.aoiId` is not always an area nobody saw — the pipeline sets it to the area
 * of the highest-severity finding that has one, and a promo banner that pulls attention away
 * is such an area. So the sentence is written from the run's own metrics rather than from
 * the fact that an area was named, and the screen never says "nothing at all lands here" of
 * a place the audience looked at.
 */
const absenceSentence = (area: AttentionArea, label: string): string => {
  const belowFold = area.aoi.belowFold ? ', which sits below the fold' : '';
  return neverLooked(area)
    ? `Nothing at all lands on ${label}${belowFold}.`
    : `The area this verdict turns on is ${label}${belowFold}.`;
};

/** How far the screenshot has got, which is what the frame says instead of showing a gap. */
type ScreenshotState = 'loading' | 'shown' | 'unreadable';

export function HeroEvidence({ run }: { run: Run }) {
  const hero = heroEvidenceOf(run);
  // The hooks below run on every render, so the unnamed state passes the one selection that
  // asks for nothing: no version and no step match any capture, any area or any fixation.
  const variant = hero?.variant ?? '';
  const step = hero?.step ?? '';

  const sessions = useAttentionStepSessions(variant, step);
  const areas = useMemo(() => attentionAreas(run, variant, step).areas, [run, variant, step]);
  const stage = useAttentionStage({
    run,
    variant,
    step,
    // Never isolated: this screen shows the whole page's heat, because the caption's second
    // sentence is about a place the heat is *not*. Isolating an area is what the link into
    // Attention is for, and the URL it carries says so.
    aoi: null,
    sessions,
    areas,
  });
  const { capture, screenshotUrl, stepLabel, variantName, layerProps } = stage;

  // Which screenshot has arrived, and which one would not: the url, not a flag, so that a
  // run whose capture moves gets its own attempt.
  const [decoded, setDecoded] = useState<string | null>(null);
  const [broken, setBroken] = useState<string | null>(null);

  const drawable = capture !== null && screenshotUrl !== null && isDrawable(capture);
  const screenshot: ScreenshotState =
    broken === screenshotUrl ? 'unreadable' : decoded === screenshotUrl ? 'shown' : 'loading';

  // The registry's own answer to "is there a heatmap here", so the frame is dimmed only
  // while heat is actually on it and the words for its absence are #71's rather than a
  // second opinion written on this screen.
  const unavailable = HEATMAP_LAYER.unavailable?.(layerProps) ?? null;
  const heatDrawn = drawable && unavailable === null;

  const fold = capture === null || !isDrawable(capture) ? null : foldMark(capture);
  const hottest = hottestAreas(areas);
  // The one vector the direction allows on this screen, and only when the run itself named
  // the area: the absence the pipeline pointed at, outlined with nothing in it.
  const outlined = namedArea(areas, hero?.aoiId ?? null);
  // What the caption's second sentence is about: the area the run named, or — when it named
  // none — a primary action nobody ever looked at.
  const subject = outlined ?? unseenPrimaryAction(areas);

  const href =
    hero === null
      ? null
      : `${paths.attention(run.runId, hero.variant, hero.step)}${
          hero.aoiId === null
            ? ''
            : `?${new URLSearchParams({ [AOI_PARAM]: hero.aoiId }).toString()}`
        }`;

  /**
   * What the frame says over the page when pixels cannot say it.
   *
   * Nothing while the sessions are still arriving: the heat is on its way, the page under
   * it is already the right page, and a sentence that appears for a moment and then leaves
   * is noise on the screen the product leads with. Once they are all in, an absence is a
   * reading and is stated.
   */
  const note =
    screenshot === 'unreadable' && capture !== null
      ? `The screenshot at ${capture.path} could not be read. The heat drawn over it is still placed on the page it recorded, ${capture.viewport.width} by ${capture.pageHeight} pixels.`
      : sessions.status === 'error'
        ? `Your audience’s sessions could not all be read: ${sessions.error ?? 'the reason was not recorded'}. No heat is drawn, because an aggregate quietly missing one person is a different claim about your audience from the one this screen is making.`
        : sessions.status === 'ready'
          ? unavailable
          : null;

  return (
    <figure className={styles.mat} data-section="hero-evidence">
      {hero === null ? (
        <p className={styles.stated} role="status">
          This test does not name the moment its verdict turns on, so there is no heatmap to show
          here. Every version and step it did capture is on the Attention screen.
        </p>
      ) : (
        <>
          <div className={styles.head}>
            <h2>
              Where your audience looked on {variantName}, at the {stepLabel} step
            </h2>
            <span className="grow" />
            <span className="microlabel">
              {variantName} &middot; {stepLabel} step
              {capture === null ? '' : ` · ${deviceLabel(run, capture)}`} &middot;{' '}
              {sessions.status === 'loading'
                ? 'reading the sessions…'
                : people(sessions.reachedCount)}
            </span>
          </div>

          {capture === null || screenshotUrl === null ? (
            <p className={styles.stated} role="status">
              This test holds no screenshot of the {stepLabel} step on {variantName}. It looked for{' '}
              {runPaths('').screenshot(hero.variant, hero.step)} in the run, so there is no page to
              show the heat over.
            </p>
          ) : !isDrawable(capture) ? (
            <p className={styles.stated} role="status">
              The screenshot at {capture.path} records a page of no size &mdash;{' '}
              {capture.viewport.width} by {capture.pageHeight} pixels &mdash; so there is nothing to
              draw the heat on.
            </p>
          ) : (
            <div
              className={styles.frame}
              id="vd-frame"
              data-screenshot={screenshot}
              // Dimmed only while heat is drawn over it, as the prototype dims `#vd-frame`
              // only when there is gaze to read on top. An outline is a hairline and needs
              // no scrim; a page with nothing on it is the page, and washing it out would
              // be a treatment with nothing to serve.
              data-dim={heatDrawn ? '' : undefined}
              // The box is the artifact's: the capture's own shape, and never wider than
              // the pixels it was taken at — the one scale at which what the reader sees is
              // what the audience saw. Both are known before the image decodes, which is
              // what keeps the page from moving when it arrives.
              style={{
                aspectRatio: `${capture.viewport.width} / ${capture.pageHeight}`,
                maxWidth: `${capture.viewport.width}px`,
              }}
            >
              <div className={styles.page} id="vd-page">
                <img
                  src={screenshotUrl}
                  alt={`The ${stepLabel} step of ${variantName}, the whole page as your audience saw it`}
                  onLoad={() => {
                    setDecoded(screenshotUrl);
                  }}
                  onError={() => {
                    setBroken(screenshotUrl);
                  }}
                />
              </div>

              {/* #71's layer, mounted as it is. It withholds itself while the sessions are
                  still arriving and when there is no dwell to draw, so there is one answer
                  to "is there heat here" and this screen does not hold a second. */}
              <HeatmapLayer {...layerProps} />

              {outlined === null ? null : (
                <NeverLookedLayer area={outlined} transform={layerProps.transform} />
              )}

              {fold === null ? null : (
                <div className={styles.fold} style={{ top: `${fold.atPct}%` }} data-fold>
                  <span>{fold.label}</span>
                </div>
              )}

              {note === null ? null : (
                <p className={styles.note} role="status">
                  {note}
                </p>
              )}
            </div>
          )}

          {/* The caption, and the heatmap's text alternative: what the heat shows, what it
              does not land on, and one click to everything else. A `figcaption` is the
              figure's own description, so the evidence on this screen is not sight-only
              without a second, hidden copy of the sentence to keep in step with it. */}
          <figcaption className={styles.cap}>
            {hottest.length === 0
              ? `No area this test marked collected any dwell on ${variantName} at the ${stepLabel} step.`
              : `Attention burns on ${quoted(hottest)}.`}{' '}
            {subject === null ? '' : absenceSentence(subject, quoted([subject]))}{' '}
            {href === null ? null : <Link to={href}>Open this in Attention &rarr;</Link>}
          </figcaption>
        </>
      )}
    </figure>
  );
}

/**
 * The outline of the area nobody looked at: the prototype's `#vd-vec`, carrying one box.
 *
 * The only thing this screen draws itself, and it draws no geometry of its own: the box is
 * `aois[].bbox` as the run recorded it, put into overlay units by #58's `boxToOverlay`, in
 * the same `viewBox` the heat is drawn in — so the outline and the heat are one picture at
 * every frame width, and neither can come out of register with the page under them.
 *
 * `aria-hidden`, like every layer: the caption names the area in words, which is a better
 * alternative than a label on a rectangle.
 */
function NeverLookedLayer({ area, transform }: { area: AttentionArea; transform: Transform }) {
  const box = boxToOverlay(area.aoi.bbox, transform);

  return (
    <div className={styles.layer} data-overlay-layer="never-looked">
      <svg
        viewBox={`0 0 ${OVERLAY_SPAN} ${overlaySpanY(transform)}`}
        aria-hidden="true"
        focusable="false"
      >
        <rect
          className={styles.neverLooked}
          data-never-looked={area.aoi.id}
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          // The hairline stays device-sized at every frame width rather than growing with
          // the page, which is what the tokens' border width means.
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
