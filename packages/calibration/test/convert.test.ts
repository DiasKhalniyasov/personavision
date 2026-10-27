import { sessionSchema } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { ConversionError, convertRecord, convertRecords, loadManifest } from '../src/index.js';
import type { ConvertedSession } from '../src/index.js';
import {
  malformedRawRecords,
  mobileRecord,
  posterRecord,
  webpageRecord,
  withFixation,
} from './fixtures/raw-records.js';

/**
 * What this file asserts about the conversion (#86): that a hand-written record becomes a
 * session `packages/contract`'s own schema accepts with `kind: "real"`, that it carries the
 * display the humans saw rather than a default, that its fixations and saccades are the
 * record's own arithmetic, that every malformed case is rejected at the field that is wrong,
 * and that the same record converts to the same bytes twice.
 *
 * It reaches no network, needs no API key and downloads nothing: the material is
 * `test/fixtures/raw-records.ts`, hand-written and committed.
 */

/** The record every assertion that is not about a batch is made on. */
const webpage = (): readonly ConvertedSession[] => convertRecord(webpageRecord());

const serialise = (sessions: readonly ConvertedSession[]): string =>
  JSON.stringify(
    sessions.map((converted) => converted.session),
    null,
    2,
  );

describe('a converted record', () => {
  it('is one session per participant, numbered in the order the record lists them', () => {
    const converted = webpage();

    expect(converted.map((each) => each.participantId)).toEqual(['p-01', 'p-02', 'p-03']);
    expect(converted.map((each) => each.session.sessionId)).toEqual(['S-01', 'S-02', 'S-03']);
  });

  it("is a session the contract's own session schema accepts", () => {
    for (const { session } of webpage()) {
      const parsed = sessionSchema.safeParse(session);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.success).toBe(true);
    }
  });

  it('is real, with a participant, no persona and no seed', () => {
    for (const { session, participantId } of webpage()) {
      expect(session.kind).toBe('real');
      expect(session.participant).toEqual({ id: participantId });
      expect(session.persona).toBeNull();
      expect(session.seed).toBeNull();
    }
  });

  it('carries the display the humans saw, and not the image it was shown at', () => {
    const [first] = webpage();

    // The record's own viewport and scale, asserted field for field.
    expect(first.display).toEqual({ viewport: { width: 1920, height: 1200 }, scale: 1.5 });
    // And none of the three is the image's own size, so a default could not have produced it.
    expect(first.imageSize).toEqual({ width: 1280, height: 800 });
    expect(first.display.viewport.width).not.toBe(first.imageSize.width);
    expect(first.display.viewport.height).not.toBe(first.imageSize.height);
    expect(first.display.scale).not.toBe(1);

    // A second record's display is its own, not the first's and not a constant.
    const [mobile] = convertRecord(mobileRecord());
    expect(mobile.display).toEqual({ viewport: { width: 390, height: 844 }, scale: 3 });
  });

  it('names the viewing condition as its task and the category as its step', () => {
    const [webpageSession] = webpage();
    expect(webpageSession.session.taskId).toBe('free-viewing-7s');
    expect(webpageSession.session.screens[0].step).toBe('webpage');
    expect(webpageSession.session.outcome.step).toBe('webpage');
    expect(webpageSession.category).toBe('webpage');
    expect(webpageSession.viewingDurationSeconds).toBe(7);

    const [mobileSession] = convertRecord(mobileRecord());
    expect(mobileSession.session.taskId).toBe('free-viewing-1s');
    expect(mobileSession.session.screens[0].step).toBe('mobile');
  });

  it('has one screen: the image, unscrolled, with free viewing in words and no action', () => {
    const [{ session }] = webpage();

    expect(session.screens).toHaveLength(1);
    expect(session.screens[0].screenshot).toBe('webpage-0042.png');
    expect(session.screens[0].scrollY).toBe(0);
    expect(session.screens[0].intent.toLowerCase()).toContain('free viewing');
    expect(session.screens[0].intent.toLowerCase()).toContain('no task');
    expect(session.screens[0].decidedAction).toBe('none');
    expect(session.actions).toEqual([]);
    expect(session.variant).toBe('webpage-0042');
  });

  it('ran to completion, is attributed to the product, and no score may read it', () => {
    for (const { session } of webpage()) {
      expect(session.outcome.status).toBe('success');
      expect(session.outcome.attribution).toBe('product');
      expect(session.outcome.excludedFromScores).toBe(true);
      expect(session.outcome.reason.toLowerCase()).toContain('free viewing');
      expect(session.outcome.reason.toLowerCase()).toContain('no task');
    }
  });

  it('lasts as long as the exposure, and keeps a dwell that runs past the cut', () => {
    const [, , third] = webpage();

    expect(third.session.durationMs).toBe(7000);
    // `p-03` fixates at the last instant of the exposure and dwells 300 ms beyond it: the
    // ground truth is cut by onset, and the session's duration is still the exposure.
    expect(third.session.fixations[0].tMs).toBe(7000);
    expect(third.session.fixations[0].durationMs).toBe(300);

    expect(convertRecord(mobileRecord())[0].session.durationMs).toBe(1000);
  });

  it('belongs to a run named after the dataset, unless the caller names one', () => {
    const [{ session }] = webpage();
    expect(session.runId).toBe(loadManifest().dataset.id);

    const [named] = convertRecord(webpageRecord(), { runId: 'ueyes-7s-subset' });
    expect(named.session.runId).toBe('ueyes-7s-subset');
  });

  it('continues a run’s numbering when the caller says where to start', () => {
    const converted = convertRecord(webpageRecord(), { firstSessionNumber: 98 });
    expect(converted.map((each) => each.session.sessionId)).toEqual(['S-98', 'S-99', 'S-100']);
  });
});

describe('the fixations of a converted record', () => {
  it('run 0, 1, 2 … with strictly increasing onsets and no area of interest', () => {
    for (const { session } of webpage()) {
      session.fixations.forEach((fixation, position) => {
        expect(fixation.index).toBe(position);
        expect(fixation.screenIndex).toBe(0);
        expect(fixation.aoiId).toBeNull();
        if (position > 0) {
          expect(fixation.tMs).toBeGreaterThan(session.fixations[position - 1].tMs);
        }
      });
    }
  });

  it('are inside the image, in page and in viewport coordinates alike', () => {
    const { width, height } = { width: 1280, height: 800 };

    for (const { session, imageSize } of webpage()) {
      expect(imageSize).toEqual({ width, height });
      for (const fixation of session.fixations) {
        expect(fixation.x).toBeGreaterThanOrEqual(0);
        expect(fixation.y).toBeGreaterThanOrEqual(0);
        expect(fixation.x).toBeLessThanOrEqual(width);
        expect(fixation.y).toBeLessThanOrEqual(height);
        // One image is one page: there is nothing to scroll, so the two coincide.
        expect(fixation.pageX).toBe(fixation.x);
        expect(fixation.pageY).toBe(fixation.y);
      }
    }
  });

  it('keeps a fixation on the image’s own edge', () => {
    const [, second] = webpage();
    expect(second.session.fixations[0]).toMatchObject({ x: 1280, y: 800 });
  });
});

describe('the saccades of a converted record', () => {
  it('join consecutive fixations, and name two the session has', () => {
    for (const { session } of webpage()) {
      expect(session.saccades).toHaveLength(Math.max(session.fixations.length - 1, 0));
      session.saccades.forEach((saccade, position) => {
        expect(saccade.fromFixation).toBe(position);
        expect(saccade.toFixation).toBe(position + 1);
        expect(session.fixations[saccade.fromFixation]).toBeDefined();
        expect(session.fixations[saccade.toFixation]).toBeDefined();
      });
    }
  });

  it('carry the amplitude the coordinates imply and the duration the timestamps imply', () => {
    const [{ session }] = webpage();

    // (640, 180) → (400, 500) is 240 × 320, so 400 px; (400, 500) → (600, 20) is 200 × 480,
    // so 520 px. Both exact: the fixture is two Pythagorean triangles for that reason.
    expect(session.saccades.map((saccade) => saccade.amplitudePx)).toEqual([400, 520]);
    // The gap between one dwell ending and the next fixation beginning: 340 − 280, 600 − 560.
    expect(session.saccades.map((saccade) => saccade.durationMs)).toEqual([60, 40]);
  });

  it('are absent from a single-fixation scanpath', () => {
    expect(convertRecord(mobileRecord())[0].session.saccades).toEqual([]);
    expect(webpage()[2].session.saccades).toEqual([]);
  });
});

describe('a malformed record', () => {
  it.each(malformedRawRecords())('is rejected at $field: $case', ({ record, field }) => {
    let thrown: unknown;
    try {
      convertRecord(record);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConversionError);
    const error = thrown as ConversionError;
    expect(error.field).toBe(field);
    expect(error.rejection).toEqual({
      recordId: error.recordId,
      field,
      reason: error.message,
    });
    // The reason names the record and the field, so a reader of a batch's report can go to
    // the one line of the one file that is wrong.
    expect(error.rejection.reason).toContain(field);
    expect(error.rejection.reason).toContain(error.recordId);
  });

  it('names the record it was read from, even when its own id is what is wrong', () => {
    const { rejection } = (() => {
      try {
        convertRecord({ ...webpageRecord(), id: '  ' });
        throw new Error('an empty record id should not convert');
      } catch (error) {
        return error as ConversionError;
      }
    })();

    expect(rejection.field).toBe('id');
    expect(rejection.reason).toContain('id');
  });
});

describe('converting a batch', () => {
  const batch = () => [
    webpageRecord(),
    { ...mobileRecord(), image: null },
    posterRecord(),
    withFixation(mobileRecord(), 0, 0, { x: 391 }),
  ];

  it('reports every rejection and converts the rest', () => {
    const report = convertRecords(batch());

    expect(report.rejections.map((rejection) => [rejection.recordId, rejection.field])).toEqual([
      ['mobile-0007', 'image'],
      ['mobile-0007', 'participants[0].fixations[0].x'],
    ]);
    expect(report.sessions.map((each) => each.recordId)).toEqual([
      'webpage-0042',
      'webpage-0042',
      'webpage-0042',
      'poster-0003',
    ]);
  });

  it('numbers the sessions it converted without a gap, rejections consuming no number', () => {
    const report = convertRecords(batch());

    expect(report.sessions.map((each) => each.session.sessionId)).toEqual([
      'S-01',
      'S-02',
      'S-03',
      'S-04',
    ]);
  });

  it('rejects a record a reader could not parse, and keeps converting the batch', () => {
    // The type says a scanpath and a fixation are objects; a reader of an unparsable log row
    // hands over whatever it has, and reading a field off that would abort the whole batch.
    const unreadable = malformedRawRecords().filter((each) =>
      each.case.includes('could not parse'),
    );
    expect(unreadable).toHaveLength(2);

    const report = convertRecords([
      webpageRecord(),
      ...unreadable.map((each) => each.record),
      posterRecord(),
    ]);

    expect(report.rejections.map((each) => each.field)).toEqual(
      unreadable.map((each) => each.field),
    );
    expect(report.sessions.map((each) => each.session.sessionId)).toEqual([
      'S-01',
      'S-02',
      'S-03',
      'S-04',
    ]);
  });

  it('converts nothing and reports everything when every record is malformed', () => {
    const report = convertRecords(malformedRawRecords().map((each) => each.record));

    expect(report.sessions).toEqual([]);
    expect(report.rejections).toHaveLength(malformedRawRecords().length);
  });
});

describe('the conversion is deterministic', () => {
  it('converts the same record to byte-identical JSON', () => {
    const first = serialise(convertRecord(webpageRecord()));
    const second = serialise(convertRecord(webpageRecord()));

    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it('converts a record identically alone and in a batch at the same position', () => {
    const alone = serialise(convertRecord(webpageRecord()));
    const inBatch = convertRecords([webpageRecord(), posterRecord()]);

    expect(serialise(inBatch.sessions.slice(0, 3))).toBe(alone);
  });

  it('differs from a run at another offset only in the session id', () => {
    const atTheFront = convertRecords([posterRecord(), webpageRecord()]);
    const webpageSessions = atTheFront.sessions.filter((each) => each.recordId === 'webpage-0042');

    expect(webpageSessions.map((each) => each.session.sessionId)).toEqual(['S-02', 'S-03', 'S-04']);
    expect(serialise(webpageSessions).replaceAll(/"sessionId": "S-\d+"/g, '"sessionId"')).toBe(
      serialise(convertRecord(webpageRecord())).replaceAll(/"sessionId": "S-\d+"/g, '"sessionId"'),
    );
  });

  it('synthesises the start instant from the record and participant, inside the day the dataset was published', () => {
    const published = Date.parse(`${loadManifest().dataset.source.publishedOn}T00:00:00.000Z`);
    const day = 24 * 60 * 60 * 1000;
    const instants = webpage().map((each) => Date.parse(each.session.startedAt));

    // Stable: the same record and participant give the same instant.
    expect(webpage().map((each) => each.session.startedAt)).toEqual(
      convertRecord(webpageRecord()).map((each) => each.session.startedAt),
    );
    // Derived from the participant as well as the record: three participants, three instants.
    expect(new Set(instants).size).toBe(3);
    // And derived from the record: the same participant id under another record moves.
    const sameParticipantElsewhere = convertRecord({
      ...posterRecord(),
      participants: [
        { participantId: 'p-01', fixations: [{ tMs: 0, durationMs: 100, x: 1, y: 1 }] },
      ],
    })[0].session.startedAt;
    expect(Date.parse(sameParticipantElsewhere)).not.toBe(instants[0]);

    for (const instant of [...instants, Date.parse(sameParticipantElsewhere)]) {
      expect(instant).toBeGreaterThanOrEqual(published);
      expect(instant).toBeLessThan(published + day);
    }
  });
});
