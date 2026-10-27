/**
 * Hand-written UEyes records, in the shape a reader of the dataset's own files hands them
 * over (`src/convert/session.ts`'s `RawRecord`).
 *
 * **Committed, hand-written, and no download.** #86 is tested against these and nothing else:
 * no dataset byte is vendored (the auto-decision on #11), no network is reached and no API
 * key exists. The numbers are chosen so that the arithmetic a test asserts is exact — the
 * two saccades of `p-01` are a 3-4-5 and a 5-12-13 triangle, so their amplitudes are 400 px
 * and 520 px on the nose rather than a float a reader has to trust.
 *
 * Every malformed record below is the valid one with **exactly one thing broken**, so a
 * rejection's field names the thing that was broken and the test reads as a table of cases.
 *
 * Geometry is image space: origin at the image's top-left pixel, `x` right, `y` down.
 */

import type { RawFixation, RawRecord, RawScanpath } from '../../src/index.js';

/**
 * A webpage record: three participants, seven seconds of free viewing.
 *
 * The display is deliberately **not** the image's size in any of its three numbers — the
 * humans saw a 1280 × 800 screenshot on a 1920 × 1200 display at 1.5 image pixels per CSS
 * pixel — so a conversion that quietly defaulted the display to the image would be caught by
 * the assertion rather than passing it.
 */
export const webpageRecord = (): RawRecord => ({
  id: 'webpage-0042',
  category: 'webpage',
  viewingDurationSeconds: 7,
  image: { file: 'webpage-0042.png', width: 1280, height: 800 },
  display: { viewportWidth: 1920, viewportHeight: 1200, scale: 1.5 },
  participants: [
    {
      participantId: 'p-01',
      fixations: [
        // (640, 180) → (400, 500): dx 240, dy 320, so the saccade is 400 px exactly, and
        // 340 − (0 + 280) = 60 ms of it.
        { tMs: 0, durationMs: 280, x: 640, y: 180 },
        // (400, 500) → (600, 20): dx 200, dy 480, so 520 px exactly, in 600 − 560 = 40 ms.
        { tMs: 340, durationMs: 220, x: 400, y: 500 },
        { tMs: 600, durationMs: 300, x: 600, y: 20 },
      ],
    },
    {
      participantId: 'p-02',
      // Both corners: a fixation at exactly (1280, 800) is on the image's edge, not outside
      // it, and converts — the same inclusive upper edge the scanpath metrics (#84) read a
      // boundary fixation at.
      fixations: [
        { tMs: 120, durationMs: 400, x: 1280, y: 800 },
        { tMs: 600, durationMs: 250, x: 0, y: 0 },
      ],
    },
    {
      participantId: 'p-03',
      // One fixation, beginning at the very last instant of the exposure and dwelling past
      // it: the dataset cuts a scanpath by onset, and a single fixation makes no saccade.
      fixations: [{ tMs: 7000, durationMs: 300, x: 300, y: 650 }],
    },
  ],
});

/** A mobile record: one participant, one fixation, the one-second viewing condition. */
export const mobileRecord = (): RawRecord => ({
  id: 'mobile-0007',
  category: 'mobile',
  viewingDurationSeconds: 1,
  image: { file: 'mobile-0007.png', width: 390, height: 844 },
  display: { viewportWidth: 390, viewportHeight: 844, scale: 3 },
  participants: [
    { participantId: 'p-11', fixations: [{ tMs: 0, durationMs: 950, x: 195, y: 300 }] },
  ],
});

/** A poster record, to give a batch a third category and a second viewing condition. */
export const posterRecord = (): RawRecord => ({
  id: 'poster-0003',
  category: 'poster',
  viewingDurationSeconds: 3,
  image: { file: 'poster-0003.png', width: 600, height: 900 },
  display: { viewportWidth: 1920, viewportHeight: 1200, scale: 1 },
  participants: [
    {
      participantId: 'p-21',
      fixations: [
        { tMs: 0, durationMs: 300, x: 300, y: 450 },
        { tMs: 400, durationMs: 260, x: 300, y: 50 },
      ],
    },
  ],
});

/** The same record with one scanpath replaced. */
export const withScanpath = (
  record: RawRecord,
  position: number,
  change: Partial<RawScanpath>,
): RawRecord => ({
  ...record,
  participants: record.participants.map((scanpath, index) =>
    index === position ? { ...scanpath, ...change } : scanpath,
  ),
});

/** The same record with one fixation of one scanpath changed. */
export const withFixation = (
  record: RawRecord,
  participant: number,
  fixation: number,
  change: Partial<RawFixation>,
): RawRecord =>
  withScanpath(record, participant, {
    fixations: record.participants[participant].fixations.map((each, index) =>
      index === fixation ? { ...each, ...change } : each,
    ),
  });

/** One malformed record, and the field a rejection has to name. */
export interface MalformedRawRecord {
  /** What is wrong with it, in the words #86 uses. */
  readonly case: string;
  /** The field path the rejection names. */
  readonly field: string;
  readonly record: RawRecord;
}

/**
 * Every malformed case #86 names, and the ones a reader of a CSV will meet next to them.
 *
 * The first five are the ticket's own list — no image, no fixations, timestamps out of order,
 * a fixation outside the image, an unknown category. The rest are the same kind of fault in
 * the fields the ticket's other criteria depend on, above all a missing display: a prediction
 * is made at the resolution the humans saw and never at a default, so a record that does not
 * say what they saw is not convertible either.
 */
export const malformedRawRecords = (): readonly MalformedRawRecord[] => [
  { case: 'no image', field: 'image', record: { ...webpageRecord(), image: null } },
  {
    case: 'no fixations',
    field: 'participants[1].fixations',
    record: withScanpath(webpageRecord(), 1, { fixations: [] }),
  },
  {
    case: 'timestamps out of order',
    field: 'participants[0].fixations[2].tMs',
    record: withFixation(webpageRecord(), 0, 2, { tMs: 400 }),
  },
  {
    case: 'a fixation outside the image, to the right',
    field: 'participants[0].fixations[1].x',
    record: withFixation(webpageRecord(), 0, 1, { x: 1281 }),
  },
  {
    case: 'a fixation outside the image, below it',
    field: 'participants[0].fixations[1].y',
    record: withFixation(webpageRecord(), 0, 1, { y: 801 }),
  },
  {
    case: 'an unknown category',
    field: 'category',
    record: { ...webpageRecord(), category: 'landing-page' },
  },
  {
    case: 'an unknown viewing condition',
    field: 'viewingDurationSeconds',
    record: { ...webpageRecord(), viewingDurationSeconds: 5 },
  },
  { case: 'no display', field: 'display', record: { ...webpageRecord(), display: null } },
  {
    case: 'a display with no scale',
    field: 'display.scale',
    record: {
      ...webpageRecord(),
      display: { viewportWidth: 1920, viewportHeight: 1200, scale: 0 },
    },
  },
  {
    case: 'an image of no width',
    field: 'image.width',
    record: { ...webpageRecord(), image: { file: 'webpage-0042.png', width: 0, height: 800 } },
  },
  {
    case: 'no participants at all',
    field: 'participants',
    record: { ...webpageRecord(), participants: [] },
  },
  {
    case: 'two scanpaths under one participant id',
    field: 'participants[1].participantId',
    record: withScanpath(webpageRecord(), 1, { participantId: 'p-01' }),
  },
  {
    case: 'a participant with no id',
    field: 'participants[2].participantId',
    record: withScanpath(webpageRecord(), 2, { participantId: '  ' }),
  },
  {
    case: 'two fixations at one instant, the first dwelling for no time',
    field: 'participants[0].fixations[1].tMs',
    record: withFixation(withFixation(webpageRecord(), 0, 0, { durationMs: 0 }), 0, 1, { tMs: 0 }),
  },
  {
    case: 'a fixation beginning after the exposure',
    field: 'participants[0].fixations[2].tMs',
    record: withFixation(webpageRecord(), 0, 2, { tMs: 7001 }),
  },
  {
    case: 'a negative coordinate',
    field: 'participants[0].fixations[0].x',
    record: withFixation(webpageRecord(), 0, 0, { x: -1 }),
  },
  {
    case: 'a dwell that is not a number',
    field: 'participants[0].fixations[0].durationMs',
    record: withFixation(webpageRecord(), 0, 0, { durationMs: Number.NaN }),
  },
  { case: 'a record with no id', field: 'id', record: { ...webpageRecord(), id: '  ' } },
];
