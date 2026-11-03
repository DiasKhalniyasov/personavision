import type { Distribution, FunnelSlice, Run, ScreenSlice, Session } from '@personavision/contract';

/**
 * The one reading of a session every figure of the aggregate shares.
 *
 * Three questions are answered here and nowhere else, because two figures answering one of
 * them separately is exactly how a funnel comes to disagree with a timing table:
 *
 * 1. **Who counts.** Automation failures are excluded from every figure and counted once
 *    beside them (`docs/FLOW.md` section 11).
 * 2. **When each step started.** A session's one clock is its fixations and its actions, so
 *    the span of a screen is derived, once, by `stepWalk`.
 * 3. **Which slices exist.** The (version, segment) pairs the funnel screen offers and the
 *    (segment, outcome) pairs the heatmaps screen offers, enumerated off the run's own
 *    people — never as a cross product of what an audience could have been.
 *
 * Quantiles and bins are defined here too, for the same reason: the median the heatmaps
 * screen prints beside a screen and the median the timing table prints for its step are the
 * same median, computed by the same function.
 *
 * Pure, like the rest of the package: contract-typed data in, plain values out.
 */

/** A scored outcome: the three a slice may filter by, never `automation_failure`. */
export type ScoredOutcome = NonNullable<ScreenSlice['outcome']>;

/**
 * The outcomes a slice is enumerated over, in the order the contract declares them, so the
 * slices of two runs are in the same order on every machine.
 */
export const SCORED_OUTCOMES: readonly ScoredOutcome[] = ['success', 'abandoned', 'failed'];

/** The words a filter button carries for an outcome, as `#screen-heatmaps` spells them. */
const OUTCOME_WORDS: Readonly<Record<ScoredOutcome, string>> = {
  success: 'Completed',
  abandoned: 'Gave up',
  failed: 'Failed',
};

/** How many bars the prototype's distributions draw (`#screen-funnel`, the *Spread* column). */
export const BIN_COUNT = 12;

/** The sessions every figure is of, and the ones left out of all of them. */
export interface ScoredSessions {
  /** In the order they were given, automation failures removed. */
  readonly sessions: readonly Session[];
  /** How many our own harness broke: what `aggregate.excludedAutomationFailures` reports. */
  readonly excludedAutomationFailures: number;
}

/**
 * Who counts, answered once.
 *
 * Whether a session is excluded is **read** off `outcome.excludedFromScores`, which the
 * pipeline derives once when the session lands — this does not re-derive it. An
 * `automation_failure` is dropped whatever that flag says, because the contract's own
 * outcome filter has no such value: a slice of automation failures is not a slice, and a
 * figure that quietly held one would be a figure about our harness.
 */
export const scoredSessions = (sessions: readonly Session[]): ScoredSessions => ({
  sessions: sessions.filter(
    (session) =>
      !session.outcome.excludedFromScores && session.outcome.status !== 'automation_failure',
  ),
  excludedAutomationFailures: sessions.filter(
    (session) => session.outcome.status === 'automation_failure',
  ).length,
});

/** One screen of a session, and the stretch of the session's clock it had. */
export interface StepSpan {
  /** The position in `session.screens`, which is that screen's own `index`. */
  readonly screenIndex: number;
  /** The step it was, as `run.steps` ids them. */
  readonly step: string;
  /** Where the span starts, in session time. */
  readonly startMs: number;
  /** Where it ends: the next screen's start, or the session's duration for the last one. */
  readonly endMs: number;
  /**
   * How long was spent on it: its span, or **`null` when that span is empty** — which is a
   * screen that was reached with nothing measured on it, and never zero seconds.
   */
  readonly durationMs: number | null;
}

/**
 * The step walk: every screen of a session with the span of the clock it had.
 *
 * `screens[]` carries no time of its own, so the one clock a session has is its fixations'
 * `tMs` and its actions' `tMs`. The rule, fixed here and read by every figure:
 *
 * - screen `i`'s span is `[startMs(i), startMs(i + 1))`, with `startMs(0) = 0` and the last
 *   screen ending at `session.durationMs`;
 * - `startMs(i)` for `i > 0` is the `tMs` of the first fixation whose `screenIndex === i`;
 *   where that screen has no fixation of its own it takes the next screen's start, so its
 *   span is empty;
 * - **a screen's time is its span, and an empty span is nothing measured** — `durationMs`
 *   is `null` exactly when the span is empty, which is what a screen nobody looked at
 *   collapses to: **reached with no time measured** rather than timed at zero. The first
 *   screen is pinned to zero whether anybody looked at it or not, so the seconds before the
 *   first fixation of a session belong to the screen they were spent on and the per-step
 *   times still add up to the session;
 * - an action belongs to the screen whose span contains its `tMs` (`screenIndexAt`).
 *
 * When the video block of a session (`sessionVideo.screenOffsetsMs`) is recorded for every
 * run, swapping to that better source is one edit in this function and no edit anywhere
 * else: that is why the figures call it rather than reading `fixations` themselves.
 */
export const stepWalk = (session: Session): readonly StepSpan[] => {
  const firstLookMs = new Map<number, number>();
  for (const fixation of session.fixations) {
    const seen = firstLookMs.get(fixation.screenIndex);
    if (seen === undefined || fixation.tMs < seen) firstLookMs.set(fixation.screenIndex, fixation.tMs);
  }

  // Right to left, so that a screen nobody looked at can take the start of the screen after
  // it — and a trailing run of them takes the end of the session. No screen starts after the
  // one that follows it: a session whose stored fixations are out of order would otherwise
  // get a span that ends before it begins, and every later action read off the wrong screen.
  const starts: number[] = new Array<number>(session.screens.length);
  let next = session.durationMs;
  for (let index = session.screens.length - 1; index >= 0; index -= 1) {
    starts[index] = index === 0 ? 0 : Math.min(firstLookMs.get(index) ?? next, next);
    next = starts[index];
  }

  return session.screens.map((screen, index) => {
    const startMs = starts[index] ?? 0;
    const endMs = index + 1 < starts.length ? (starts[index + 1] ?? 0) : session.durationMs;
    return {
      screenIndex: index,
      step: screen.step,
      startMs,
      endMs,
      durationMs: endMs > startMs ? endMs - startMs : null,
    };
  });
};

/**
 * The screen an action belongs to: the one whose span contains its time, by the walk above.
 *
 * `null` only for a session with no screens. An empty span — a screen nobody looked at —
 * contains nothing, so an action at that instant belongs to the screen that follows it, and
 * an action past the end of the session belongs to the last screen it had.
 */
export const screenIndexAt = (walk: readonly StepSpan[], tMs: number): number | null => {
  let found: number | null = null;
  for (const span of walk) {
    if (span.startMs > tMs) break;
    found = span.screenIndex;
  }
  return found;
};

/**
 * The segment of the person who walked a session, or `null` where the run names none — a
 * real participant's session, or a persona the run does not carry. A session with no
 * segment falls only in the slices that are of every segment.
 */
export const segmentOf = (run: Run, session: Session): string | null => {
  const personaId = session.persona?.id;
  if (personaId === undefined) return null;
  return run.personas.find((persona) => persona.id === personaId)?.segment ?? null;
};

/** A funnel slice before its figures: what it narrows to, and the sessions left after it. */
export type FunnelSliceSpec = Pick<FunnelSlice, 'key' | 'variant' | 'segment' | 'label'> & {
  readonly sessions: readonly Session[];
};

/** A heatmaps slice before its figures, the same way. */
export type ScreenSliceSpec = Pick<ScreenSlice, 'key' | 'segment' | 'outcome' | 'label'> & {
  readonly sessions: readonly Session[];
};

/**
 * The words a filter button carries, built from what the slice narrows to and how many
 * people are left after it — *Desktop 2*, *Completed · phone 7*, *Current checkout 1* — and
 * written here rather than composed by a screen, so two screens cannot word one filter two
 * ways. The slice of everybody carries the *Every …* wording of the prototype's first
 * button and no count, because that button is not a narrowing.
 */
const labelOf = (parts: readonly string[], sessionCount: number, every: string): string => {
  if (parts.length === 0) return every;
  const spelt = parts.join(' · ');
  return `${spelt.charAt(0).toUpperCase()}${spelt.slice(1)} ${sessionCount}`;
};

/** The segments the scored sessions actually carry, in a fixed order. */
const segmentsOf = (run: Run, sessions: readonly Session[]): string[] =>
  [
    ...new Set(
      sessions
        .map((session) => segmentOf(run, session))
        .filter((segment): segment is string => segment !== null),
    ),
  ].sort();

/**
 * Every (version, segment) slice the **Funnel and timing** screen offers, in the order they
 * are stored: the whole run first, then the segments, then the versions, then the pairs.
 *
 * `null` on either axis means *all* and is always present. Segments are read off the run's
 * own people, so the audience decides the list. **Versions appear only where the run
 * declares more than one**: a one-URL test has no version to filter by. A combination no
 * session falls in is not a slice, by the contract's own rule that a slice has a
 * denominator.
 */
export const funnelSliceSpecs = (run: Run, sessions: readonly Session[]): FunnelSliceSpec[] => {
  const scored = scoredSessions(sessions).sessions;
  const segments = segmentsOf(run, scored);
  const variants = run.variants.length > 1 ? run.variants : [];

  const narrowings: Array<{ variant: string | null; segment: string | null }> = [
    { variant: null, segment: null },
    ...segments.map((segment) => ({ variant: null, segment })),
    ...variants.map((variant) => ({ variant: variant.id, segment: null })),
    ...variants.flatMap((variant) =>
      segments.map((segment) => ({ variant: variant.id, segment })),
    ),
  ];

  return narrowings.flatMap(({ variant, segment }) => {
    const inSlice = scored.filter(
      (session) =>
        (variant === null || session.variant === variant) &&
        (segment === null || segmentOf(run, session) === segment),
    );
    if (inSlice.length === 0) return [];
    const versionName = run.variants.find((declared) => declared.id === variant)?.name ?? variant;
    const parts = [versionName, segment].filter((part): part is string => part !== null);
    const key = [
      ...(variant === null ? [] : [`variant:${variant}`]),
      ...(segment === null ? [] : [`segment:${segment}`]),
    ];
    return [
      {
        key: key.length === 0 ? 'all' : key.join('|'),
        variant,
        segment,
        label: labelOf(parts, inSlice.length, 'Every segment'),
        sessions: inSlice,
      },
    ];
  });
};

/**
 * Every (segment, outcome) slice the **Heatmaps** screen offers, in the same spirit: the
 * whole run, then the segments, then the outcomes in the contract's own order, then the
 * pairs — because that screen composes the two filters, and *where the people who failed,
 * on a phone, clicked* is one choice on it.
 *
 * `automation_failure` is never among the outcomes: those sessions are not here at all.
 */
export const screenSliceSpecs = (run: Run, sessions: readonly Session[]): ScreenSliceSpec[] => {
  const scored = scoredSessions(sessions).sessions;
  const segments = segmentsOf(run, scored);

  const narrowings: Array<{ segment: string | null; outcome: ScoredOutcome | null }> = [
    { segment: null, outcome: null },
    ...segments.map((segment) => ({ segment, outcome: null })),
    ...SCORED_OUTCOMES.map((outcome) => ({ segment: null, outcome })),
    ...segments.flatMap((segment) => SCORED_OUTCOMES.map((outcome) => ({ segment, outcome }))),
  ];

  return narrowings.flatMap(({ segment, outcome }) => {
    const inSlice = scored.filter(
      (session) =>
        (segment === null || segmentOf(run, session) === segment) &&
        (outcome === null || session.outcome.status === outcome),
    );
    if (inSlice.length === 0) return [];
    const parts = [
      ...(outcome === null ? [] : [OUTCOME_WORDS[outcome]]),
      ...(segment === null ? [] : [segment]),
    ];
    const key = [
      ...(segment === null ? [] : [`segment:${segment}`]),
      ...(outcome === null ? [] : [`outcome:${outcome}`]),
    ];
    return [
      {
        key: key.length === 0 ? 'all' : key.join('|'),
        segment,
        outcome,
        label: labelOf(parts, inSlice.length, 'Every outcome'),
        sessions: inSlice,
      },
    ];
  });
};

/**
 * A quantile of a sample of durations, in whole milliseconds: **linear interpolation
 * between order statistics**, which is the `PERCENTILE.INC` of a spreadsheet and R's type 7.
 * `null` for an empty sample — a step nobody was timed on has no 90th percentile, and zero
 * would be a figure somebody measured.
 *
 * One definition for the whole aggregate: the timing table's median and the median the
 * heatmaps panel prints beside a screen are this function, called twice.
 */
export const quantileMs = (sample: readonly number[], p: number): number | null => {
  if (sample.length === 0) return null;
  const sorted = [...sample].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  const below = sorted[lower] ?? 0;
  const above = sorted[upper] ?? below;
  return Math.round(below + (position - lower) * (above - below));
};

/**
 * The spread of a sample, as the contract stores it: the four quantiles the screen prints
 * and the twelve bars it draws beside them, with the bar the median falls in.
 *
 * The bars start at zero and span the whole sample, so every one of them is accounted for
 * and the 90th percentile lands inside them — the two readings the contract holds to each
 * other. The bin width is `floor(max / 12) + 1` rather than `max / 12` for exactly that
 * reason: a width that divided the maximum exactly would put the slowest session in a
 * thirteenth bar that does not exist.
 *
 * `null` for an empty sample, by the same rule as `quantileMs`.
 */
export const distributionOf = (sample: readonly number[]): Distribution | null => {
  if (sample.length === 0) return null;
  const p25Ms = quantileMs(sample, 0.25) ?? 0;
  const p50Ms = quantileMs(sample, 0.5) ?? 0;
  const p75Ms = quantileMs(sample, 0.75) ?? 0;
  const p90Ms = quantileMs(sample, 0.9) ?? 0;
  const longestMs = Math.round(Math.max(...sample));
  const binWidthMs = Math.floor(longestMs / BIN_COUNT) + 1;
  const bins = new Array<number>(BIN_COUNT).fill(0);
  for (const value of sample) {
    const bin = Math.min(BIN_COUNT - 1, Math.floor(Math.max(0, value) / binWidthMs));
    bins[bin] = (bins[bin] ?? 0) + 1;
  }
  return {
    sampleCount: sample.length,
    p25Ms,
    p50Ms,
    p75Ms,
    p90Ms,
    binWidthMs,
    bins,
    medianBin: Math.floor(p50Ms / binWidthMs),
  };
};
