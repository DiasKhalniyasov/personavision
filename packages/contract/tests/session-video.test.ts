import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Session, SessionVideo, Violation } from '../src/index.js';
import {
  readRun,
  runPaths,
  sessionSchema,
  validate,
  VIDEO_CAP_MS,
  videoCapSchema,
  writeRun,
} from '../src/index.js';
import {
  absentVideo,
  recordedVideo,
  temporaryRunDir,
  validArtifact,
  validSession,
} from './fixtures.js';

/**
 * A session's video: `videos/S-NN.webm`, its duration, the cap it hit if it hit one, and
 * the millisecond offset of every screen and every action into the recording — the one
 * spelling of a session video in this repository (`docs/FLOW.md` section 16, the owner's
 * decision on #220).
 *
 * The block is **optional with no default**. A session recorded before this step names no
 * video, and a recording that could not be made is recorded as absent **with its reason**:
 * neither is a zero somebody measured, and neither costs the session the rest of itself.
 *
 * What is asserted here is what the contract refuses and where it says so, because the
 * offsets are the whole point of the block — a recommendation citing `S-62 · 0:48` resolves
 * by reading them, so a list of the wrong length has to be a parse error and not a
 * misalignment nobody notices.
 */

/** The layout, relative, for the file a violation names. */
const label = runPaths('');

const offenders = (violations: ReadonlyArray<Violation>): string[] =>
  violations.map((violation) => `${violation.file}${violation.path}`);

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Where a schema rejected a value, and what it said about it. */
const rejections = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('the value was accepted, and should not have been');
  return {
    paths: result.error.issues.map((issue) => issue.path.join('/')),
    messages: result.error.issues.map((issue) => issue.message),
  };
};

const accepted = (session: Session): Session => {
  const result = sessionSchema.safeParse(session);
  if (!result.success) {
    throw new Error(`the session was rejected: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
};

/** `validSession`, with the given video block instead of none. */
const withVideo = (video: SessionVideo): Session => ({ ...validSession('S-01', 'A'), video });

describe('a session that names no video', () => {
  it('parses: a session recorded before this step carries none', () => {
    const session = accepted(validSession('S-01', 'A'));

    expect(session.video).toBeUndefined();
  });

  it('gains no default, so an absent video is never read as a recording of nothing', () => {
    expect(Object.hasOwn(accepted(validSession('S-01', 'A')), 'video')).toBe(false);
  });

  it('is still refused a video of some shape the contract does not declare', () => {
    expect(rejections(sessionSchema, withVideo({ state: 'muxed' } as never)).paths).toContain(
      'video/state',
    );
  });
});

describe('a session that names its recording', () => {
  it('parses the path the paths module spells, the duration and the offsets', () => {
    const session = accepted(withVideo(recordedVideo('S-01')));

    expect(session.video).toEqual({
      state: 'recorded',
      path: 'videos/S-01.webm',
      durationMs: 38_000,
      truncated: null,
      screenOffsetsMs: [0],
      actionOffsetsMs: [2400],
    });
    expect(session.video).toMatchObject({ path: runPaths('').video('S-01') });
  });

  it('aligns each offset with its own entry, so screens[0] is the first screen offset', () => {
    const session = validSession('S-01', 'A');
    const screens = [
      session.screens[0],
      { ...session.screens[0], index: 1, step: 'confirm' },
    ] as Session['screens'];
    const video = { ...recordedVideo('S-01'), screenOffsetsMs: [0, 12_400] };

    const parsed = accepted({ ...session, screens, video });

    expect(parsed.video).toMatchObject({ screenOffsetsMs: [0, 12_400] });
  });

  it('refuses a screen-offset list of a different length from its own screens', () => {
    const { paths, messages } = rejections(
      sessionSchema,
      withVideo({ ...recordedVideo('S-01'), screenOffsetsMs: [0, 12_400] }),
    );

    expect(paths).toEqual(['video/screenOffsetsMs']);
    expect(messages[0]).toMatch(/2 offsets for 1 screen\b/);
  });

  it('refuses an action-offset list of a different length from its own actions', () => {
    const { paths, messages } = rejections(
      sessionSchema,
      withVideo({ ...recordedVideo('S-01'), actionOffsetsMs: [] }),
    );

    expect(paths).toEqual(['video/actionOffsetsMs']);
    expect(messages[0]).toMatch(/0 offsets for 1 action\b/);
  });

  it('refuses an offset past the end of the recording: a cited timestamp has to resolve', () => {
    const { paths, messages } = rejections(
      sessionSchema,
      withVideo({ ...recordedVideo('S-01'), actionOffsetsMs: [38_001] }),
    );

    expect(paths).toEqual(['video/actionOffsetsMs/0']);
    expect(messages[0]).toMatch(/past the end of a 38000 ms recording/);
  });

  it('accepts two entries at one offset: two things can happen in one millisecond', () => {
    const session = validSession('S-01', 'A');
    const actions = [session.actions[0], { ...session.actions[0] }] as Session['actions'];
    const video = { ...recordedVideo('S-01'), actionOffsetsMs: [2400, 2400] };

    expect(accepted({ ...session, actions, video }).video).toMatchObject({
      actionOffsetsMs: [2400, 2400],
    });
  });

  it('names a recording that is not this session\u2019s: a replay plays its own participant', () => {
    const { paths, messages } = rejections(
      sessionSchema,
      withVideo({ ...recordedVideo('S-01'), path: runPaths('').video('S-02') }),
    );

    expect(paths).toEqual(['video/path']);
    expect(messages[0]).toMatch(
      /is not this session's recording: S-01's video is "videos\/S-01\.webm"/,
    );
  });

  it('refuses an offset of null when the recording was not truncated', () => {
    const { paths, messages } = rejections(
      sessionSchema,
      withVideo({ ...recordedVideo('S-01'), actionOffsetsMs: [null] }),
    );

    expect(paths).toEqual(['video/actionOffsetsMs/0']);
    expect(messages[0]).toMatch(/was not truncated, so it reaches every entry/);
  });
});

describe('a recording that hit a cap', () => {
  /**
   * A session that ran twelve minutes against a recording the session cap stopped at ten:
   * the first action is in the video and the second happened after it stopped.
   */
  const pastTheCap = (): Session => {
    const session = validSession('S-01', 'A');
    return {
      ...session,
      durationMs: 720_000,
      actions: [session.actions[0], { ...session.actions[0], tMs: 700_000 }] as Session['actions'],
      video: {
        ...recordedVideo('S-01'),
        truncated: 'session',
        durationMs: VIDEO_CAP_MS.session,
        actionOffsetsMs: [2400, null],
      },
    };
  };

  it('states which cap stopped it and the duration it reached', () => {
    const session = accepted(pastTheCap());

    expect(session.video).toMatchObject({ truncated: 'session', durationMs: 600_000 });
    // The duration it reached is the recording's own, and is recorded once: the truncation
    // names the cap and nothing else.
    expect(session.durationMs).toBe(720_000);
  });

  it('gives the entries it stopped before no offset, rather than a frame they are not on', () => {
    const session = accepted(pastTheCap());

    expect(session.video).toMatchObject({ actionOffsetsMs: [2400, null] });
    // Still one offset per action: the alignment is what makes the first one resolvable.
    expect(session.actions).toHaveLength(2);
  });

  it('still refuses an offset past the end of a truncated recording', () => {
    const past = pastTheCap();
    const video = { ...past.video, actionOffsetsMs: [2400, 700_000] } as Session['video'];

    expect(rejections(sessionSchema, { ...past, video }).paths).toEqual([
      'video/actionOffsetsMs/1',
    ]);
  });

  it('names the caps the owner chose, and what each one is, in one place', () => {
    expect(videoCapSchema.options).toEqual(['screen', 'session']);
    expect(VIDEO_CAP_MS).toEqual({ screen: 30_000, session: 600_000 });
  });

  it('is a cap the contract declares, never one a recorder named for itself', () => {
    expect(
      rejections(sessionSchema, withVideo({ ...recordedVideo('S-01'), truncated: 'disk' as never }))
        .paths,
    ).toEqual(['video/truncated']);
  });
});

describe('a recording that could not be made', () => {
  it('is absent with its reason, and leaves the session complete and scoreable', () => {
    const session = accepted(withVideo(absentVideo()));

    expect(session.video).toEqual({
      state: 'absent',
      reason: 'The browser context was closed before the recording was flushed.',
    });
    // "A failed recording is not a failed session" (#220): the outcome is untouched, and
    // the session still counts towards the scores.
    expect(session.outcome.status).toBe('success');
    expect(session.outcome.excludedFromScores).toBe(false);
    expect(session.screens).toHaveLength(1);
    expect(session.actions).toHaveLength(1);
  });

  it('carries its reason in words, never as a blank somebody has to interpret', () => {
    const { paths, messages } = rejections(
      sessionSchema,
      withVideo({ ...absentVideo(), reason: '' }),
    );

    expect(paths).toEqual(['video/reason']);
    expect(messages[0]).toMatch(/records why, in words/);
  });

  it('records no path, duration or offsets: there is no recording to describe', () => {
    const { paths, messages } = rejections(
      sessionSchema,
      withVideo({ ...absentVideo(), durationMs: 0 } as never),
    );

    expect(paths).toEqual(['video']);
    expect(messages[0]).toContain('durationMs');
  });
});

describe('a session video on disk', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('round-trips through the run directory: one recording and one stated absence', async () => {
    const artifact = validArtifact();
    const sessions = [
      { ...artifact.sessions[0], video: recordedVideo('S-01') },
      { ...artifact.sessions[1], video: absentVideo() },
    ];

    await writeRun(dir, { ...artifact, sessions });

    expect(await validate(dir)).toEqual([]);
    const read = await readRun(dir);
    expect(read.sessions[0].video).toEqual(recordedVideo('S-01'));
    expect(read.sessions[1].video).toEqual(absentVideo());
  });

  it('validates a run whose sessions name no video, as every run written before this step does', async () => {
    await writeRun(dir, validArtifact());

    expect(await validate(dir)).toEqual([]);
    const read = await readRun(dir);
    expect(read.sessions.map((session) => session.video)).toEqual([undefined, undefined]);
  });

  it('names the file and the path of an offset list that does not line up', async () => {
    await writeRun(dir, validArtifact());
    const session = {
      ...validSession('S-01', 'A'),
      video: { ...recordedVideo('S-01'), screenOffsetsMs: [] },
    };
    await writeFile(runPaths(dir).session('S-01'), asJson(session));

    // The session no longer parses, so `run.sessionIds` names one that is not readable
    // either: what this asserts is that the misalignment is reported where it sits.
    expect(offenders(await validate(dir))).toContain(
      `${label.session('S-01')}/video/screenOffsetsMs`,
    );
  });

  it('names a field the contract declares nowhere at its own path, video included', async () => {
    await writeRun(dir, validArtifact());
    const session = { ...validSession('S-01', 'A'), video: { ...absentVideo(), durationMs: 0 } };
    await writeFile(runPaths(dir).session('S-01'), asJson(session));

    expect(offenders(await validate(dir))).toContain(`${label.session('S-01')}/video/durationMs`);
  });
});
