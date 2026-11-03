// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../app';
import { axePass, describeViolations } from '../axe';
import { ruleIn, rulesOf } from '../cssom';
import { paths } from '../../src/shell/paths';

/**
 * The Sessions grid: a hundred people as a wall of video thumbnails, over the seed example
 * run with the recordings a run of this product now makes.
 *
 * The committed fixture predates session video, so this suite serves it back with a `video`
 * block per session — the same shape the contract declares and the recorder writes. That is
 * what makes a tile assertable at all, and it is also the honest fixture: a run recorded
 * before video existed is the one case the grid has to say *this test recorded no videos*
 * about, and that is asserted here too, over the fixture exactly as it is committed.
 *
 * Everything is asserted through what a reader sees and the URL they can share. Nothing is
 * asserted about a component's internals.
 */

const SEED = '2026-10-24-1402-northwind-demo';

/** The prototype's own page: `Show the next 8`. */
const PAGE = 8;

interface Fixation {
  readonly screenIndex: number;
  readonly tMs: number;
  readonly x: number;
  readonly y: number;
}

interface SessionFile {
  readonly sessionId: string;
  readonly durationMs: number;
  readonly screens: readonly { readonly index: number }[];
  readonly actions: readonly { readonly tMs: number }[];
  readonly fixations: readonly Fixation[];
  readonly persona: { readonly device: { readonly viewport: { width: number; height: number } } };
}

const session = (sessionId: string): SessionFile =>
  readRunFile(SEED, `sessions/${sessionId}.json`) as unknown as SessionFile;

/**
 * Where each screen begins on the session's clock: its first fixation, which is the one
 * rule `src/session/timeline.ts` uses and so the moment a tile's frame is of.
 */
const screenStarts = (file: SessionFile): number[] =>
  file.screens.map((_screen, index) => {
    const first = file.fixations.find((fixation) => fixation.screenIndex === index);
    return index === 0 ? 0 : (first?.tMs ?? 0);
  });

/**
 * One session with the recording the recorder would have written for it: the offsets are
 * positional, as the contract holds them to be, and the recording runs as long as the
 * session did.
 */
const recorded = (sessionId: string): Record<string, unknown> => {
  const file = session(sessionId) as unknown as Record<string, unknown>;
  const read = session(sessionId);
  return {
    ...file,
    video: {
      state: 'recorded',
      path: `videos/${sessionId}.webm`,
      durationMs: read.durationMs,
      truncated: null,
      screenOffsetsMs: screenStarts(read),
      actionOffsetsMs: read.actions.map((action) => action.tMs),
    },
  };
};

/** A session whose recorder said why there is no file. */
const noRecording = (sessionId: string, reason: string): Record<string, unknown> => ({
  ...(session(sessionId) as unknown as Record<string, unknown>),
  video: { state: 'absent', reason },
});

const ids = (): string[] => readRunFile(SEED).sessionIds as string[];

/** The run, with an age on every persona, which is what a tile states beside the name. */
const AGES: Record<string, number> = { rushed: 29, careful: 41, firsttime: 22, price: 34 };

const runWithAges = (over: Record<string, unknown> = {}): string => {
  const run = readRunFile(SEED) as unknown as {
    personas: { id: string; profile?: unknown }[];
  };
  return JSON.stringify({
    ...run,
    ...over,
    personas: run.personas.map((persona) => ({
      ...persona,
      profile: { age: AGES[persona.id] ?? 30, about: 'A generated person.', habits: [] },
    })),
  });
};

/**
 * The run served as a run with video: every session recorded, unless this test says
 * otherwise, and the ages on the people.
 */
const serveRecorded = async (
  options: {
    sessions?: Record<string, Record<string, unknown>>;
    run?: Record<string, unknown>;
  } = {},
) => {
  const overrides: Record<string, string> = {
    [`/runs/${SEED}/run.json`]: runWithAges(options.run ?? {}),
  };
  for (const sessionId of ids()) {
    const own = options.sessions?.[sessionId];
    overrides[`/runs/${SEED}/sessions/${sessionId}.json`] = JSON.stringify(
      own ?? recorded(sessionId),
    );
  }
  return await serveRunData({ files: overrides });
};

/** The tiles on screen, in the order they are drawn, by the name each one carries. */
const tiles = async (expected: number): Promise<string[]> =>
  await waitFor(() => {
    const drawn = screen.getAllByRole('link', { name: /^S-\d+ · / });
    expect(drawn).toHaveLength(expected);
    return drawn.map((tile) => tile.getAttribute('aria-label') ?? '');
  });

/** One tile, by the session it is about. */
const tileFor = async (sessionId: string): Promise<HTMLElement> =>
  await screen.findByRole('link', { name: new RegExp(`^${sessionId} · `) });

/** What the grid has asked the run mount for: one `src` per poster it wants. */
const posters = (): string[] =>
  [...document.querySelectorAll('video[src]')].map((video) => video.getAttribute('src') ?? '');

const option = (group: string, name: string | RegExp): HTMLElement =>
  within(screen.getByRole('toolbar', { name: group })).getByRole('button', { name });

const prose = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ').trim();

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the grid is what the Sessions screen opens on', () => {
  it('draws one tile per person, newest first, and no table', async () => {
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    const drawn = await tiles(PAGE);
    // `sessionIds` is the order the test ran them, so the grid reads it backwards.
    expect(drawn.map((label) => label.split(' · ')[0])).toEqual(ids().slice(-PAGE).reverse());
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('heads itself with the people and the recordings, and ends with the simulated line', async () => {
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    expect(await screen.findByRole('heading', { name: '24 people, 24 videos' })).toBeTruthy();
    expect(screen.getByText(/Each tile is one person’s whole attempt, recorded/)).toBeTruthy();
    // Section 8: every figure is labelled simulated, and the screen says in as many words
    // that it is not a conversion-lift estimate rather than leaving a reader to assume.
    const simulated = document.querySelector('[data-shell="simulated-disclaimer"]');
    expect(prose(simulated?.textContent ?? '')).toContain('is simulated, for the audience named');
    expect(prose(simulated?.textContent ?? '')).toContain('it is not a conversion-lift estimate');
  });

  it('states on each tile who they were, what they were on and how it went', async () => {
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    const tile = await tileFor('S-24');
    const row = session('S-24') as unknown as { persona: { id: string } };

    expect(prose(tile.textContent)).toContain('S-24 · Price-sensitive scanner, 34');
    // The device it ran on and the segment they came from, as the run records both.
    expect(prose(tile.textContent)).toContain('iPhone 15 · mobile · price-sensitive');
    // The outcome, and the step it ended on after it.
    expect(prose(tile.textContent)).toContain('Abandoned · Review');
    expect(row.persona.id).toBe('price');
  });

  it('labels each tile as one control naming the person and the outcome', async () => {
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    const drawn = await tiles(PAGE);
    expect(drawn[0]).toBe(
      'S-24 · Price-sensitive scanner, 34 — Abandoned. Review — service fee revealed, left without ordering',
    );
    // One tab stop per person, not four: the picture, the duration and the tag are inside it.
    const tile = await tileFor('S-24');
    expect(within(tile).queryAllByRole('button')).toEqual([]);
    expect(within(tile).queryAllByRole('link')).toEqual([]);
  });

  it('opens that person’s replay', async () => {
    const user = userEvent.setup();
    await serveRecorded();
    const { router } = mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    await user.click(await tileFor('S-24'));

    expect(router.state.location.pathname).toBe(paths.session(SEED, 'S-24'));
  });
});

describe('a tile’s thumbnail', () => {
  it('is a frame of that session’s own recording, at an offset the session records', async () => {
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    const file = session('S-24');
    // The frame is the last screen the recording reaches: where the attempt got to, which
    // is what makes a wall of a hundred tiles worth scanning.
    const last = screenStarts(file)[file.screens.length - 1] as number;
    const frame = (await tileFor('S-24')).querySelector('video') as HTMLVideoElement;

    // The recording, under the run's own directory — never a page screenshot — asked for
    // by the second the session says that screen came up.
    expect(frame.getAttribute('src')).toBe(
      `/runs/${SEED}/videos/S-24.webm#t=${String(last / 1000)}`,
    );
    expect(frame.getAttribute('src')).not.toMatch(/screenshots/);
  });

  it('marks the gaze where the session says it was for that frame', async () => {
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    const tile = await tileFor('S-24');
    const file = session('S-24');
    const lastScreen = file.screens.length - 1;
    const fixation = file.fixations.find(
      (candidate) => candidate.screenIndex === lastScreen,
    ) as Fixation;
    const { width, height } = file.persona.device.viewport;

    const mark = tile.querySelector('i');
    expect(mark).not.toBeNull();
    expect((mark as HTMLElement).style.left).toBe(`${(fixation.x / width) * 100}%`);
    expect((mark as HTMLElement).style.top).toBe(`${(fixation.y / height) * 100}%`);
  });

  it('states how long the recording runs', async () => {
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    // 41 000 ms, as `m:ss`.
    expect(prose((await tileFor('S-24')).textContent)).toContain('0:41');
  });

  it('is the shape the recording was made at, so a phone session is not a letterbox', async () => {
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    const phone = await tileFor('S-24');
    const desktop = await tileFor('S-17');

    expect(phone.style.getPropertyValue('--thumb-aspect')).toBe('390 / 844');
    expect(desktop.style.getPropertyValue('--thumb-aspect')).toBe('1440 / 900');
  });
});

describe('a session with no recording', () => {
  it('renders a tile that says so, with the reason, and is neither blank nor broken', async () => {
    await serveRecorded({
      sessions: {
        'S-24': noRecording('S-24', 'the recorder lost the stream when the tab was discarded'),
      },
    });
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    const tile = await tileFor('S-24');

    expect(prose(tile.textContent)).toContain('No recording');
    expect(prose(tile.textContent)).toContain(
      'the recorder lost the stream when the tab was discarded',
    );
    // Not blank: the tile still names the person and how it went.
    expect(prose(tile.textContent)).toContain('S-24 · Price-sensitive scanner, 34');
    expect(prose(tile.textContent)).toContain('Abandoned · Review');
    // Not broken: there is no poster for it, so nothing is asked of the mount and no
    // element is left pointing at a file that is not there.
    expect(posters().some((src) => src.includes('S-24'))).toBe(false);
    expect(tile.querySelector('video')).toBeNull();
  });

  it('is still one of the people the grid counts and lists', async () => {
    await serveRecorded({ sessions: { 'S-24': noRecording('S-24', 'no stream') } });
    mountApp(paths.sessions(SEED));

    expect(await screen.findByRole('heading', { name: '24 people, 23 videos' })).toBeTruthy();
    expect(await tileFor('S-24')).toBeTruthy();
  });
});

describe('a test that recorded no videos at all', () => {
  it('says so in words and offers the rows, rather than a wall of blank tiles', async () => {
    // The fixture exactly as it is committed: sessions written before video existed.
    await serveRunData();
    mountApp(paths.sessions(SEED));

    expect(
      await screen.findByRole('heading', { name: 'This test recorded no videos' }),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^S-\d+ · / })).toBeNull();

    const rows = screen.getByRole('link', { name: 'Show these as rows instead' });
    expect(rows.getAttribute('href')).toBe(`${paths.sessions(SEED)}?view=rows`);
  });

  it('states the run’s totals rather than a range of tiles that are not there', async () => {
    await serveRunData();
    mountApp(paths.sessions(SEED));

    await screen.findByRole('heading', { name: 'This test recorded no videos' });
    expect(
      screen.getByText('24 people · 22 scored · 2 excluded because our automation broke'),
    ).toBeTruthy();
    expect(screen.queryByText(/^Showing /)).toBeNull();
  });
});

describe('the three filters of the grid', () => {
  it('narrow it by outcome, by segment and by the step it ended on, composing', async () => {
    const user = userEvent.setup();
    await serveRecorded();
    const { router } = mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    await user.click(option('Filter by outcome', /^Abandoned/));
    expect(router.state.location.search).toBe('?outcome=abandoned');
    await tiles(PAGE);

    await user.click(option('Filter by segment', /^mobile · in a hurry/));
    expect(new URLSearchParams(router.state.location.search).get('segment')).toBe(
      'mobile · in a hurry',
    );

    await user.click(option('Filter by the step it ended on', /^Review/));
    const narrowed = new URLSearchParams(router.state.location.search);
    expect(narrowed.get('outcome')).toBe('abandoned');
    expect(narrowed.get('segment')).toBe('mobile · in a hurry');
    expect(narrowed.get('step')).toBe('review');
  });

  it('opens a filtered URL directly, filtered', async () => {
    await serveRecorded();
    mountApp(`${paths.sessions(SEED)}?outcome=automation_failure`);

    const drawn = await tiles(2);
    expect(drawn.map((label) => label.split(' · ')[0])).toEqual(['S-23', 'S-09']);
  });

  it('states each option’s count', async () => {
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    // The outcomes are the run's own stored slice; the segment and the step are tallied
    // over the sessions, which have all arrived by the time the tiles are up.
    expect(option('Filter by outcome', 'All outcomes 24')).toBeTruthy();
    expect(option('Filter by outcome', 'Success 11')).toBeTruthy();
    expect(option('Filter by segment', 'mobile · in a hurry 6')).toBeTruthy();
    expect(option('Filter by the step it ended on', 'Review 7')).toBeTruthy();
    expect(option('Filter by the step it ended on', 'Confirmation 11')).toBeTruthy();
  });

  it('reads the outcome count from the aggregate, not from the sessions it has read', async () => {
    // One more of the session files on disk says *success* than the run's own figures do:
    // the fixture's S-22 gave up at the cart, and this serves it back as a success. A
    // screen that counted what it had read would print twelve. The figure stays eleven,
    // which is `scores[].outcomeCounts.success` — what the scoring step measured, over the
    // people it scored, and the same figure the Verdict leads with.
    const given = session('S-22') as unknown as { outcome: Record<string, unknown> };
    await serveRecorded({
      sessions: {
        'S-22': {
          ...recorded('S-22'),
          outcome: { ...given.outcome, status: 'success' },
        },
      },
    });
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    expect(option('Filter by outcome', 'Success 11')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Success 12' })).toBeNull();
    // And the twelfth person is on screen under that filter all the same: the count is the
    // test's figure, and the tiles are the people the filter leaves.
    expect(prose((await tileFor('S-22')).textContent)).toContain('Success');
  });

  it('composes the slice with a version an evidence link carried in', async () => {
    await serveRecorded();
    mountApp(`${paths.sessions(SEED)}?variant=B`);

    await tiles(PAGE);
    // The redesign's own stored counts, not the test's.
    expect(option('Filter by outcome', 'All outcomes 12')).toBeTruthy();
    expect(option('Filter by outcome', 'Success 2')).toBeTruthy();
    expect(option('Filter by outcome', 'Failed 3')).toBeTruthy();
    // And the version is on screen as a chip, because the grid has no control for it.
    expect(screen.getByRole('button', { name: /^Version: B/ })).toBeTruthy();
  });

  it('states one total across the three groups, so the row cannot disagree with itself', async () => {
    await serveRecorded();
    mountApp(`${paths.sessions(SEED)}?variant=B`);

    await tiles(PAGE);
    // Twelve people ran on the redesign. A row saying "All outcomes 12" beside "Any step
    // 24" would be two totals for one screen, and the step the reader then picks would
    // hand them a third figure.
    expect(option('Filter by outcome', 'All outcomes 12')).toBeTruthy();
    expect(option('Filter by segment', 'Every segment 12')).toBeTruthy();
    expect(option('Filter by the step it ended on', 'Any step 12')).toBeTruthy();
    // And each option is the version's own tally: one of the redesign's twelve people gave
    // up at its Cart step, against three across the whole test.
    expect(option('Filter by the step it ended on', 'Cart 1')).toBeTruthy();
    expect(option('Filter by segment', 'mobile · in a hurry 3')).toBeTruthy();
  });

  it('uses the existing no-match screen when a composition matches nobody', async () => {
    await serveRecorded();
    mountApp(`${paths.sessions(SEED)}?outcome=success&step=cart`);

    expect(await screen.findByRole('heading', { name: 'No session matches' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^S-\d+ · / })).toBeNull();
  });

  it('names the segment and the step in the sentence, never "this test recorded nobody"', async () => {
    await serveRecorded();
    mountApp(`${paths.sessions(SEED)}?segment=mobile · in a hurry&step=cart`);

    await screen.findByRole('heading', { name: 'No session matches' });
    // The test recorded twenty-four people. Saying it recorded nobody would be false, and
    // this screen exists to state the finding rather than to deny the run.
    expect(prose(document.querySelector('.empty p')?.textContent ?? '')).toBe(
      'Nobody in mobile · in a hurry ended on the Cart step.',
    );
  });

  it('keeps the version in front of them when an evidence link carried one in', async () => {
    await serveRecorded();
    mountApp(`${paths.sessions(SEED)}?variant=B&outcome=success&step=cart`);

    await screen.findByRole('heading', { name: 'No session matches' });
    expect(prose(document.querySelector('.empty p')?.textContent ?? '')).toBe(
      'On Redesign candidate, nobody finished the task on the Cart step.',
    );
  });

  it('drops a segment or a step this test has no entry for', async () => {
    await serveRecorded();
    const { router } = mountApp(`${paths.sessions(SEED)}?segment=nobody&step=nowhere`);

    await tiles(PAGE);
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    expect(screen.queryByText('No session matches')).toBeNull();
  });
});

describe('automation failures', () => {
  it('appear, marked excluded, and have a filter of their own', async () => {
    await serveRecorded();
    mountApp(`${paths.sessions(SEED)}?outcome=automation_failure`);

    await tiles(2);
    expect(prose((await tileFor('S-23')).textContent)).toContain('Automation failure · excluded');
  });

  it('are outside the three outcome counts the grid states about the site', async () => {
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    const counted = (name: string): number =>
      Number(
        /\d+$/.exec(option('Filter by outcome', new RegExp(`^${name} `)).textContent ?? '')?.[0],
      );

    // The three outcomes the site is answerable for add up to the people every figure in
    // the test is computed over — the run's own `scoredSessionCount`, 22 of 24 — and the
    // two our automation broke are counted by their own option and by *All*, nowhere else.
    expect(counted('Success') + counted('Abandoned') + counted('Failed')).toBe(22);
    expect(counted('Automation failure')).toBe(2);
    expect(counted('All outcomes')).toBe(24);
  });
});

describe('the paging', () => {
  it('shows the prototype’s eight, states the range and the total, and appends the next', async () => {
    const user = userEvent.setup();
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    expect(screen.getByText('Showing 1–8 of 24 · newest first')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Show the next 8' }));

    await tiles(PAGE * 2);
    expect(screen.getByText('Showing 1–16 of 24 · newest first')).toBeTruthy();
  });

  it('asks the mount for one page of video at a time', async () => {
    const user = userEvent.setup();
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    expect(posters()).toHaveLength(PAGE);

    await user.click(screen.getByRole('button', { name: 'Show the next 8' }));
    await tiles(PAGE * 2);

    // One more page, not the whole test: a hundred tiles never load at once.
    expect(posters()).toHaveLength(PAGE * 2);
    expect(posters().length).toBeLessThan(ids().length);
  });

  it('keeps the filter as the next page is appended', async () => {
    const user = userEvent.setup();
    await serveRecorded();
    const { router } = mountApp(`${paths.sessions(SEED)}?outcome=success`);

    await tiles(PAGE);
    await user.click(screen.getByRole('button', { name: 'Show the next 3' }));

    const drawn = await tiles(11);
    expect(router.state.location.search).toBe('?outcome=success');
    expect(drawn.every((label) => label.includes('Success'))).toBe(true);
  });

  it('goes back to the first page when the filter changes', async () => {
    const user = userEvent.setup();
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    await user.click(screen.getByRole('button', { name: 'Show the next 8' }));
    await tiles(PAGE * 2);

    await user.click(option('Filter by outcome', /^Abandoned/));

    await tiles(PAGE);
    expect(screen.getByText('Showing 1–8 of 8 · newest first')).toBeTruthy();
  });
});

describe('the other view of the same people', () => {
  it('is one link away, with every filter carried across', async () => {
    const user = userEvent.setup();
    await serveRecorded();
    const { router } = mountApp(`${paths.sessions(SEED)}?outcome=abandoned&step=review`);

    // Four of the twenty-four gave up on the Review step, which is the composition.
    await tiles(4);
    await user.click(screen.getByRole('link', { name: 'Show these as rows instead' }));

    await screen.findByRole('table');
    const carried = new URLSearchParams(router.state.location.search);
    expect(carried.get('outcome')).toBe('abandoned');
    expect(carried.get('step')).toBe('review');
    expect(carried.get('view')).toBe('rows');
  });

  it('comes back to the grid with the filters still on', async () => {
    const user = userEvent.setup();
    await serveRecorded();
    const { router } = mountApp(`${paths.sessions(SEED)}?outcome=abandoned&view=rows`);

    await screen.findByRole('table');
    await user.click(screen.getByRole('link', { name: 'Show these as a grid of videos instead' }));

    await tiles(PAGE);
    expect(router.state.location.search).toBe('?outcome=abandoned');
  });

  it('applies a filter the rows have no control for, and lets it be dismissed there', async () => {
    const user = userEvent.setup();
    await serveRecorded();
    const { router } = mountApp(`${paths.sessions(SEED)}?step=review&view=rows`);

    await screen.findByRole('table');
    const chip = screen.getByRole('button', { name: /^Ended on: Review/ });
    await user.click(chip);

    await waitFor(() => {
      expect(router.state.location.search).toBe('?view=rows');
    });
  });
});

describe('the grid as a screen reader, a keyboard and a phone reach it', () => {
  it('passes axe', async () => {
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    const main = document.querySelector('main');
    const results = await axePass(main as HTMLElement);

    expect(describeViolations(results.violations)).toBe('');
    expect(results.passes.map((rule) => rule.id)).toEqual(
      expect.arrayContaining(['link-name', 'button-name', 'aria-allowed-attr']),
    );
  }, 60_000);

  it('is operable from the keyboard, one tab stop per person', async () => {
    const user = userEvent.setup();
    await serveRecorded();
    const { router } = mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    const tile = await tileFor('S-24');
    tile.focus();
    expect(document.activeElement).toBe(tile);

    await user.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe(paths.session(SEED, 'S-24'));
  });

  it('nothing on a drawn tile animates', async () => {
    await serveRecorded();
    mountApp(paths.sessions(SEED));

    await tiles(PAGE);
    const tile = await tileFor('S-24');
    const video = tile.querySelector('video') as HTMLVideoElement;

    // A poster frame, never a playing video: there is nothing here to stop under
    // `prefers-reduced-motion` because nothing here moves.
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.hasAttribute('loop')).toBe(false);
    expect(video.hasAttribute('controls')).toBe(false);
  });
});

describe('the grid’s own stylesheet', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const screenDir = join(here, '../../src/screens/sessions');
  const stylesheet = join(screenDir, 'sessionsGrid.module.css');
  const source = (): string => readFileSync(stylesheet, 'utf8');
  const rule = (selectors: string | string[], condition = ''): Record<string, string> =>
    ruleIn(rulesOf(source()))(selectors, condition);

  it('is the prototype’s track, so a phone shows one column and nothing scrolls sideways', () => {
    // 208px at the narrowest, filled rather than fitted: at 390px, less the gutter the
    // page already has, there is room for exactly one column and never for an overflow.
    expect(rule('.vidgrid')['grid-template-columns']).toBe(
      'repeat(auto-fill, minmax(calc(var(--space-4) * 13), 1fr))',
    );
    expect(rule('.vidgrid')['gap']).toBe('var(--space-4)');
    // Nothing in the grid is given a width of its own, which is the other way a tile ends
    // up wider than the phone it is being read on.
    expect(source()).not.toMatch(/\bmin-width\b/);
    expect(source()).not.toMatch(/width:\s*\d+(px|rem|em|ch)/);
  });

  it('reserves the frame’s shape, so a poster landing in it moves no tile', () => {
    // The device's own aspect once the session has been read, and the prototype's
    // landscape until then.
    expect(rule('.thumb')['aspect-ratio']).toBe('var(--thumb-aspect, 16 / 10)');
  });

  it('centres the gaze mark on the point the session recorded', () => {
    expect(rule('.gaze')['transform']).toBe('translate(-50%, -50%)');
    expect(rule('.gaze')['background']).toBe('var(--gaze-fixation)');
    expect(rule('.gaze')['opacity']).toBe('var(--heat-opacity)');
  });

  it('restates no visual value, and is complete and still under reduced motion', () => {
    const declared = rulesOf(source()).flatMap((item) => Object.entries(item.declarations));
    const literal = declared.filter(
      ([property, value]) =>
        /color|background|shadow|font-size|border-radius/.test(property) &&
        !value.includes('var(--') &&
        // A value that is not a visual value at all: the tile takes the page's own text
        // colour rather than declaring one, and `none` and `transparent` declare nothing.
        !['inherit', 'none', 'transparent', 'currentcolor'].includes(value.toLowerCase()),
    );
    expect(literal).toEqual([]);

    // The one transition is the tokens' own base duration, which `tokens.css` sets to 0ms
    // under `prefers-reduced-motion`, and there is no animation and no keyframe at all:
    // nothing on a drawn tile moves, so the screen is already finished and still.
    expect(rule('.vidtile')['transition']).toBe('border-color var(--duration-base) var(--ease)');
    expect(source()).not.toMatch(/@keyframes/);
    expect(source()).not.toMatch(/\banimation\b/);
  });

  it('is the stylesheet the tile and the grid lay themselves out with', () => {
    for (const file of ['VideoTile.tsx', 'SessionsGrid.tsx']) {
      expect(readFileSync(join(screenDir, file), 'utf8')).toContain(
        "from './sessionsGrid.module.css'",
      );
    }
  });
});
