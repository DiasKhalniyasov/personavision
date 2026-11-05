// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../setup';
import { axePass, describeViolations } from '../axe';
import { ruleIn, rulesOf } from '../cssom';
import {
  forget,
  metadataArrives,
  mountApp,
  recordedSession,
  SEED_RUN,
  serveRecordings,
  stage,
  stubVideoPlayback,
  unrecordedSession,
  videoPath,
} from './harness';

/**
 * The Session replay **over the recording**: one clock for the video, the gaze, the
 * timeline and the log (`docs/FLOW.md` section 14.3, `#screen-replay-video`).
 *
 * The person is `S-15`, as the rest of this screen's suites use them: the rushed buyer on
 * an iPhone, variant B, who gives up on the review step after 38 seconds — 23 fixations,
 * three screens and six actions, every figure the fixture's own.
 *
 * The committed fixture predates session video, so each test here serves that same session
 * back with the `video` block a run of this product now writes (`harness.tsx`). That is not
 * a convenience: a session with **no** recording is the fallback this screen keeps, and it
 * is asserted over the fixture exactly as it is committed.
 *
 * Everything is asserted through what a reader sees and the link they can share.
 */

const replay = (sessionId: string, query = ''): string =>
  `/runs/${SEED_RUN}/sessions/${sessionId}${query}`;

/** `S-15` with a recording whose clock is the session's own: the simple case. */
const recorded = (sessionId = 'S-15') => ({ [sessionId]: recordedSession(sessionId) });

/**
 * The recording whose clock is **not** the session's: it started 32 seconds before the
 * session's first figure, which is what `actionOffsetsMs` exists to record. On this
 * recording `?t=48` is the session at 16 s — the payment screen, fixation 12 — so a test
 * that asks for the prototype's own `0:48` is asking through the offsets and not past them.
 */
const SHIFT_MS = 32_000;
const shifted = (sessionId = 'S-15') => ({
  [sessionId]: recordedSession(sessionId, { shiftMs: SHIFT_MS }),
});

/**
 * The recording with a **wait** in it: eight seconds of being told what to do next between
 * the click on Checkout (8 s) and typing the card number (14 s), so the recorder stamped
 * fourteen seconds over six of session. That is the shape of every browser-driven run —
 * the gaze model's clock costs no wall time and a model call costs seconds — and the
 * stretch is what `deciding… 14 s` is said about.
 */
const thinking = (sessionId = 'S-15') => ({
  [sessionId]: recordedSession(sessionId, { waits: { 1: 8_000 } }),
});

/**
 * The run the owner watched, in this fixture's figures: a **38 second session in a 9 minute
 * 30 second recording**, which is fifteen times its own length. The browser opened 32
 * seconds before the first screen and the agent spent a hundred seconds in front of each of
 * five decisions, which leaves eight seconds of the session the two clocks crossed together
 * and thirty the replay has to cross at once.
 */
const fifteenTimes = (sessionId = 'S-15') => ({
  [sessionId]: recordedSession(sessionId, {
    shiftMs: SHIFT_MS,
    waits: { 1: 100_000, 2: 100_000, 3: 100_000, 4: 100_000, 5: 100_000 },
  }),
});

beforeEach(() => {
  loadDesignTokens();
  stubVideoPlayback();
});
afterEach(forget);

/** The screen, with this person's session read and the bar on the page. */
const ready = async (): Promise<void> => {
  await waitFor(() => {
    expect(document.querySelector('#rp-clock')).not.toBeNull();
  });
};

const clock = (): string => document.querySelector('#rp-clock')?.textContent ?? '';
const fixation = (): string => document.querySelector('#rp-fixlabel')?.textContent ?? '';

/** The screen card the timeline is showing, by the step it names. */
const activeCard = (): string =>
  document.querySelector('[data-screen-card][data-active="true"]')?.textContent ?? '';

/** The row of the log the screen reports for this moment. */
const activeRow = (): string =>
  [...document.querySelectorAll('[data-event][aria-current="true"]')]
    .map((row) => [...row.children].map((part) => part.textContent?.trim()).join(' | '))
    .join(' / ');

/** The four things one clock moves, read off the screen. */
const theFour = () => ({
  clock: clock(),
  fixation: fixation(),
  screen: document.querySelector('[data-screen-card][data-active="true"] h2')?.textContent ?? '',
  row: activeRow(),
});

/** The waits the track is marked with, in the order the session meets them. */
const waitMarks = (): string[] =>
  [...document.querySelectorAll('[data-wait]')].map((mark) => mark.getAttribute('data-wait') ?? '');

/** The badge over the stage, when the replay is crossing a wait. */
const waitBadge = (): string => document.querySelector('[data-waiting]')?.textContent ?? '';

const marks = (): Element[] => [...document.querySelectorAll('[data-fixation]')];
const clicks = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-click]')];
const hops = (): Element[] => [...document.querySelectorAll('#rp-vec line')];
const percent = (value: string): number => Number.parseFloat(value);

const prose = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

/** One row of the outcome card, by the term it is written against. */
const cardRow = (term: string): string => {
  const card = document.querySelector('[data-outcome]') as HTMLElement;
  const terms = [...card.querySelectorAll('dt')];
  const found = terms.findIndex((item) => item.textContent?.trim() === term);
  if (found < 0) throw new Error(`the outcome card has no "${term}" row`);
  return prose(card.querySelectorAll('dd')[found]?.textContent);
};

describe('the recording as the stage', () => {
  it('plays this session’s own recording, read over the run mount', async () => {
    const { requests } = await serveRecordings({ sessions: recorded() });
    mountApp(replay('S-15'));
    await ready();

    const video = stage();
    expect(video.getAttribute('src')).toBe(videoPath('S-15'));
    // Metadata first, and a range when it seeks: the mount answers a slice of the file, so
    // nothing is computed to open a replay in the middle of a recording.
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.hasAttribute('controls')).toBe(false);
    expect(video.hasAttribute('loop')).toBe(false);

    // The one request the screen makes about the file itself: how big it is, which the
    // outcome card states and which no run artifact records.
    await waitFor(() => {
      expect(requests).toEqual([{ path: videoPath('S-15'), method: 'HEAD' }]);
    });
  });

  it('draws the gaze, the clicks and the scanpath over the video’s own frame', async () => {
    await serveRecordings({ sessions: recorded() });
    mountApp(replay('S-15', '?t=28'));
    await ready();

    // 28 seconds in, this person is on the payment screen: twelve fixations have happened
    // on it and the nineteenth of the session is the one they are on.
    expect(marks()).toHaveLength(12);
    expect(marks().filter((mark) => mark.hasAttribute('data-current'))).toHaveLength(1);
    expect(
      marks()
        .find((mark) => mark.hasAttribute('data-current'))
        ?.getAttribute('data-fixation'),
    ).toBe('19');

    // One click on this screen by then: "Place order", whose box the run holds. The mark is
    // the centre of that box in the viewport the frame is showing.
    expect(clicks()).toHaveLength(1);
    const mark = clicks()[0] as HTMLElement;
    expect(percent(mark.style.left)).toBeCloseTo(50, 1);
    expect(percent(mark.style.top)).toBeCloseTo((420 / 844) * 100, 1);

    // The scanpath is the layer the prototype draws off, so nothing is hopping yet.
    expect(hops()).toHaveLength(0);
  });

  it('keeps every mark registered to the video at two different player widths', async () => {
    await serveRecordings({ sessions: recorded() });
    const { container } = mountApp(replay('S-15', '?t=28'));
    await ready();

    const box = container.querySelector('[data-stage="video"]') as HTMLElement;
    const placed = (): string[] =>
      [...marks(), ...clicks()].map((element) =>
        element instanceof HTMLElement
          ? `${element.style.left},${element.style.top}`
          : `${element.getAttribute('cx') ?? ''},${element.getAttribute('cy') ?? ''}`,
      );

    // Every mark is a share of the stage, so a player twice as wide puts each one on the
    // same part of the same frame: there is no pixel in any of these placements to scale.
    box.style.width = '320px';
    const narrow = placed();
    box.style.width = '960px';
    expect(placed()).toEqual(narrow);
    expect(narrow.every((value) => value.includes('%') || /\d/.test(value))).toBe(true);
    expect(placed().join(' ')).not.toMatch(/px/);

    // And the box the marks are shares of is the box the video fills.
    const overlay = box.querySelector('[role="img"]') as HTMLElement;
    expect(overlay.contains(marks()[0] as Node)).toBe(true);
    expect(box.contains(stage())).toBe(true);
  });

  it('reserves the recording’s own shape, so the frame arriving moves nothing', async () => {
    await serveRecordings({ sessions: recorded() });
    const { container } = mountApp(replay('S-15', '?t=10'));
    await ready();

    const box = (): HTMLElement => container.querySelector('[data-stage="video"]') as HTMLElement;
    // Before a byte of the file has been read: the device this person used.
    expect(box().style.aspectRatio).toBe('390 / 844');
    // And once the file says what it is: its own frame, which is that viewport inside 720p.
    metadataArrives({ width: 332, height: 720 });
    await waitFor(() => {
      expect(box().style.aspectRatio).toBe('332 / 720');
    });
  });

  it('states a recording that will not load, naming the path, and keeps the words beside it', async () => {
    await serveRecordings({ sessions: recorded() });
    const { container } = mountApp(replay('S-15', '?t=10'));
    await ready();

    stage().dispatchEvent(new Event('error'));

    await waitFor(() => {
      expect(prose(container.querySelector('[data-stage-state="unreadable"]')?.textContent)).toBe(
        'This recording could not be loaded. It should be at videos/S-15.webm in this test’s ' +
          'directory. The timeline, the event log and the outcome card beside it are this ' +
          'person’s own and still read.',
      );
    });
    expect(activeCard()).toContain('See what the boots cost in total');
    expect(cardRow('Reproduce')).toContain('sessions/S-15.json');
  });
});

describe('one clock, and it is the session’s own', () => {
  it('moves the video, the screen, the log row and the fixation counter from one drag', async () => {
    await serveRecordings({ sessions: recorded() });
    mountApp(replay('S-15', '?t=16'));
    await ready();

    expect(theFour()).toEqual({
      clock: '0:16 / 0:38',
      fixation: 'fixation 12 of 23',
      screen: 'Screen 2 of 3 · Payment',
      row: '0:15 | read · Expiry field · 202 ms held',
    });
    expect(stage().currentTime).toBeCloseTo(16, 1);

    // The scrubber dragged to the end of the recording. A pointer drag and a key press are
    // the same control reporting a new second, and jsdom lays out nothing for a pointer to
    // be dragged across, so the key press is how the drag is made here.
    screen.getByRole('slider', { name: 'Scrub the recording' }).focus();
    await userEvent.keyboard('{End}');

    await waitFor(() => {
      expect(theFour()).toEqual({
        clock: '0:38 / 0:38',
        fixation: 'fixation 23 of 23',
        screen: 'Screen 3 of 3 · Review',
        row: expect.stringContaining('0:38 | abandon'),
      });
    });
    // All four, and the player with them: one position, and nothing holding a second copy.
    expect(stage().currentTime).toBeCloseTo(38, 1);
  });

  it('runs the track over the session and not over the file it is four times shorter than', async () => {
    await serveRecordings({ sessions: shifted() });
    mountApp(replay('S-15', '?t=48'));
    await ready();

    // The recording is 1:10 and the session inside it is 0:38, and the track is the
    // session's: its right-hand end is the moment this person gave up, not the moment the
    // file runs out.
    const slider = screen.getByRole('slider', { name: 'Scrub the recording' });
    expect(slider.getAttribute('aria-valuemax')).toBe('38');
    expect(clock()).toBe('0:16 / 0:38');
    // And the recording is seeked to follow: 0:16 of this person is 0:48 of the tape.
    expect(stage().currentTime).toBeCloseTo(48, 1);
  });

  it('reaches the end of a recording fifteen times its length in the session’s own time', async () => {
    await serveRecordings({ sessions: fifteenTimes() });
    const { router } = mountApp(replay('S-15', '?t=0'));
    await ready();

    // The file: 9:30, which the outcome card states as the recording's own fact.
    expect(cardRow('Video')).toContain('9:30');
    expect(clock()).toBe('0:00 / 0:38');

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Play the recording' }));

      // Twenty seconds of wall time, twenty seconds of this person's attempt — although
      // the tape has run through more than four minutes of waiting to get here.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(clock()).toBe('0:20 / 0:38');

      // And the end of the session is the end of the replay, at 38 seconds and not at 570.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(18_500);
      });
      expect(clock()).toBe('0:38 / 0:38');
      expect(screen.getByRole('button', { name: 'Play the recording' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }

    // One entry in the history for a session played through, not one per second.
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('moves the same four as it plays, and leaves them where it was paused', async () => {
    await serveRecordings({ sessions: recorded() });
    const { router } = mountApp(replay('S-15', '?t=16'));
    await ready();

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Play the recording' }));
      expect(screen.getByRole('button', { name: 'Pause the recording' })).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_000);
      });
      expect(theFour()).toEqual({
        clock: '0:30 / 0:38',
        fixation: 'fixation 20 of 23',
        screen: 'Screen 3 of 3 · Review',
        row: '0:29 | read · Order summary · 558 ms held',
      });
      expect(router.state.location.search).toBe('?t=30');

      fireEvent.click(screen.getByRole('button', { name: 'Pause the recording' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      // Paused leaves the four where they were, and leaves the link citing that second.
      expect(theFour().clock).toBe('0:30 / 0:38');
      expect(theFour().fixation).toBe('fixation 20 of 23');
      expect(router.state.location.search).toBe('?t=30');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a link to one moment of the recording', () => {
  it('opens paused at ?t=48, with the screen and the event of that second active', async () => {
    await serveRecordings({ sessions: shifted() });
    mountApp(replay('S-15', '?t=48'));
    await ready();

    // The recording ran 32 seconds longer than the session's own figures, and the offsets
    // are what resolve the second: 0:48 of the recording is this person 16 seconds in, and
    // the clock reads the person's own time because that is the clock this screen runs on.
    expect(theFour()).toEqual({
      clock: '0:16 / 0:38',
      fixation: 'fixation 12 of 23',
      screen: 'Screen 2 of 3 · Payment',
      row: '0:15 | read · Expiry field · 202 ms held',
    });
    expect(stage().currentTime).toBeCloseTo(48, 1);
    expect(screen.getByRole('button', { name: 'Play the recording' })).toBeTruthy();
  });

  it('opens on the first fixation when a link carries no moment at all', async () => {
    await serveRecordings({ sessions: recorded() });
    mountApp(replay('S-15'));
    await ready();

    // The moment the screenshot stage opens on too, so a person opened from the Sessions
    // grid lands on the same moment of their attempt either way.
    expect(fixation()).toBe('fixation 1 of 23');
    expect(clock()).toBe('0:01 / 0:38');
  });

  it('reads a second before the page had loaded as before the session, not into it', async () => {
    await serveRecordings({ sessions: shifted() });
    mountApp(replay('S-15', '?t=10'));
    await ready();

    // The recorder's clock starts when the browser opens, before the page is navigated to,
    // so the first 32 seconds of this recording are before the session's own first figure.
    // The first screen's offset is what says so, and the session's clock starts at zero.
    expect(clock()).toBe('0:00 / 0:38');
    expect(fixation()).toBe('before the first of 23');
    expect(activeCard()).toContain('Screen 1 of 3 · Cart');
  });

  it('opens at the start on ?t=0, before this person had looked at anything', async () => {
    await serveRecordings({ sessions: recorded() });
    mountApp(replay('S-15', '?t=0'));
    await ready();

    expect(clock()).toBe('0:00 / 0:38');
    expect(fixation()).toBe('before the first of 23');
    expect(activeCard()).toContain('Screen 1 of 3 · Cart');
    expect(activeRow()).toBe('');
    expect(stage().currentTime).toBeCloseTo(0, 1);
  });

  it('opens on the last frame when the second is past the end, and says that it did', async () => {
    await serveRecordings({ sessions: recorded() });
    const { container } = mountApp(replay('S-15', '?t=90'));
    await ready();

    expect(clock()).toBe('0:38 / 0:38');
    expect(prose(container.querySelector('[data-past-end]')?.textContent)).toBe(
      'This link asks for 1:30, which is past the end of a 0:38 recording, so the replay ' +
        'opens on its last frame.',
    );
  });

  it('does not call the scrubber’s own right-hand end a link past the end', async () => {
    // A recording that ran on for six tenths of a second after the session's last figure.
    await serveRecordings({ sessions: { 'S-15': recordedSession('S-15', { plusMs: 600 }) } });
    const { container, router } = mountApp(replay('S-15', '?t=16'));
    await ready();

    const slider = screen.getByRole('slider', { name: 'Scrub the recording' });
    expect(slider.getAttribute('aria-valuemax')).toBe('38');

    slider.focus();
    await userEvent.keyboard('{End}');
    await waitFor(() => {
      expect(router.state.location.search).toBe('?t=38');
    });
    expect(container.querySelector('[data-past-end]')).toBeNull();
  });

  it('names the cap when the recording a link overshoots was cut short by one', async () => {
    await serveRecordings({
      sessions: { 'S-15': recordedSession('S-15', { truncated: 'screen' }) },
    });
    const { container } = mountApp(replay('S-15', '?t=90'));
    await ready();

    expect(prose(container.querySelector('[data-past-end]')?.textContent)).toContain(
      'past the end of a 0:38 recording — one the screen cap cut short',
    );
  });

  it('still opens on the fixation ?fix= names', async () => {
    await serveRecordings({ sessions: recorded() });
    mountApp(replay('S-15', '?fix=12'));
    await ready();

    // `fix` is the unit of a session with no recording, and it still resolves: fixation 12
    // happened 15.8 seconds in, so that is the frame the stage opens on.
    expect(fixation()).toBe('fixation 12 of 23');
    expect(clock()).toBe('0:15 / 0:38');
  });

  it('lets ?t= win when a link carries both, because the stage is the recording', async () => {
    await serveRecordings({ sessions: recorded() });
    mountApp(replay('S-15', '?t=30&fix=12'));
    await ready();

    // Both name a moment, and over a recording the recording is what is being addressed:
    // `t` is the unit of the frame and the unit a citation carries, and `fix` is the unit
    // of a session that has no recording to cite a second of.
    expect(clock()).toBe('0:30 / 0:38');
    expect(fixation()).toBe('fixation 20 of 23');
  });

  it('carries the moment as ?t= once the reader has moved, and stops carrying two', async () => {
    await serveRecordings({ sessions: recorded() });
    const { router } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    screen.getByRole('slider', { name: 'Scrub the recording' }).focus();
    await userEvent.keyboard('{ArrowRight}');

    await waitFor(() => {
      // Fixation 12 happened at 15.8 s, which the scrubber's own unit is 16 of; a step
      // right is therefore 17.
      expect(router.state.location.search).toBe('?t=17');
    });
    expect(clock()).toBe('0:17 / 0:38');
  });
});

describe('a wait is shown as a wait', () => {
  it('marks the stretch on the track and says in words how long it really was', async () => {
    await serveRecordings({ sessions: thinking() });
    const { container } = mountApp(replay('S-15', '?t=0'));
    await ready();

    // One stretch, between the click on Checkout and typing the card number.
    expect(waitMarks()).toEqual(['14']);
    expect(prose(container.querySelector('[data-waits]')?.textContent)).toBe(
      'Marked on the track: one stretch the recording ran on through while nothing ' +
        'happened on the page — 14 s — which the replay crosses rather than plays.',
    );
  });

  it('marks every stretch of the run the owner watched, each with its own seconds', async () => {
    await serveRecordings({ sessions: fifteenTimes() });
    const { container } = mountApp(replay('S-15', '?t=0'));
    await ready();

    expect(waitMarks()).toEqual(['106', '109', '103', '103', '109']);
    expect(prose(container.querySelector('[data-waits]')?.textContent)).toContain(
      '5 stretches the recording ran on through while nothing happened on the page — ' +
        '106 s, 109 s, 103 s, 103 s and 109 s',
    );
  });

  it('says over the stage what the replay crossed, and holds the frame it ends on', async () => {
    await serveRecordings({ sessions: thinking() });
    mountApp(replay('S-15', '?fix=9'));
    await ready();

    // Fixation 9 happened 11.7 seconds in, which is inside the stretch: the session was
    // reading the payment screen while the recording stood still waiting to be told what
    // to do next.
    expect(clock()).toBe('0:11 / 0:38');
    expect(waitBadge()).toBe('deciding… 14 s');
    // The frame is the one the wait **ends** on — nothing between the two actions moved,
    // so the replay is already there rather than part-way through a page that is not
    // changing: 0:22 of the tape, not 0:11.
    expect(stage().currentTime).toBeCloseTo(22, 1);
  });

  it('says nothing over the stage where the two clocks crossed together', async () => {
    await serveRecordings({ sessions: thinking() });
    mountApp(replay('S-15', '?t=0'));
    await ready();

    expect(document.querySelector('[data-waiting]')).toBeNull();
    expect(stage().currentTime).toBeCloseTo(0, 1);
  });

  it('crosses the stretch at once as it plays, rather than playing a page that is still', async () => {
    await serveRecordings({ sessions: thinking() });
    mountApp(replay('S-15', '?t=8'));
    await ready();

    // The action the wait begins on: the click on Checkout, at 8 s on both clocks.
    expect(clock()).toBe('0:08 / 0:38');
    expect(stage().currentTime).toBeCloseTo(8, 1);

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Play the recording' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      // Half a second later the session is half a second further on and the recording is
      // fourteen seconds further on: the stretch was crossed, not played.
      expect(clock()).toBe('0:08 / 0:38');
      expect(waitBadge()).toBe('deciding… 14 s');
      expect(stage().currentTime).toBeCloseTo(22, 1);

      // And out the other side the two run on together again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(7_000);
      });
      expect(clock()).toBe('0:15 / 0:38');
      expect(document.querySelector('[data-waiting]')).toBeNull();
      expect(stage().currentTime).toBeCloseTo(23.5, 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a ?t= that falls inside a wait on the action the wait ends on', async () => {
    await serveRecordings({ sessions: thinking() });
    mountApp(replay('S-15', '?t=18'));
    await ready();

    // 0:18 of this recording is in the middle of the stretch, where every frame is the
    // same picture. It opens on the action the stretch ends on instead: typing the card
    // number, 14 seconds into the session.
    expect(theFour()).toEqual({
      clock: '0:14 / 0:38',
      fixation: 'fixation 10 of 23',
      screen: 'Screen 2 of 3 · Payment',
      row: '0:14 | type · Card number · autofilled',
    });
    expect(document.querySelector('[data-waiting]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Play the recording' })).toBeTruthy();
  });

  it('opens a citation of an action on that action, through the wait before it', async () => {
    await serveRecordings({ sessions: thinking() });
    mountApp(replay('S-15', '?t=22'));
    await ready();

    // 0:22 is where the recorder stamped typing the card number, which is the second a
    // recommendation citing that action carries.
    expect(clock()).toBe('0:14 / 0:38');
    expect(activeRow()).toBe('0:14 | type · Card number · autofilled');
  });

  it('marks no stretch on a recording whose clock is the session’s own', async () => {
    await serveRecordings({ sessions: recorded() });
    const { container } = mountApp(replay('S-15', '?t=16'));
    await ready();

    expect(waitMarks()).toEqual([]);
    expect(container.querySelector('[data-waits]')).toBeNull();
    expect(document.querySelector('[data-waiting]')).toBeNull();
  });
});

describe('the overlay switches', () => {
  const switched = (name: string): HTMLElement => screen.getByRole('button', { name });

  it('turns the gaze, the clicks and the scanpath on and off independently', async () => {
    await serveRecordings({ sessions: recorded() });
    mountApp(replay('S-15', '?t=28'));
    await ready();

    // As `#screen-replay-video` draws them: the gaze and the clicks on, the scanpath off.
    expect(switched('Gaze').getAttribute('aria-pressed')).toBe('true');
    expect(switched('Clicks').getAttribute('aria-pressed')).toBe('true');
    expect(switched('Scanpath').getAttribute('aria-pressed')).toBe('false');

    await userEvent.click(switched('Scanpath'));
    await waitFor(() => {
      expect(hops().length).toBeGreaterThan(0);
    });
    expect(marks()).toHaveLength(12);
    expect(clicks()).toHaveLength(1);

    await userEvent.click(switched('Gaze'));
    await waitFor(() => {
      expect(marks()).toHaveLength(0);
    });
    // The clicks are their own layer and are untouched by the gaze going off.
    expect(clicks()).toHaveLength(1);

    await userEvent.click(switched('Clicks'));
    await waitFor(() => {
      expect(clicks()).toHaveLength(0);
    });
    // The scanpath is its own layer and is still drawn with the gaze off: the order of
    // attention, without the dwell rings over the picture.
    expect(hops().length).toBeGreaterThan(0);
    expect(marks()).toHaveLength(0);
  });

  it('keeps them out of the URL, because what a link carries is the timestamp', async () => {
    await serveRecordings({ sessions: recorded() });
    const { router } = mountApp(replay('S-15', '?t=28'));
    await ready();

    await userEvent.click(switched('Scanpath'));
    await waitFor(() => {
      expect(hops().length).toBeGreaterThan(0);
    });
    await userEvent.click(switched('Clicks'));
    await waitFor(() => {
      expect(clicks()).toHaveLength(0);
    });

    expect(router.state.location.search).toBe('?t=28');
  });

  it('names where the attention went, for a reader who cannot see the stage', async () => {
    await serveRecordings({ sessions: recorded() });
    mountApp(replay('S-15', '?t=28'));
    await ready();

    expect(prose(screen.getByRole('img').getAttribute('aria-label'))).toBe(
      'Where this person was looking at 0:28: fixation 19 of 23, on Primary action — A: ' +
        '"Continue to review", B: "Place order", held 0.4 seconds. And 1 thing clicked on ' +
        'this screen so far: Primary action — A: "Continue to review", B: "Place order".',
    );

    // The name is on the box and not on a layer, so turning the gaze off does not take the
    // reading of the frame away with it.
    await userEvent.click(switched('Gaze'));
    await waitFor(() => {
      expect(marks()).toHaveLength(0);
    });
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('fixation 19 of 23');
  });
});

describe('a session with no recording', () => {
  it('keeps its replay on the screenshot stage, and says which it is', async () => {
    // The fixture exactly as it is committed: sessions written before video existed.
    await serveRecordings();
    const { container } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('#rp-frame')).not.toBeNull();
    expect(prose(container.querySelector('[data-no-recording]')?.textContent)).toBe(
      'This session has no recording, so the stage is the page as this person saw it. Their ' +
        'stated intent, the event log and the outcome below are their own.',
    );

    // And the three things that make the replay worth opening are all still here.
    expect(activeCard()).toContain('Pay as fast as possible, the card is saved.');
    expect(activeRow()).toBe('0:15 | read · Expiry field · 202 ms held');
    expect(cardRow('Video')).toBe('this test recorded no video');
    expect(screen.getByRole('slider', { name: 'Fixation' })).toBeTruthy();
  });

  it('prints the recorder’s own reason when a session’s recording was not made', async () => {
    await serveRecordings({
      sessions: { 'S-15': unrecordedSession('S-15', 'the browser opened no recording') },
    });
    const { container } = mountApp(replay('S-15'));
    await ready();

    expect(container.querySelector('video')).toBeNull();
    expect(cardRow('Video')).toBe('no recording · the browser opened no recording');
    expect(container.querySelector('[data-no-recording]')).not.toBeNull();
  });
});

describe('the outcome card over a recording', () => {
  const RECOMMENDATIONS = {
    schemaVersion: 2,
    runId: SEED_RUN,
    sample: { read: 8, of: 24, strategy: 'the slowest and the abandoned', seed: 3 },
    recommendations: [
      {
        id: 'R-1',
        rank: 1,
        sentence: 'Move “Confirm purchase” above the fold on the review step.',
        evidence: 'Nobody who reached the review step looked at it.',
        findingIds: ['F-1'],
        citations: [{ kind: 'session', sessionId: 'S-15', offsetMs: 30_000 }],
        peopleAffected: 9,
        step: 'review',
      },
      {
        id: 'R-2',
        rank: 2,
        sentence: 'Show the $9.95 service fee in the cart.',
        evidence: 'It appears for the first time on the review step.',
        findingIds: ['F-2'],
        citations: [{ kind: 'funnel', stepId: 'review' }],
        peopleAffected: 11,
        step: 'cart',
      },
    ],
  };

  it('states the recording’s path, its duration, its size and its frame', async () => {
    await serveRecordings({ sessions: recorded(), videoBytes: 11_400_000 });
    mountApp(replay('S-15', '?t=16'));
    await ready();

    await waitFor(() => {
      expect(cardRow('Video')).toBe('videos/S-15.webm · 0:38 · 11.4 MB · resolution not read');
    });
    metadataArrives({ width: 332, height: 720 });
    await waitFor(() => {
      expect(cardRow('Video')).toBe('videos/S-15.webm · 0:38 · 11.4 MB · 332 × 720');
    });
  });

  it('reports a file under a megabyte in kB rather than rounding it into one', async () => {
    await serveRecordings({ sessions: recorded(), videoBytes: 2048 });
    mountApp(replay('S-15', '?t=16'));
    await ready();

    await waitFor(() => {
      expect(cardRow('Video')).toContain('0:38 · 2 kB');
    });
  });

  it('says which figures it could not read rather than printing a zero', async () => {
    await serveRecordings({ sessions: recorded(), videoBytes: null });
    mountApp(replay('S-15', '?t=16'));
    await ready();

    expect(cardRow('Video')).toBe('videos/S-15.webm · 0:38 · size not read · resolution not read');
  });

  it('states the cap when the recording was cut short by one', async () => {
    await serveRecordings({
      sessions: { 'S-15': recordedSession('S-15', { truncated: 'session' }) },
    });
    mountApp(replay('S-15', '?t=16'));
    await ready();

    await waitFor(() => {
      expect(cardRow('Video')).toContain('0:38 · truncated at the per-session cap of 60:00');
    });
  });

  it('links the recommendations this person is evidence for', async () => {
    await serveRecordings({ sessions: recorded(), recommendations: RECOMMENDATIONS });
    mountApp(replay('S-15', '?t=16'));
    await ready();

    await waitFor(() => {
      expect(cardRow('Supports')).toBe(
        'Recommendation 1 — Move “Confirm purchase” above the fold on the review step.',
      );
    });
    // The Summary is the screen that leads with the recommendations, so that is where the
    // link goes; the one recommendation citing somebody else is not on this person's card.
    const link = screen.getByRole('link', { name: /^Recommendation 1/ });
    expect(link.getAttribute('href')).toBe(`/runs/${SEED_RUN}`);
    expect(screen.queryByRole('link', { name: /^Recommendation 2/ })).toBeNull();
  });

  it('says a test has produced no recommendations rather than reading as supporting nothing', async () => {
    await serveRecordings({ sessions: recorded() });
    mountApp(replay('S-15', '?t=16'));
    await ready();

    await waitFor(() => {
      expect(cardRow('Supports')).toBe(
        'This test has produced no recommendations, so nothing rests on this person yet.',
      );
    });
    // The findings row is unchanged: a finding is what a recommendation rests on, and this
    // person is cited by three of them.
    expect(cardRow('Supports findings')).toContain('#1 Nobody in your audience ever looked');
  });
});

describe('a session our own automation broke', () => {
  it('is replayable over its recording, and says no figure rests on it', async () => {
    await serveRecordings({ sessions: recorded('S-23') });
    mountApp(replay('S-23', '?t=5'));
    await ready();

    expect(stage().getAttribute('src')).toBe(videoPath('S-23'));
    const card = document.querySelector('[data-outcome]') as HTMLElement;
    expect(card.getAttribute('data-outcome')).toBe('automation_failure');
    expect(prose(within(card).getByRole('heading').textContent)).toContain(
      'our own automation was at fault, not the product',
    );
    expect(cardRow('Automation integrity')).toContain(
      'excluded from the friction score and from every area-of-interest metric',
    );
  });
});

describe('the screen as a whole', () => {
  it('ends with the line that says the numbers are simulated, and implies no lift', async () => {
    await serveRecordings({ sessions: recorded() });
    const { container } = mountApp(replay('S-15', '?t=16'));
    await ready();

    const words = prose(container.textContent);
    expect(words).toContain('simulated');
    expect(words).not.toMatch(/conversion lift|uplift|revenue/i);
  });

  it('passes axe at a moment of the recording', async () => {
    await serveRecordings({ sessions: recorded() });
    const { container } = mountApp(replay('S-15', '?t=28'));
    await ready();
    metadataArrives({ width: 332, height: 720 });

    // The screen, as the sibling suite audits it: the app chrome around it is the shell's
    // own and is audited where it is written.
    const results = await axePass(container);
    expect(describeViolations(results.violations)).toBe('');
  }, 30_000);

  it('does not autoplay under prefers-reduced-motion, and nothing else moves on its own', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );

    await serveRecordings({ sessions: recorded() });
    mountApp(replay('S-15', '?t=16'));
    await ready();

    // A replay opens paused on the frame the link asks for, whether or not the reader has
    // asked for less motion — so there is nothing here to stop, and the only thing that
    // moves is the recording the reader pressed Play on.
    expect(stage().hasAttribute('autoplay')).toBe(false);
    expect(screen.getByRole('button', { name: 'Play the recording' })).toBeTruthy();
    expect(stage().paused).toBe(true);
  });

  it('is operable from the keyboard, Play and the scrubber included', async () => {
    await serveRecordings({ sessions: recorded() });
    mountApp(replay('S-15', '?t=16'));
    await ready();

    await userEvent.tab();
    const reachable: string[] = [];
    for (let step = 0; step < 24; step += 1) {
      const focused = document.activeElement as HTMLElement | null;
      if (focused !== null) {
        reachable.push(
          focused.getAttribute('aria-label') ?? prose(focused.textContent).slice(0, 20),
        );
      }
      await userEvent.tab();
    }

    expect(reachable).toContain('Play the recording');
    expect(reachable).toContain('Scrub the recording');
    expect(reachable).toContain('Gaze');
    // The picture itself is not a tab stop: it is not readable, and the controls under it are.
    expect(document.querySelectorAll('video[tabindex="-1"]')).toHaveLength(1);
  });
});

describe('the stage’s own stylesheet', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const stylesheet = join(here, '../../src/screens/replay/replay.module.css');
  const source = (): string => readFileSync(stylesheet, 'utf8');
  const rule = (selectors: string | string[], condition = ''): Record<string, string> =>
    ruleIn(rulesOf(source()))(selectors, condition);

  it('fills the stage with the video and lays the overlay over the same box', () => {
    // The two halves of the registration: the frame is the whole box, and the layer the
    // marks are shares of is the whole box too.
    expect(rule('.video')['object-fit']).toBe('fill');
    expect(rule('.video')['inset']).toBe('0px');
    expect(rule('.overlay')['inset']).toBe('0px');
    expect(rule('.vidstage')['aspect-ratio']).toBe('var(--frame-ratio-desktop)');
  });

  it('draws a wait on the track it marks, under the thumb, and its badge over the stage', () => {
    // On the track and under the thumb, so a mark never reads as a second handle; and it
    // takes no pointer, because the track it marks is still the control.
    const marker = Number(rule('.wait')['z-index']);
    expect(marker).toBeGreaterThan(Number(rule(".track [data-slot='slider']")['z-index']));
    expect(Number(rule(".track [data-slot='slider-thumb']")['z-index'])).toBeGreaterThan(marker);
    expect(rule('.wait')['pointer-events']).toBe('none');
    // Never thinner than a rule, so a wait between two actions a moment apart is visible.
    expect(rule('.wait')['min-width']).toBe('var(--border-width-strong)');
    // The badge is over the stage and over the gaze layer, which is why a jsdom test
    // cannot see it and the real browser is where it is looked at.
    expect(Number(rule('.waiting')['z-index'])).toBeGreaterThan(
      Number(rule('.overlay')['z-index']),
    );
  });

  it('restates no visual value of its own', () => {
    // The properties that carry a visual decision. A longhand jsdom expanded a shorthand
    // into is not one of them, and neither is a shape: `aspect-ratio: 1` makes the click
    // mark a circle, which is the prototype's own geometry and not a value in the tokens.
    const visual =
      /^(color|background|background-color|box-shadow|font-size|border-radius|border-color|fill|stroke)$/;
    const declared = rulesOf(source()).flatMap((item) => Object.entries(item.declarations));
    const literal = declared.filter(
      ([property, value]) =>
        visual.test(property) &&
        !value.includes('var(--') &&
        !['inherit', 'none', 'transparent', 'currentcolor'].includes(value.toLowerCase()),
    );
    expect(literal).toEqual([]);
  });

  it('reads at 390 px with nothing to scroll sideways, and moves on its own nowhere', () => {
    // The prototype's own breakpoint for this screen: below it the two columns stack.
    expect(rule('.replay', '(max-width: 1000px)')['grid-template-columns']).toBe('minmax(0, 1fr)');
    // The bar wraps rather than pushing the page wider than the phone it is read on.
    expect(rule('.vidbar')['flex-wrap']).toBe('wrap');
    const widths = rulesOf(source()).flatMap((item) =>
      Object.entries(item.declarations).filter(([property]) =>
        /^(min-|max-)?width$/.test(property),
      ),
    );
    expect(widths.filter(([, value]) => /\d+(px|rem|em|ch)/.test(value))).toEqual([]);
    expect(source()).not.toMatch(/@keyframes/);
    expect(source()).not.toMatch(/\banimation\b/);
  });
});
