import type { Run, ScreenSlice, Session } from '@personavision/contract';
import { quantileMs, screenIndexAt, stepWalk, type ScreenSliceSpec } from './sessions.js';

/**
 * The per-screen figures of one heatmaps slice: how many reached each screen, how many it
 * was the last thing they saw, the median time on it, where the clicks landed by area of
 * interest, and how far down the page they got (`docs/FLOW.md` section 14.4, and the
 * *This screen* panel of `#screen-heatmaps`).
 *
 * The attention overlay is unchanged and stays the engine's: nothing here re-derives gaze.
 *
 * Everything is read through the shared reading beside this file — the step walk says which
 * screen a click or a scroll belongs to, and `quantileMs` is the median, so the median the
 * side panel prints beside a screen is the median the timing table prints for its step.
 *
 * Three definitions are settled here, because every figure below is one of them:
 *
 * - **A row is one version and one step, and every declared pair gets one.** The filmstrip
 *   offers the same screens whatever the filter is set to, so a screen nobody in this slice
 *   reached is a row of zeroes with no median — *a screen nobody got to is the finding* —
 *   and never an absent row.
 * - **Clicks are counted per area of interest**, with the clicks that landed on nothing the
 *   DOM explained counted together under no area: the prototype's *9 landed on empty space
 *   where a progress indicator would be*. An area nobody clicked keeps its row at zero,
 *   because the areas-of-interest table reads `never` and `0%` off figures like these.
 * - **How far down they got is the deepest point they saw**, in ten equal bins from the top
 *   of the page: the page is scrolled to a position, and what they saw is that position plus
 *   the screen they were on, as a share of that screenshot's own `pageHeight`. So every bin
 *   is reachable — somebody who read to the bottom of the page is in the last one — and the
 *   share is clamped, because a page shorter than the screen it was read on is a page
 *   somebody saw all of and never more than all of.
 * - **Past the fold takes a scroll**: they are past it when they scrolled beyond the bottom
 *   of the first screen, which is the fold line the screenshot records, or their own screen's
 *   bottom where that is further down the page. A session that never scrolled is past no
 *   fold, whatever screen it was on — and a person on a screen taller than the captured fold
 *   line has to scroll further than the screenshot's own reader did to pass it.
 */

/**
 * What the per-screen figures are given. **#291 settles the rest of this shape in this
 * file**; the barrel re-exports it by name, so adding to it costs that file no edit.
 */
export interface ScreenFiguresInput {
  /** The run, read for its steps, its areas of interest and its screenshots' folds. */
  readonly run: Run;
  /** The slice and its sessions, as `screenSliceSpecs` enumerated them. */
  readonly slice: ScreenSliceSpec;
}

/** The signature #291 implements: one row per version and step of a stored slice. */
export type ScreenFiguresBuilder = (input: ScreenFiguresInput) => ScreenSlice['screens'];

/**
 * How many bars the scroll-depth overlay draws: ten, which is the *how far down they got*
 * reading of `docs/FLOW.md` section 14.4. Deliberately not the twelve of a time
 * distribution: this is a share of one page's height and not a spread over a sample.
 */
const SCROLL_BIN_COUNT = 10;

/** One row of a slice, as the contract stores it. */
type ScreenFigures = ScreenSlice['screens'][number];

/**
 * The page position a scroll reached, as `run-session` writes it down — the absolute
 * `scrollY` the page ended at, in the action's `value`. `null` for anything else: an action
 * that was not a scroll, a scroll recorded before the position was, or a value that is not a
 * position, none of which says anything about how far down the page somebody got.
 */
const scrolledTo = (action: Session['actions'][number]): number | null => {
  if (action.type !== 'scroll' || action.value === null) return null;
  const position = Number(action.value);
  return Number.isFinite(position) && position >= 0 ? position : null;
};

/** What one session did on one step, over however many times it was on it. */
interface StepReading {
  /** Its measured spans added up; `null` when none of them was measured. */
  readonly measuredMs: number | null;
  /** The deepest the page was scrolled to while they were on it. */
  readonly deepestScrollPx: number;
}

/** One session read the way a row counts it: per step, plus where it ended and its clicks. */
interface SessionReading {
  readonly variant: string;
  /** The screen the person was on, or `null` for a session that names no persona. */
  readonly viewportHeight: number | null;
  readonly byStep: ReadonlyMap<string, StepReading>;
  /** The step of the last screen they saw: the screen they left here from. */
  readonly lastStep: string | null;
  readonly clicks: ReadonlyArray<{ readonly step: string; readonly aoiId: string | null }>;
}

const readSession = (run: Run, session: Session): SessionReading => {
  const walk = stepWalk(session);
  /** The step the run declares an area on, or `null` for a click that named no area. */
  const declaredStep = (aoiId: string | null): string | null =>
    aoiId === null ? null : (run.aois.find((aoi) => aoi.id === aoiId)?.step ?? null);
  const stepAt = (tMs: number): string | null => {
    const screenIndex = screenIndexAt(walk, tMs);
    return screenIndex === null ? null : (walk[screenIndex]?.step ?? null);
  };

  // A scroll belongs to the screen whose span holds it, like any other action, so the
  // position it reached counts towards the screen the person was looking at when they made
  // it and not the one they went on to.
  const scrolls = session.actions.flatMap((action) => {
    const toY = scrolledTo(action);
    const screenIndex = toY === null ? null : screenIndexAt(walk, action.tMs);
    return toY === null || screenIndex === null ? [] : [{ screenIndex, toY }];
  });

  const byStep = new Map<string, StepReading>();
  walk.forEach((span, index) => {
    const seen = byStep.get(span.step);
    byStep.set(span.step, {
      // A revisit is more time on the same screen, not a second screen: the spans a person
      // spent on a step add up, and a span nobody was timed on adds nothing rather than zero.
      measuredMs:
        span.durationMs === null
          ? (seen?.measuredMs ?? null)
          : (seen?.measuredMs ?? 0) + span.durationMs,
      deepestScrollPx: Math.max(
        seen?.deepestScrollPx ?? 0,
        session.screens[index]?.scrollY ?? 0,
        ...scrolls.filter((scroll) => scroll.screenIndex === index).map((scroll) => scroll.toY),
      ),
    });
  });

  return {
    variant: session.variant,
    viewportHeight: session.persona?.device.viewport.height ?? null,
    byStep,
    lastStep: walk[walk.length - 1]?.step ?? null,
    clicks: session.actions.flatMap((action) => {
      if (action.type !== 'click') return [];
      // The screen a click was made on is the screen the area it landed on is **on**, which
      // the run declares. The span is the fallback, for a click that landed on nothing the
      // DOM explained and so names no area to place it by: a session's clock only moves on
      // its fixations, so an action made on a screen nobody looked at falls in the span of
      // the screen before it, and would otherwise be counted against a control that is not
      // there while the screen it was really on read "never clicked".
      const step = declaredStep(action.aoiId) ?? stepAt(action.tMs);
      return step === null ? [] : [{ step, aoiId: action.aoiId }];
    }),
  };
};

/** The clicks of one row, counted per area, with the ones that named no area last. */
const clicksByAoiOf = (
  run: Run,
  variant: string,
  step: string,
  readings: readonly SessionReading[],
): ScreenFigures['clicksByAoi'] => {
  const counted = new Map<string, number>();
  let noArea = 0;
  for (const reading of readings) {
    for (const click of reading.clicks) {
      if (click.step !== step) continue;
      if (click.aoiId === null) noArea += 1;
      else counted.set(click.aoiId, (counted.get(click.aoiId) ?? 0) + 1);
    }
  }
  const declared = run.aois
    .filter((aoi) => aoi.variant === variant && aoi.step === step)
    .map((aoi) => aoi.id);
  // The areas the run declares for this screen, in the order it declares them, and then any
  // area a click named that the run declares nowhere — which is a run whose sessions and
  // whose `aois` disagree, reported as that by `readRun` rather than dropped here.
  const ids = [...new Set([...declared, ...counted.keys()])];
  return [
    ...ids.map((aoiId) => ({ aoiId, clicks: counted.get(aoiId) ?? 0 })),
    { aoiId: null, clicks: noArea },
  ];
};

/** How far down one row's people got: the ten bins, and how many saw past the fold. */
const scrollDepthOf = (
  run: Run,
  variant: string,
  step: string,
  onIt: readonly StepReading[],
  viewportHeights: ReadonlyArray<number | null>,
): ScreenFigures['scrollDepth'] => {
  const shot = run.screenshots.find((one) => one.variant === variant && one.step === step);
  const bins = new Array<number>(SCROLL_BIN_COUNT).fill(0);
  let pastFoldSessions = 0;
  onIt.forEach((reading, index) => {
    // The screen they read the page on, which is what turns a scroll position into a point
    // on the page they saw. A session with no persona — a real participant's — is read on the
    // screen the screenshot was captured at.
    const viewportHeight = viewportHeights[index] ?? shot?.viewport.height ?? 0;
    // No screenshot is no page height and no fold line, so nothing is claimed about how far
    // down this screen anybody got: they are in the first bin and past no fold.
    const pageHeight = shot?.pageHeight ?? 0;
    // Clamped, because a page shorter than the screen it was read on would otherwise be a
    // share of more than the whole page, which is not a share.
    const deepestSeenPx = reading.deepestScrollPx + viewportHeight;
    const share = pageHeight > 0 ? Math.min(1, deepestSeenPx / pageHeight) : 0;
    const bin = Math.min(SCROLL_BIN_COUNT - 1, Math.floor(share * SCROLL_BIN_COUNT));
    bins[bin] = (bins[bin] ?? 0) + 1;
    // The bottom of the first screen: the fold the screenshot records, or this person's own
    // screen bottom where that is further down the page. Scrolling past it is what the figure
    // counts, so a session that never scrolled is past no fold whatever screen it was on.
    if (shot !== undefined && reading.deepestScrollPx > Math.max(0, shot.foldY - viewportHeight)) {
      pastFoldSessions += 1;
    }
  });
  return { bins, pastFoldSessions };
};

/**
 * The clicks and the scroll depth of every screen of one stored slice, beside the reach, the
 * drop and the median time its side panel states for the people the filters left.
 *
 * One row per version and step the run declares, in that order, whether anybody in this
 * slice got there or not.
 */
export const screenFiguresOfSlice: ScreenFiguresBuilder = ({ run, slice }) => {
  const readings = slice.sessions.map((session) => readSession(run, session));

  return run.variants.flatMap((variant) =>
    run.steps.map((step): ScreenFigures => {
      const mine = readings.filter((reading) => reading.variant === variant.id);
      const reached = mine.filter((reading) => reading.byStep.has(step.id));
      const onIt = reached.flatMap((reading) => {
        const read = reading.byStep.get(step.id);
        return read === undefined ? [] : [{ read, viewportHeight: reading.viewportHeight }];
      });
      const timed = onIt
        .map((entry) => entry.read.measuredMs)
        .filter((measuredMs): measuredMs is number => measuredMs !== null);

      return {
        variant: variant.id,
        step: step.id,
        reached: reached.length,
        leftHere: mine.filter((reading) => reading.lastStep === step.id).length,
        medianMsOnIt: quantileMs(timed, 0.5),
        clicksByAoi: clicksByAoiOf(run, variant.id, step.id, mine),
        scrollDepth: scrollDepthOf(
          run,
          variant.id,
          step.id,
          onIt.map((entry) => entry.read),
          onIt.map((entry) => entry.viewportHeight),
        ),
      };
    }),
  );
};
