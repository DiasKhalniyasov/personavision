/**
 * The part of the eye tracker that is arithmetic rather than a page: raw webcam gaze in,
 * `packages/calibration`'s raw-record shape out.
 *
 * It is a separate file from `eyetrack.js` for one reason: this is the only code in the tool
 * that decides what the recorded data *says*, so it has to be checkable without a camera, a
 * browser or a participant. `packages/calibration/test/eyetrack-sample.test.ts` loads this
 * file and re-derives the committed sample's fixations from the committed raw gaze beside
 * them — so the sample's fixations are provably this code's output and not a hand-written
 * list that happens to validate.
 *
 * **It touches no DOM and no network.** Loaded as a classic `<script>` by `index.html` and
 * imported for its side effect by the test, it assigns one namespace, `eyetrackFixations`,
 * to the host global. There is no `import`/`export` because the page has to run from a
 * `file://` URL, where a browser refuses an ES module.
 *
 * **Geometry is image space**, as `packages/calibration/src/types.ts` fixes it: the origin is
 * the screenshot's top-left pixel, `x` runs right and `y` runs down, both in the image's own
 * pixels. The page converts from CSS pixels on the display before it gets here; nothing
 * below knows what a screen is.
 */
(function (root) {
  'use strict';

  /**
   * Which version of this file wrote a recording. It goes in the file so that a reader who
   * finds a session a year from now can tell which rules below produced its fixations.
   * Bump it when a default here changes, because the same gaze then yields different data.
   */
  const WRITER_VERSION = 1;

  /**
   * How far apart the samples of one fixation may lie, in image pixels.
   *
   * A webcam eye tracker is accurate to around 100 px (Papoutsaki et al., IJCAI 2016, which
   * measured the very library this tool vendors), so a tighter window would be fitting
   * noise: it would cut one real fixation into three because the estimate wandered. The
   * dispersion is the sum of the x and y ranges over the window, which is the measure
   * Salvucci & Goldberg's I-DT uses.
   */
  const DISPERSION_PX = 100;

  /** The shortest run of gaze that counts as a fixation. 100 ms is the usual floor. */
  const MIN_DURATION_MS = 100;

  /**
   * The longest silence inside one fixation.
   *
   * Samples go missing — a blink, a face the tracker lost, gaze that left the screenshot and
   * was dropped. Without this, two clusters either side of a two-second hole would pass the
   * dispersion test and be recorded as one two-second fixation, which is a claim about a
   * second nobody measured. A gap longer than this ends the fixation instead.
   */
  const MAX_GAP_MS = 150;

  /** The four UI types `packages/calibration` scores per category. */
  const CATEGORIES = ['webpage', 'desktop', 'mobile', 'poster'];

  /**
   * The viewing conditions UEyes publishes its ground truth at, and therefore the only
   * exposures `convertRecord` accepts: a figure measured at one is not the figure measured
   * at another, so the tool offers these three and no free choice.
   */
  const VIEWING_DURATIONS_SECONDS = [1, 3, 7];

  /** Round to `places` decimals, and never return `-0`, which JSON spells `-0`. */
  const round = function (value, places) {
    const factor = Math.pow(10, places);
    const rounded = Math.round(value * factor) / factor;
    return rounded === 0 ? 0 : rounded;
  };

  /**
   * The samples of one recording, cleaned into something a fixation can be read from:
   * dropped where they fell outside the screenshot, and strictly increasing in time.
   *
   * Both rules exist because of what the data is checked against downstream. A point off the
   * image is not somewhere a human looked at it, and `convertRecord` rejects a record that
   * carries one; two samples sharing a millisecond would make two fixations whose onsets are
   * equal, which it rejects as well. Dropping is counted and reported rather than hidden,
   * because the share of gaze that missed the image is how a reader judges a recording — and
   * it is counted in three buckets, `outsideImage`, `outOfOrder` and `unreadable`, because a
   * participant who looked away and a tracker returning nonsense are different problems.
   */
  const cleanSamples = function (samples, imageSize) {
    const kept = [];
    let outsideImage = 0;
    let outOfOrder = 0;
    let unreadable = 0;
    let lastTime = null;

    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      // Three different defects, counted apart, because this file is the provenance a reader
      // judges the recording by: gaze that left the screenshot, a reading that is not a number
      // at all, and a clock that did not move. Lumping them would hide a broken tracker behind
      // a participant who looked away.
      if (
        !Number.isFinite(sample.x) ||
        !Number.isFinite(sample.y) ||
        !Number.isFinite(sample.tMs) ||
        sample.tMs < 0
      ) {
        unreadable += 1;
        continue;
      }
      const inside =
        sample.x >= 0 &&
        sample.y >= 0 &&
        sample.x <= imageSize.width &&
        sample.y <= imageSize.height;
      if (!inside) {
        outsideImage += 1;
        continue;
      }
      const tMs = Math.round(sample.tMs);
      if (lastTime !== null && tMs <= lastTime) {
        outOfOrder += 1;
        continue;
      }
      lastTime = tMs;
      kept.push({ tMs: tMs, x: round(sample.x, 1), y: round(sample.y, 1) });
    }

    return {
      gaze: kept,
      outsideImage: outsideImage,
      outOfOrder: outOfOrder,
      unreadable: unreadable,
    };
  };

  /** The dispersion of `samples[from..to]`: the x range plus the y range, in image pixels. */
  const dispersionOf = function (samples, from, to) {
    let minX = samples[from].x;
    let maxX = samples[from].x;
    let minY = samples[from].y;
    let maxY = samples[from].y;
    for (let i = from + 1; i <= to; i += 1) {
      if (samples[i].x < minX) minX = samples[i].x;
      if (samples[i].x > maxX) maxX = samples[i].x;
      if (samples[i].y < minY) minY = samples[i].y;
      if (samples[i].y > maxY) maxY = samples[i].y;
    }
    return maxX - minX + (maxY - minY);
  };

  /** The mean point of `samples[from..to]`, which is the fixation's location. */
  const centroidOf = function (samples, from, to) {
    let sumX = 0;
    let sumY = 0;
    for (let i = from; i <= to; i += 1) {
      sumX += samples[i].x;
      sumY += samples[i].y;
    }
    const count = to - from + 1;
    return { x: round(sumX / count, 1), y: round(sumY / count, 1) };
  };

  /**
   * Gaze samples into fixations, by dispersion-threshold identification (I-DT, Salvucci &
   * Goldberg 2000).
   *
   * The window starts at the earliest unassigned sample and grows while the gaze stays
   * within `dispersionPx` and no gap exceeds `maxGapMs`. Once it covers `minDurationMs` it
   * is a fixation at the window's centroid, lasting from its first sample to its last; if
   * the window cannot reach that duration without scattering, its first sample belongs to a
   * saccade and is passed over. What comes out satisfies what `convertRecord` requires of a
   * scanpath by construction: the windows do not overlap, so onsets strictly increase and
   * each one begins at or after the previous dwell ended.
   *
   * It is *a* fixation detector, not the one true one, which is why the thresholds travel in
   * the recorded file and the raw samples travel beside the fixations: a reader who prefers
   * a velocity-based detector has everything needed to run it.
   *
   * The thresholds are this module's constants and deliberately not arguments. `buildFile`
   * writes those same constants into the recording as `fixationDetector`, so a per-call
   * override would let a file report thresholds its fixations were not derived with — a knob
   * whose only possible use is to make the provenance wrong.
   */
  const detectFixations = function (gaze) {
    const fixations = [];
    let start = 0;

    while (start < gaze.length) {
      // Grow the window while the gaze holds still and keeps talking.
      let end = start;
      while (end + 1 < gaze.length) {
        if (gaze[end + 1].tMs - gaze[end].tMs > MAX_GAP_MS) break;
        if (dispersionOf(gaze, start, end + 1) > DISPERSION_PX) break;
        end += 1;
      }

      const durationMs = gaze[end].tMs - gaze[start].tMs;
      if (durationMs < MIN_DURATION_MS) {
        // Too brief to be a fixation: the eye was moving. Try again one sample along.
        start += 1;
        continue;
      }

      const centroid = centroidOf(gaze, start, end);
      fixations.push({
        tMs: gaze[start].tMs,
        durationMs: durationMs,
        x: centroid.x,
        y: centroid.y,
      });
      start = end + 1;
    }

    return fixations;
  };

  /**
   * One screenshot's recording as `packages/calibration`'s `RawRecord`.
   *
   * `id` is the file's name without its extension and `file` is the name as it was on disk,
   * which is the distinction that package draws. `display` is what the participant actually
   * saw: the area the screenshot occupied in CSS pixels, and the image's pixels per CSS
   * pixel — never the window, never the image's own size, because a prediction is later made
   * at the resolution the human saw.
   *
   * The record carries one extra key, `gaze`, which the converter ignores: the cleaned raw
   * samples these fixations were derived from. Fixations are an interpretation of gaze, and
   * an interpretation nobody can re-derive is a lossy recording.
   */
  const buildRecord = function (input) {
    const imageSize = { width: input.image.width, height: input.image.height };
    const cleaned = cleanSamples(input.samples, imageSize);
    const fixations = detectFixations(cleaned.gaze);

    return {
      id: input.id,
      category: input.category,
      viewingDurationSeconds: input.viewingDurationSeconds,
      image: { file: input.image.file, width: input.image.width, height: input.image.height },
      display: {
        viewportWidth: Math.round(input.display.cssWidth),
        viewportHeight: Math.round(input.display.cssHeight),
        scale: round(input.image.width / input.display.cssWidth, 4),
      },
      participants: [
        {
          participantId: input.participantId,
          fixations: fixations.map(function (fixation, index) {
            return {
              index: index,
              tMs: fixation.tMs,
              durationMs: fixation.durationMs,
              x: fixation.x,
              y: fixation.y,
            };
          }),
        },
      ],
      gaze: cleaned.gaze,
      dropped: {
        outsideImage: cleaned.outsideImage,
        outOfOrder: cleaned.outOfOrder,
        unreadable: cleaned.unreadable,
      },
    };
  };

  /**
   * The one file a participant saves.
   *
   * The records are the converter's input — `convertRecords(JSON.parse(text).records)` — and
   * everything around them is provenance. The provenance is not decoration: it is the
   * difference between "human gaze" and "gaze from a webcam, through this library, with this
   * measured error". Without the calibration figure beside it a recording is a number nobody
   * can weigh, and this project refuses those elsewhere.
   */
  const buildFile = function (input) {
    return {
      tool: 'personavision/tools/eyetrack/calibrate',
      writerVersion: WRITER_VERSION,
      format: 'packages/calibration RawRecord[] under .records',
      tracker: input.tracker,
      gazeSource: input.gazeSource,
      recordedAt: input.recordedAt,
      participantId: input.participantId,
      display: input.screen,
      calibration: input.calibration,
      fixationDetector: {
        algorithm: 'I-DT (Salvucci & Goldberg 2000)',
        dispersionPx: DISPERSION_PX,
        minDurationMs: MIN_DURATION_MS,
        maxGapMs: MAX_GAP_MS,
      },
      records: input.records,
    };
  };

  root.eyetrackFixations = {
    WRITER_VERSION: WRITER_VERSION,
    DISPERSION_PX: DISPERSION_PX,
    MIN_DURATION_MS: MIN_DURATION_MS,
    MAX_GAP_MS: MAX_GAP_MS,
    CATEGORIES: CATEGORIES,
    VIEWING_DURATIONS_SECONDS: VIEWING_DURATIONS_SECONDS,
    cleanSamples: cleanSamples,
    detectFixations: detectFixations,
    buildRecord: buildRecord,
    buildFile: buildFile,
  };
})(typeof globalThis === 'undefined' ? this : globalThis);
