/**
 * A UEyes record in, sessions the project's own schema accepts out.
 *
 * This is what makes calibration a comparison of two files of the same shape: a human's
 * free viewing of one screenshot becomes a session with `kind: "real"` and a `participant`,
 * which `packages/contract`'s `sessionSchema` accepts beside a simulated one. There is no
 * second format and no field invented here — the contract is the only place in this
 * repository where an artifact field name is declared, and every name below is one of its
 * own (#86, #11).
 *
 * **One session per participant.** The dataset's unit is an image; its gaze is one log per
 * participant who saw it. A session carries exactly one participant, so a record with three
 * participants converts to three sessions — the three files a reader would put beside three
 * simulated ones.
 *
 * **Geometry is image space**, as `src/types.ts` fixes it: the origin is the image's
 * top-left pixel, `x` runs right and `y` runs down. A UEyes record is one image with no
 * page, no scroll and no areas of interest, so a fixation's page and viewport coordinates
 * coincide, `scrollY` is `0` and `aoiId` is `null`. A fabricated area of interest would be
 * a claim about where attention landed that the dataset does not make.
 *
 * **Conversion is deterministic.** The same record converts to byte-identical JSON: no
 * clock, no random source, no floating-point operation whose result a platform may choose.
 * The one instant the dataset does not publish — when the viewing happened — is synthesised
 * from the record's own identity and documented below and in `docs/conversion.md`.
 *
 * `docs/FLOW.md` section 8 fixes the words: *fixation*, *saccade*, *dwell*, *scanpath*,
 * *participant*, *session*, *seed*.
 */

import { SCHEMA_VERSION, sessionSchema } from '@personavision/contract';
import type { Session } from '@personavision/contract';
import { loadManifest } from '../dataset/manifest.js';
import { RECORD_CATEGORIES, VIEWING_DURATIONS_SECONDS } from '../types.js';
import type { Display, ImageSize, RecordCategory, ViewingDurationSeconds } from '../types.js';

/**
 * One image as the dataset's own files describe it.
 *
 * `file` is the image's name as the dataset spells it, extension included: it becomes the
 * session's `screenshot`, which for a converted record points into the dataset rather than
 * into a run directory's `screenshots/`.
 */
export interface RawImage {
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The display the humans were shown an image at, as the dataset's own `info.csv` carries it:
 * the visible area in CSS pixels and the image pixels per CSS pixel.
 *
 * It is flat because a CSV row is flat. The conversion turns it into this package's
 * `Display`, whose fields are `packages/contract`'s viewport and device scale factor.
 */
export interface RawDisplay {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly scale: number;
}

/** One fixation of one participant's log: onset, dwell and the point, in image space. */
export interface RawFixation {
  /** Onset in milliseconds from the start of viewing. */
  readonly tMs: number;
  /** The dwell: how long the eye stayed. */
  readonly durationMs: number;
  readonly x: number;
  readonly y: number;
}

/** One participant's scanpath over one image, in the order the log records it. */
export interface RawScanpath {
  readonly participantId: string;
  readonly fixations: readonly RawFixation[];
}

/**
 * A UEyes record as a reader of the dataset's own files hands it over: **unvalidated**.
 *
 * The types here are deliberately loose where the files are loose — `category` and
 * `viewingDurationSeconds` are a string and a number rather than this package's unions,
 * `image` and `display` are nullable, a scanpath may be empty — because every one of those
 * is a malformed record this conversion has to reject by name rather than a state the type
 * system can rule out at the reader's expense.
 *
 * **Nobody has opened the archive.** `src/dataset/manifest.json` records the layout with
 * `verifiedAgainstArchive: false`, and #81 declared no raw type for exactly that reason: a
 * field name invented from a README is the same mistake as an invented checksum. So these
 * are *this package's* names for what `info.csv` and `eyetracker_logs/` carry — one row per
 * screenshot with its category and display, one log per participant — and the reader that
 * first opens the real files maps the real columns onto them. Nothing downstream of this
 * conversion sees a CSV column.
 */
export interface RawRecord {
  /** The dataset's own image name without its extension: stable across runs. */
  readonly id: string;
  /** One of `webpage`, `desktop`, `mobile`, `poster`; anything else is rejected. */
  readonly category: string;
  /** The viewing condition in seconds: UEyes publishes 1, 3 and 7. */
  readonly viewingDurationSeconds: number;
  readonly image: RawImage | null;
  readonly display: RawDisplay | null;
  /** One scanpath per participant who saw the image. */
  readonly participants: readonly RawScanpath[];
}

/**
 * One converted session, with the facts about it that the session shape has no field for.
 *
 * `display` is the one that matters and the reason this wrapper exists. The display the
 * humans saw has to travel with the session so that a prediction is later made at the
 * resolution they saw and never at a default (#11, user story 4) — and the contract's
 * session records a viewport only on a `persona`, which a real session does not have and
 * must not be given: a participant is a human, not a generated person. So it travels here,
 * beside the session, and `packages/contract` is unchanged by this ticket. The auto-decision
 * is on #86, for #2 and #11.
 *
 * The rest are the record's own facts, repeated here so that a caller grouping sessions by
 * category or by viewing condition — the scoring (#88), the report (#89), the CLI (#91) —
 * reads them from the conversion rather than re-deriving them from a session's strings.
 */
export interface ConvertedSession {
  /** The session itself: `kind: "real"`, a participant, no persona and no seed. */
  readonly session: Session;
  readonly recordId: string;
  readonly participantId: string;
  readonly category: RecordCategory;
  readonly viewingDurationSeconds: ViewingDurationSeconds;
  /** The image's own pixel size, which the fixations' coordinates are in. */
  readonly imageSize: ImageSize;
  /** The record's own viewport and scale — never a default, never the image's size. */
  readonly display: Display;
}

/** Why one record was rejected, naming the record and the field it was rejected at. */
export interface ConversionRejection {
  readonly recordId: string;
  /** The path of the offending field, e.g. `participants[1].fixations[3].tMs`. */
  readonly field: string;
  /** The whole sentence, naming both of the above. `ConversionError`'s message. */
  readonly reason: string;
}

/** What converting a batch produced: the sessions, and every record that was rejected. */
export interface ConversionReport {
  readonly sessions: readonly ConvertedSession[];
  readonly rejections: readonly ConversionRejection[];
}

/** One record could not be converted. The message names the record and the field. */
export class ConversionError extends Error {
  readonly recordId: string;
  readonly field: string;

  constructor(recordId: string, field: string, problem: string) {
    super(`record ${JSON.stringify(recordId)} is not convertible: ${field} ${problem}`);
    this.name = 'ConversionError';
    this.recordId = recordId;
    this.field = field;
  }

  /** The same facts as data, for a batch's report. */
  get rejection(): ConversionRejection {
    return { recordId: this.recordId, field: this.field, reason: this.message };
  }
}

export interface ConvertOptions {
  /**
   * The run the converted sessions belong to. Defaults to the dataset's own id from
   * `src/dataset/manifest.json`, so a converted session says which benchmark it came from
   * and no caller has to restate the name.
   */
  readonly runId?: string;
  /**
   * The number the first session of this conversion is given: `1` means `S-01`. A session id
   * is an ordinal within a run (`S-01`, `S-02` … `S-NN`, which is also its file name), so
   * numbering is the batch's business and a caller converting in several batches continues
   * where the last one stopped.
   */
  readonly firstSessionNumber?: number;
}

/**
 * What a free-viewing session says it was doing. A UEyes participant was given no task, so
 * the session's one screen states that in words rather than naming a goal it never had.
 */
const FREE_VIEWING_INTENT = 'Free viewing: look at the screenshot, with no task to do.';

/** A free-viewing participant decided nothing: there was nothing to decide. */
const FREE_VIEWING_DECIDED_ACTION = 'none';

/**
 * Why a free-viewing session is a `success` that no score may read.
 *
 * The viewing ran to completion, so `success` is the truth of the three outcomes the
 * contract names (`abandoned` is giving up, `failed` is ending with the task not done — and
 * there was no task). **The status enum is not extended**: a new value would ripple into
 * every exhaustive switch in the viewer and the scoring package, which is why #11's
 * breakdown lists that as an alternative it did not take. `excludedFromScores` is what keeps
 * such a session out of a product figure, and it is `true` on every converted session.
 */
const FREE_VIEWING_OUTCOME_REASON =
  'Free viewing of one screenshot with no task: the exposure ran to its end, so there was ' +
  'nothing to abandon or fail. Excluded from the product scores, which are about a task.';

/** `S-01`, `S-02` … `S-NN`, the contract's session id and the name of its file. */
const sessionIdOf = (number: number): string => `S-${String(number).padStart(2, '0')}`;

/** The viewing condition, as the session's `taskId`: `free-viewing-7s`. */
const taskIdOf = (viewingDurationSeconds: ViewingDurationSeconds): string =>
  `free-viewing-${viewingDurationSeconds}s`;

/**
 * The 24 hours after the dataset's publication date that a synthesised start instant falls
 * in. A day is wide enough that two sessions rarely share a millisecond and narrow enough
 * that the instant is unmistakably the publication date rather than a plausible-looking
 * measurement.
 */
const SYNTHETIC_START_WINDOW_MS = 24 * 60 * 60 * 1000;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * A stable 32-bit hash of a string — FNV-1a over its UTF-16 code units.
 *
 * `Math.imul` is exact, so this is the same number on every platform and in every run,
 * which is what a deterministic conversion needs. It is not a checksum and nothing is
 * verified with it.
 */
const hash32 = (text: string): number => {
  let value = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), FNV_PRIME);
  }
  return value >>> 0;
};

/**
 * When the viewing happened — synthesised, because the dataset publishes no wall-clock time.
 *
 * It is the dataset's own publication date (`manifest.json`'s `dataset.source.publishedOn`,
 * read rather than restated) plus a millisecond offset derived from the record and
 * participant id. So it is **a label, not a measurement**: stable for a given session,
 * distinct between sessions, obviously synthetic to anyone who reads it, and derived from
 * the record's own identity as #86 requires. `docs/conversion.md` states it once more.
 */
const syntheticStartedAt = (
  publishedOn: string,
  recordId: string,
  participantId: string,
): string => {
  const published = Date.parse(`${publishedOn}T00:00:00.000Z`);
  const offset = hash32(`${recordId}\u0000${participantId}`) % SYNTHETIC_START_WINDOW_MS;
  return new Date(published + offset).toISOString();
};

const isRecordCategory = (category: string): category is RecordCategory =>
  (RECORD_CATEGORIES as readonly string[]).includes(category);

const isViewingDuration = (seconds: number): seconds is ViewingDurationSeconds =>
  (VIEWING_DURATIONS_SECONDS as readonly number[]).includes(seconds);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isMeasurement = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The rejection of one record at one field, ready to throw.
 *
 * Every guard below throws it rather than calling a function that throws, so that the
 * compiler narrows what the guard ruled out — a `category` that is one of the four, an
 * `image` that is there — and the conversion works with proven values.
 */
const rejection = (recordId: string, field: string, problem: string): ConversionError =>
  new ConversionError(recordId, field, problem);

/**
 * The record's identity, category, viewing condition, image and display, checked once per
 * record: everything a session needs that is not a fixation.
 */
interface RecordFacts {
  readonly recordId: string;
  readonly category: RecordCategory;
  readonly viewingDurationSeconds: ViewingDurationSeconds;
  readonly exposureMs: number;
  readonly imageFile: string;
  readonly imageSize: ImageSize;
  readonly display: Display;
}

const recordFacts = (raw: RawRecord): RecordFacts => {
  const recordId = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (recordId === '') {
    throw rejection(
      String(raw.id),
      'id',
      'is empty: a record is identified by the dataset image it belongs to, and a session ' +
        'that cannot name its record cannot be traced back to the humans who produced it',
    );
  }

  if (!isRecordCategory(raw.category)) {
    throw rejection(
      recordId,
      'category',
      `is ${JSON.stringify(raw.category)}, which is not one of the dataset's UI types ` +
        `(${RECORD_CATEGORIES.join(', ')}): a score is reported per category, so an unknown ` +
        'one would be counted under a heading nobody chose',
    );
  }

  if (!isViewingDuration(raw.viewingDurationSeconds)) {
    throw rejection(
      recordId,
      'viewingDurationSeconds',
      `is ${JSON.stringify(raw.viewingDurationSeconds)}, and UEyes publishes its ground truth ` +
        `at ${VIEWING_DURATIONS_SECONDS.join(', ')} seconds of free viewing: a figure measured ` +
        'against one of those is not the figure measured against another',
    );
  }

  const image = raw.image;
  if (image === null || image === undefined) {
    throw rejection(
      recordId,
      'image',
      'is missing: a record is the gaze over one image, and without it there is nothing the ' +
        'fixations are coordinates in',
    );
  }
  if (typeof image.file !== 'string' || image.file.trim() === '') {
    throw rejection(
      recordId,
      'image.file',
      "is empty: the session's screenshot names the image file",
    );
  }
  for (const side of ['width', 'height'] as const) {
    if (!isPositiveInteger(image[side])) {
      throw rejection(
        recordId,
        `image.${side}`,
        `is ${JSON.stringify(image[side])}: an image's ${side} is a whole number of pixels ` +
          'above zero, and it is what a fixation is checked against',
      );
    }
  }

  const display = raw.display;
  if (display === null || display === undefined) {
    throw rejection(
      recordId,
      'display',
      'is missing: a prediction is made at the resolution the humans saw and never at a ' +
        'default, so a record that does not say what they saw cannot be converted',
    );
  }
  for (const side of ['viewportWidth', 'viewportHeight'] as const) {
    if (!isPositiveInteger(display[side])) {
      throw rejection(
        recordId,
        `display.${side}`,
        `is ${JSON.stringify(display[side])}: a viewport is a whole number of CSS pixels above zero`,
      );
    }
  }
  if (typeof display.scale !== 'number' || !Number.isFinite(display.scale) || display.scale <= 0) {
    throw rejection(
      recordId,
      'display.scale',
      `is ${JSON.stringify(display.scale)}: the scale is image pixels per CSS pixel, which is ` +
        'finite and above zero',
    );
  }

  return {
    recordId,
    category: raw.category,
    viewingDurationSeconds: raw.viewingDurationSeconds,
    exposureMs: raw.viewingDurationSeconds * 1000,
    imageFile: image.file,
    imageSize: { width: image.width, height: image.height },
    display: {
      viewport: { width: display.viewportWidth, height: display.viewportHeight },
      scale: display.scale,
    },
  };
};

/**
 * One participant's fixations, checked and turned into the contract's.
 *
 * The checks are the ones a scanpath has to pass to be a scanpath: it exists, its timestamps
 * run forwards and do not overlap, and every point is on the image. Each failure names the
 * fixation it happened at, because "a fixation outside the image" is not a fact a reader can
 * act on and `participants[1].fixations[3].x` is.
 */
const convertFixations = (
  facts: RecordFacts,
  scanpath: RawScanpath,
  participantPosition: number,
): Session['fixations'] => {
  const at = (index: number, field: string): string =>
    `participants[${participantPosition}].fixations[${index}].${field}`;
  const { recordId, imageSize, exposureMs } = facts;

  if (!Array.isArray(scanpath.fixations)) {
    throw rejection(
      recordId,
      `participants[${participantPosition}].fixations`,
      'is not a list of fixations: a scanpath is the ordered fixations of one participant',
    );
  }
  if (scanpath.fixations.length === 0) {
    throw rejection(
      recordId,
      `participants[${participantPosition}].fixations`,
      `is empty: participant ${JSON.stringify(scanpath.participantId)} has no gaze over this ` +
        'record, and a scanpath with no fixations is nothing to compare a prediction with',
    );
  }

  return scanpath.fixations.map((fixation, index) => {
    for (const field of ['tMs', 'durationMs', 'x', 'y'] as const) {
      if (!isMeasurement(fixation[field])) {
        throw rejection(
          recordId,
          at(index, field),
          `is ${JSON.stringify(fixation[field])}: a fixation's onset, dwell and coordinates are ` +
            'finite and never negative',
        );
      }
    }

    const previous = index === 0 ? null : scanpath.fixations[index - 1];
    if (previous !== null) {
      const previousEnd = previous.tMs + previous.durationMs;
      if (fixation.tMs < previousEnd) {
        throw rejection(
          recordId,
          at(index, 'tMs'),
          `is ${fixation.tMs} ms, which is not after fixation ${index - 1}, whose dwell ends at ` +
            `${previousEnd} ms: a scanpath's fixations run forwards in time and do not overlap`,
        );
      }
    }

    if (fixation.tMs > exposureMs) {
      throw rejection(
        recordId,
        at(index, 'tMs'),
        `is ${fixation.tMs} ms, past the ${exposureMs} ms the record was viewed for: the ` +
          'ground truth is cut at the viewing condition, so a fixation cannot begin after it',
      );
    }

    if (fixation.x > imageSize.width) {
      throw rejection(
        recordId,
        at(index, 'x'),
        `is ${fixation.x}, outside the image's ${imageSize.width} px width: a point off the ` +
          'image is not somewhere a human looked at it',
      );
    }
    if (fixation.y > imageSize.height) {
      throw rejection(
        recordId,
        at(index, 'y'),
        `is ${fixation.y}, outside the image's ${imageSize.height} px height: a point off the ` +
          'image is not somewhere a human looked at it',
      );
    }

    return {
      index,
      // One image is one screen. A UEyes record has no second page and no scroll, so the
      // page and viewport coordinates coincide and `scrollY` is 0; `aoiId` is null because
      // the image has no areas of interest to have landed in.
      screenIndex: 0,
      tMs: fixation.tMs,
      durationMs: fixation.durationMs,
      x: fixation.x,
      y: fixation.y,
      pageX: fixation.x,
      pageY: fixation.y,
      aoiId: null,
    };
  });
};

/**
 * The saccades between consecutive fixations: the amplitude the coordinates imply and the
 * duration the timestamps imply.
 *
 * The amplitude is `Math.sqrt` of the squared difference rather than `Math.hypot`, whose
 * precision the language leaves to the implementation: IEEE 754 specifies a square root
 * exactly, so two machines write the same bytes. The duration is the gap between one dwell's
 * end and the next onset, which `convertFixations` has already held to being non-negative.
 */
const saccadesBetween = (fixations: Session['fixations']): Session['saccades'] =>
  fixations.slice(1).map((fixation, position) => {
    const previous = fixations[position];
    const dx = fixation.x - previous.x;
    const dy = fixation.y - previous.y;
    return {
      fromFixation: previous.index,
      toFixation: fixation.index,
      amplitudePx: Math.sqrt(dx * dx + dy * dy),
      durationMs: fixation.tMs - (previous.tMs + previous.durationMs),
    };
  });

const sessionOf = (
  facts: RecordFacts,
  runId: string,
  publishedOn: string,
  sessionNumber: number,
  participantId: string,
  fixations: Session['fixations'],
): Session => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId: sessionIdOf(sessionNumber),
  runId,
  // The image is what was looked at, so it is this session's variant: a converted batch is
  // one benchmark's worth of sessions, grouped by the screenshot they are about.
  variant: facts.recordId,
  taskId: taskIdOf(facts.viewingDurationSeconds),
  kind: 'real',
  // A participant is a human being, not a generated person: no persona, and no seed, because
  // nothing about this session was sampled.
  persona: null,
  participant: { id: participantId },
  seed: null,
  startedAt: syntheticStartedAt(publishedOn, facts.recordId, participantId),
  // The session lasted as long as the humans were shown the image. A dwell may run past that
  // cut — the dataset cuts the scanpath by onset — and the exposure is still what happened.
  durationMs: facts.exposureMs,
  screens: [
    {
      index: 0,
      step: facts.category,
      screenshot: facts.imageFile,
      scrollY: 0,
      intent: FREE_VIEWING_INTENT,
      decidedAction: FREE_VIEWING_DECIDED_ACTION,
    },
  ],
  fixations,
  saccades: saccadesBetween(fixations),
  // Free viewing is looking, not doing: no click, no scroll, no typing, nothing to abandon.
  actions: [],
  outcome: {
    status: 'success',
    step: facts.category,
    reason: FREE_VIEWING_OUTCOME_REASON,
    attribution: 'product',
    excludedFromScores: true,
  },
  // Nothing automated this session: a human looked at an image.
  integrity: { selectorFailures: 0, retries: 0 },
});

/**
 * The last gate: the converted session is handed to the contract's own schema, and a session
 * it does not accept is a rejection naming the path it failed at.
 *
 * Everything above should make this unreachable — that is the point. It is here so that a
 * defect in this converter cannot put an invalid session in a run directory, and so that the
 * claim "a converted record satisfies `sessionSchema`" is structural rather than a test's
 * promise. The session that is returned is the one built above, not the schema's output, so
 * the field order of the JSON is this module's and stays byte-identical.
 */
const validated = (recordId: string, session: Session): Session => {
  const parsed = sessionSchema.safeParse(session);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw rejection(
      recordId,
      `session.${issue.path.join('.')}`,
      `was not accepted by the contract's session schema: ${issue.message}. This is a defect ` +
        'in the conversion, not in the record',
    );
  }
  return session;
};

/**
 * One UEyes record into one session per participant who saw it.
 *
 * Throws `ConversionError` naming the record and the offending field if the record is
 * malformed. `convertRecords` is the batch form, which collects those rejections instead.
 */
export const convertRecord = (
  raw: RawRecord,
  options: ConvertOptions = {},
): readonly ConvertedSession[] => {
  const manifest = loadManifest();
  const runId = options.runId ?? manifest.dataset.id;
  const firstSessionNumber = options.firstSessionNumber ?? 1;
  const facts = recordFacts(raw);

  if (!Array.isArray(raw.participants)) {
    throw rejection(
      facts.recordId,
      'participants',
      'is not a list of scanpaths: a record carries one scanpath per participant who saw the image',
    );
  }
  if (raw.participants.length === 0) {
    throw rejection(
      facts.recordId,
      'participants',
      'is empty: a record is the gaze of the humans who saw an image, and no participant ' +
        'means no session to convert',
    );
  }

  const seen = new Set<string>();
  return raw.participants.map((scanpath, position) => {
    const participantId =
      typeof scanpath.participantId === 'string' ? scanpath.participantId.trim() : '';
    if (participantId === '') {
      throw rejection(
        facts.recordId,
        `participants[${position}].participantId`,
        'is empty: a real session names the participant whose gaze it is, which is what it ' +
          'carries instead of a persona',
      );
    }
    if (seen.has(participantId)) {
      throw rejection(
        facts.recordId,
        `participants[${position}].participantId`,
        `is ${JSON.stringify(participantId)}, which an earlier scanpath of this record already ` +
          'claims: one participant saw one image once, and two scanpaths under one id are two ' +
          'sessions nobody can tell apart',
      );
    }
    seen.add(participantId);

    const fixations = convertFixations(facts, scanpath, position);
    const session = validated(
      facts.recordId,
      sessionOf(
        facts,
        runId,
        manifest.dataset.source.publishedOn,
        firstSessionNumber + position,
        participantId,
        fixations,
      ),
    );

    return {
      session,
      recordId: facts.recordId,
      participantId,
      category: facts.category,
      viewingDurationSeconds: facts.viewingDurationSeconds,
      imageSize: facts.imageSize,
      display: facts.display,
    };
  });
};

/**
 * A batch of records into sessions, reporting every rejection rather than stopping at the
 * first.
 *
 * A record converts whole or not at all: a scanpath this conversion cannot read rejects the
 * record it belongs to, so no figure is ever measured against ground truth that was quietly
 * trimmed of a participant. The rejections come back in the order the records were given.
 *
 * Session ids are ordinals within the batch, numbered in the order the records and their
 * participants arrive and continuing from `firstSessionNumber`. A rejected record consumes
 * no number, so the ids of what did convert run `S-01`, `S-02` … unbroken.
 */
export const convertRecords = (
  raws: readonly RawRecord[],
  options: ConvertOptions = {},
): ConversionReport => {
  const sessions: ConvertedSession[] = [];
  const rejections: ConversionRejection[] = [];

  for (const raw of raws) {
    try {
      sessions.push(
        ...convertRecord(raw, {
          ...options,
          firstSessionNumber: (options.firstSessionNumber ?? 1) + sessions.length,
        }),
      );
    } catch (error) {
      if (!(error instanceof ConversionError)) throw error;
      rejections.push(error.rejection);
    }
  }

  return { sessions, rejections };
};
