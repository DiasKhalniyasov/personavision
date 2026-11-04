// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSchema } from '@personavision/contract';
import type { Run, SessionProgress } from '@personavision/contract';
import { loadDesignTokens } from '../setup';
import { axeViolations, describeViolations } from '../axe';
import { rulesOf } from '../cssom';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../app';
import { paths } from '../../src/shell/paths';
import { WATCH_INTERVAL_MS } from '../../src/shell/useRun';
import { RunningScreen } from '../../src/screens/runstatus/RunningScreen';

/**
 * A hundred people finishing, and one you can open now: `#screen-running-swarm` of
 * `docs/design/prototype.html` (#281).
 *
 * What the suite beside it proves is the reading of the committed example run — the counts,
 * the wording, the two controls. What this one proves is what a **hundred-agent** run adds,
 * and it is all about honesty with figures nobody measured:
 *
 * - **a square a person, in the five states the prototype names**, drawn from the progress
 *   block's own entries and never from the session files beside the run;
 * - **the same counts in words above it**, because the grid is `aria-hidden` decoration and
 *   nothing on the screen may be readable only as colour;
 * - **the concurrency the run actually ran at**, read from `run.runner` and named as ours
 *   rather than as a cap on the site;
 * - **our own automation failing is ours**: its own square, its own count, said to be
 *   excluded, and never one of the people who gave up (`docs/FLOW.md` section 11);
 * - **a session opens while the run is still going** and comes back to it;
 * - **sessions appear as the artifact grows**, because the viewer re-reads an open run over
 *   the read-only mount — and no faster than that file changes;
 * - **a run with no progress block says it is starting** rather than showing zeroes;
 * - and it is quiet: 390 px, keyboard with a focus ring, clean under axe, still under
 *   `prefers-reduced-motion: reduce`.
 *
 * Every run below is the repository's own example run taken somewhere the pipeline could
 * take it and parsed through `packages/contract`, so a field this screen names is a field
 * the artifact really carries.
 */

const SEED = '2026-10-24-1402-northwind-demo';
const here = dirname(fileURLToPath(import.meta.url));

const seedJson = (): Record<string, unknown> => readRunFile(SEED);
const parse = (run: Record<string, unknown>): Run => runSchema.parse(run);

/** A hundred people, which is what `docs/FLOW.md` section 11 runs by default. */
const PEOPLE = 100;
/** The per-site concurrency of `docs/FLOW.md` section 13, as a run records holding it. */
const CONCURRENCY = 10;

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000 - 2_000).toISOString();

/** The four statuses, cycled so every one of them falls across the grid. */
const STATUSES = ['success', 'abandoned', 'success', 'failed', 'automation_failure'] as const;

/** One finished session of the hundred, in the shape the progress block records it. */
const landed = (index: number): SessionProgress => {
  const status = STATUSES[index % STATUSES.length] ?? 'success';
  return {
    sessionId: `S-${String(index + 1).padStart(3, '0')}`,
    personaName: 'Rushed buyer',
    variant: 'A',
    seed: (index % 3) + 1,
    finishedAt: minutesAgo(10 - index / 20),
    durationMs: 31_000 + index * 1_000,
    status,
    step: status === 'success' ? 'confirm' : 'review',
    reason: status === 'automation_failure' ? 'selector timeout on the card iframe' : '',
    attribution: status === 'automation_failure' ? 'automation' : 'product',
  };
};

interface SwarmOptions {
  readonly finished?: number;
  readonly total?: number;
  /** `null` for a run that records no runner block, and therefore no concurrency. */
  readonly concurrency?: number | null;
  readonly sessions?: readonly SessionProgress[];
}

/**
 * The example run as a path-1 test of a hundred people on one version: one variant, a
 * hundred planned sessions, a runner block that states what it holds in flight.
 */
const swarmRun = (options: SwarmOptions = {}): Run => {
  const total = options.total ?? PEOPLE;
  const sessions =
    options.sessions ?? Array.from({ length: options.finished ?? 63 }, (_u, i) => landed(i));
  const concurrency = options.concurrency === undefined ? CONCURRENCY : options.concurrency;
  const seed = seedJson();

  return parse({
    ...seed,
    status: 'open',
    startedAt: minutesAgo(10),
    feature: 'generating a video from a prompt',
    // One version, as a path-1 test is, with a session id per planned person.
    variants: (seed.variants as unknown[]).slice(0, 1),
    sessionIds: Array.from({ length: total }, (_u, i) => `S-${String(i + 1).padStart(3, '0')}`),
    ...(concurrency === null ? {} : { runner: { where: 'local', image: null, concurrency } }),
    progress: {
      totalSessions: total,
      finishedSessions: sessions.length,
      perVariant: [{ variant: 'A', totalSessions: total, finishedSessions: sessions.length }],
      sessions,
    },
  });
};

/**
 * The committed example run, still open, with a progress block over its own first `finished`
 * session ids — so the people the screen lists are people whose files are really on disk and
 * whose replays really open.
 */
const openSeed = (finished: number): string => {
  const seed = seedJson();
  const ids = (seed as unknown as { sessionIds: string[] }).sessionIds;
  return JSON.stringify({
    ...seed,
    status: 'open',
    startedAt: minutesAgo(3),
    progress: {
      totalSessions: ids.length,
      finishedSessions: finished,
      perVariant: [],
      sessions: ids.slice(0, finished).map((sessionId, index) => ({
        ...landed(index),
        sessionId,
        variant: 'A',
        status: 'success' as const,
        step: 'confirm',
        reason: '',
        attribution: 'product' as const,
      })),
    },
  });
};

const show = (ui: ReactElement) => render(ui, { wrapper: MemoryRouter });

/** The squares of the grid, by the state each is drawn in. */
const squares = (container: HTMLElement): (string | null)[] =>
  [...container.querySelectorAll('.swarmgrid i')].map((square) => square.getAttribute('data-done'));

/** The counts in words above the grid. */
const counts = (): string => screen.getByRole('status').textContent ?? '';

/** jsdom answers every media query `false`; this makes one of them answer `true`. */
const prefersReducedMotion = (matches: boolean): void => {
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches: query.includes('prefers-reduced-motion') ? matches : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
};

const stylesheet = (name: string): string =>
  readFileSync(join(here, '../../src/screens/runstatus', name), 'utf8');

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('a square a person', () => {
  it('draws one square per planned session, finished then in flight then not started', () => {
    const { container } = show(<RunningScreen run={swarmRun()} />);
    const drawn = squares(container);

    expect(drawn).toHaveLength(PEOPLE);
    // Sixty-three landed, ten in flight at the concurrency the run records, the rest waiting.
    expect(drawn.slice(0, 63).every((state) => state !== null && state !== 'running')).toBe(true);
    expect(drawn.filter((state) => state === 'running')).toHaveLength(CONCURRENCY);
    expect(drawn.filter((state) => state === null)).toHaveLength(PEOPLE - 63 - CONCURRENCY);
  });

  it('draws the five states the prototype names, in the order the artifact appended them', () => {
    const run = swarmRun();
    const { container } = show(<RunningScreen run={run} />);
    const drawn = squares(container);

    const expected: Record<SessionProgress['status'], string> = {
      success: 'success',
      abandoned: 'abandoned',
      failed: 'failed',
      automation_failure: 'automation',
    };
    (run.progress?.sessions ?? []).forEach((entry, index) => {
      expect(drawn[index], entry.sessionId).toBe(expected[entry.status]);
    });
  });

  it('is decoration: the grid says nothing to a screen reader', () => {
    const { container } = show(<RunningScreen run={swarmRun()} />);
    const grid = container.querySelector('.swarmgrid');

    expect(grid?.getAttribute('aria-hidden')).toBe('true');
    // Not a list, not a table, and no tab stop: a hundred squares changing every few
    // seconds would be a wall of noise, and the rows under it are the links.
    expect(grid?.querySelectorAll('[tabindex]')).toHaveLength(0);
    expect(grid?.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('states the same counts in words, so nothing is readable only as colour', () => {
    const { container } = show(<RunningScreen run={swarmRun()} />);
    const drawn = squares(container);
    const words = counts();

    const of = (state: string | null) => drawn.filter((square) => square === state).length;
    expect(words).toContain(`${of('success')} succeeded`);
    expect(words).toContain(`${of('abandoned')} gave up`);
    expect(words).toContain(`${of('failed')} failed`);
    expect(words).toContain(
      `${of('automation')} our own automation failing, excluded from the results`,
    );
    expect(words).toContain(`${of('running')} still going`);
    expect(words).toContain(`${of(null)} not started`);
  });

  it('draws no two of its six states alike, once the tokens are resolved', () => {
    // `--color-accent-soft` and `--color-surface-sunken` are the **same value** in the light
    // palette, so a square in flight and a square nobody has started would be drawn
    // identically and two of the states the footnote names would be one. The check is on the
    // resolved values rather than on the token names, which is the only way to see that.
    const root = getComputedStyle(document.documentElement);
    const resolve = (value: string): string =>
      value.replace(/var\((--[\w-]+)\)/gu, (_whole, name: string) =>
        root.getPropertyValue(name).trim(),
      );

    const rules = rulesOf(stylesheet('RunningScreen.css')).filter(
      (rule) => rule.selector.startsWith('.swarmgrid i') && rule.condition === '',
    );
    // Not started is the base rule's own look; each state adds to it.
    const base = rules.find((rule) => rule.selector === '.swarmgrid i');
    if (base === undefined) throw new Error('the grid draws no square');
    const states = rules.filter((rule) => rule !== base);
    expect(states).toHaveLength(5);

    const paint = ['background', 'box-shadow', 'border-color', 'opacity'];
    const look = (declarations: Record<string, string>): string =>
      paint
        .map(
          (property) =>
            `${property}:${resolve(declarations[property] ?? base.declarations[property] ?? '')}`,
        )
        .join(';');

    const looks = [base, ...states].map((rule) => `${rule.selector} → ${look(rule.declarations)}`);
    const painted = looks.map((entry) => entry.split(' → ')[1] ?? '');
    expect(root.getPropertyValue('--color-accent-soft').trim()).not.toBe('');
    expect(new Set(painted).size, looks.join('\n')).toBe(looks.length);
  });

  it('reflows rather than widening the page: the columns are found, not counted', () => {
    const grid = rulesOf(stylesheet('RunningScreen.css')).find(
      (rule) => rule.selector === '.swarmgrid' && rule.condition === '',
    );

    // `auto-fill` with a minimum is what makes a hundred squares fit 390 px by taking more
    // rows; a fixed ten columns would push the page sideways.
    expect(grid?.declarations['grid-template-columns']).toContain('auto-fill');
    expect(grid?.declarations['grid-template-columns']).toContain('minmax');
  });
});

describe('the concurrency under the grid', () => {
  it('states the concurrency the run records, as ours and not as a cap on the site', () => {
    show(<RunningScreen run={swarmRun()} />);
    const key = screen.getByText(/One square a person/);

    expect(key.textContent).toContain('succeeded, gave up, failed, still going, not started');
    expect(key.textContent).toContain(
      `${CONCURRENCY} run at once, which is the concurrency this run was started with`,
    );
    // `runner.concurrency` is our own ceiling on sessions in flight; the per-site caps are
    // the platform's separate numbers, and this footnote must not claim to be one.
    expect(key.textContent).not.toMatch(/cap this site/i);
  });

  it('claims no concurrency, and draws nothing as running, for a run that records none', () => {
    const { container } = show(<RunningScreen run={swarmRun({ concurrency: null })} />);

    expect(screen.getByText(/One square a person/).textContent).not.toMatch(/at once/);
    expect(squares(container).filter((state) => state === 'running')).toHaveLength(0);
    // With nothing known to be in flight, the outstanding people are not split into two
    // figures nobody measured.
    expect(counts()).toContain(`${PEOPLE - 63} not yet finished`);
    expect(counts()).not.toMatch(/still going/);
  });

  it('runs fewer than the concurrency when fewer than that are left', () => {
    const { container } = show(<RunningScreen run={swarmRun({ finished: 97 })} />);

    expect(squares(container).filter((state) => state === 'running')).toHaveLength(3);
    expect(counts()).toContain('3 still going');
    expect(counts()).toContain('0 not started');
  });
});

describe('our own automation failing', () => {
  it('is its own square and its own count, and is never somebody who gave up', () => {
    const run = swarmRun();
    const { container } = show(<RunningScreen run={run} />);

    const ours = (run.progress?.sessions ?? []).filter(
      (entry) => entry.status === 'automation_failure',
    ).length;
    const gaveUp = (run.progress?.sessions ?? []).filter(
      (entry) => entry.status === 'abandoned',
    ).length;

    expect(ours).toBeGreaterThan(0);
    expect(squares(container).filter((state) => state === 'automation')).toHaveLength(ours);
    expect(counts()).toContain(`${ours} our own automation failing, excluded from the results`);
    expect(counts()).toContain(`${gaveUp} gave up`);
    // The two figures are different, which is what makes the distinction worth drawing.
    expect(ours).not.toBe(gaveUp);
  });

  it('is marked as ours in its row and said to be excluded', () => {
    show(<RunningScreen run={swarmRun({ finished: 5 })} />);

    const row = screen
      .getAllByRole('row')
      .find((candidate) => (candidate.textContent ?? '').includes('Automation failure'));
    expect(row?.textContent).toContain('excluded');
    expect(screen.getByText(/our own automation failing, not this site/i).textContent).toMatch(
      /excluded from every figure and from every recommendation/,
    );
  });

  it('says nothing about it at all on a run that has none', () => {
    const clean = Array.from({ length: 4 }, (_u, index) => ({
      ...landed(index),
      status: 'success' as const,
      step: 'confirm',
      reason: '',
      attribution: 'product' as const,
    }));
    show(<RunningScreen run={swarmRun({ sessions: clean })} />);

    expect(counts()).not.toMatch(/automation/i);
    expect(screen.queryByText(/our own automation failing, not this site/i)).toBeNull();
    expect(screen.getByText(/One square a person/).textContent).not.toMatch(/sixth colour/);
  });
});

describe('opening one of them while the run is going', () => {
  it('links each row to that person’s replay, named so the links can be told apart', () => {
    const run = swarmRun({ finished: 5 });
    show(<RunningScreen run={run} />);

    const newest = run.progress?.sessions.at(-1)?.sessionId ?? '';
    const watch = screen.getByRole('link', { name: `Watch ${newest}` });
    expect(watch.getAttribute('href')).toBe(paths.session(run.runId, newest));
    // The id itself is a link to the same place, as the Sessions table has it.
    expect(screen.getByRole('link', { name: newest }).getAttribute('href')).toBe(
      paths.session(run.runId, newest),
    );
  });

  it('opens the replay over an open run, and the way back is this screen', async () => {
    const ids = (seedJson() as unknown as { sessionIds: string[] }).sessionIds;
    await serveRunData({ files: { [`/runs/${SEED}/run.json`]: openSeed(3) } });
    mountApp(paths.run(SEED));

    // The newest of the three, which is the row at the top.
    const watch = await screen.findByRole('link', { name: `Watch ${ids[2]}` });
    await userEvent.click(watch);

    // The session's own screen, read from the file that landed beside the still-open run.
    // Its breadcrumb and the chrome's tab both lead back to this test; either is the way
    // back, and the breadcrumb is the first of them.
    const back = (await screen.findAllByRole('link', { name: 'Verdict' }))[0];
    if (back === undefined) throw new Error('the replay offered no way back');
    expect(back.getAttribute('href')).toBe(paths.run(SEED));
    await userEvent.click(back);

    // `/runs/:runId` is the Running screen for as long as the test is open, so the reader
    // comes back to the progress they left.
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: /people have finished$/ })).toBeTruthy();
    });
  });
});

describe('the figures move as the artifact does', () => {
  it('re-reads an open run, and shows the sessions that landed since', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ids = (seedJson() as unknown as { sessionIds: string[] }).sessionIds;
    // The stub reads this object at request time, so changing it is the file changing on the
    // mount under the screen — which is what the pipeline does as each person lands.
    const files: Record<string, string> = { [`/runs/${SEED}/run.json`]: openSeed(2) };
    const served = await serveRunData({ files });
    mountApp(paths.run(SEED));

    await screen.findByRole('heading', { level: 1, name: '2 of 24 people have finished' });
    expect(served.requests.filter((request) => request === `/runs/${SEED}/run.json`)).toHaveLength(
      1,
    );

    // A third person lands, and the file the mount serves changes under the screen.
    files[`/runs/${SEED}/run.json`] = openSeed(3);
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS + 100);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: '3 of 24 people have finished' }),
      ).toBeTruthy();
    });
    expect(screen.getByRole('link', { name: `Watch ${ids[2]}` })).toBeTruthy();
    vi.useRealTimers();
  });

  it('polls no faster than the file changes, and two readers are still one read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const served = await serveRunData({ files: { [`/runs/${SEED}/run.json`]: openSeed(2) } });
    mountApp(paths.run(SEED));

    await screen.findByRole('heading', { level: 1, name: /people have finished$/ });
    const reads = () =>
      served.requests.filter((request) => request === `/runs/${SEED}/run.json`).length;

    // Half an interval buys nothing: the pipeline rewrites the file as people land, and a
    // read of a file that has not changed is a read nobody needed.
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS / 2);
    expect(reads()).toBe(1);

    // One interval, one read — although the chrome names this test and the screen renders
    // it, and both are watching it.
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS);
    await waitFor(() => {
      expect(reads()).toBe(2);
    });
    expect(reads()).toBe(2);
    vi.useRealTimers();
  });

  it('polls a finished test not at all: its artifact is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const served = await serveRunData();
    mountApp(paths.run(SEED));

    await waitFor(() => {
      expect(document.querySelector('[data-section="headline"]')).not.toBeNull();
    });
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS * 3);

    expect(served.requests.filter((request) => request === `/runs/${SEED}/run.json`)).toHaveLength(
      1,
    );
    vi.useRealTimers();
  });

  it('hands back the same reading when the file has not changed', async () => {
    // Every parse of one file makes a new `Run`, and screens elsewhere key effects on a
    // run's identity — the Sessions screen re-reads every session file of the test when it
    // changes. A poll of an unchanged file must therefore not produce a new object, or that
    // screen re-fetches a hundred files and blanks to its loading state every five seconds.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const served = await serveRunData({ files: { [`/runs/${SEED}/run.json`]: openSeed(2) } });
    mountApp(`${paths.sessions(SEED)}?view=rows`);
    await screen.findByRole('heading', { name: 'What happened to each person' });

    const sessionReads = () =>
      served.requests.filter((request) => request.includes('/sessions/')).length;
    const before = sessionReads();
    expect(before).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS * 2 + 100);
    await waitFor(() => {
      expect(
        served.requests.filter((request) => request === `/runs/${SEED}/run.json`).length,
      ).toBeGreaterThan(1);
    });

    // The run was read again; the sessions were not, and the screen never went back to
    // its loading state.
    expect(sessionReads()).toBe(before);
    expect(screen.getByRole('heading', { name: 'What happened to each person' })).toBeTruthy();
    vi.useRealTimers();
  });

  it('re-reads the run and nothing else: the workspace listing is left alone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const served = await serveRunData({ files: { [`/runs/${SEED}/run.json`]: openSeed(2) } });
    mountApp(paths.run(SEED));
    await screen.findByRole('heading', { level: 1, name: /people have finished$/ });

    const listings = () =>
      served.requests.filter((request) => request === '/runs/index.json').length;
    const before = listings();

    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS * 2 + 100);
    await waitFor(() => {
      expect(
        served.requests.filter((request) => request === `/runs/${SEED}/run.json`).length,
      ).toBeGreaterThan(1);
    });

    // The watcher watches `run.json`. The rest of a run directory is written once, and the
    // workspace's listing is not this test's business.
    expect(listings()).toBe(before);
    vi.useRealTimers();
  });

  it('gives up on a run that stops being readable, rather than freezing its figures', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const files: Record<string, string> = { [`/runs/${SEED}/run.json`]: openSeed(2) };
    await serveRunData({ files });
    mountApp(paths.run(SEED));
    await screen.findByRole('heading', { level: 1, name: '2 of 24 people have finished' });

    // The directory goes away under the open screen.
    files[`/runs/${SEED}/run.json`] = '{ not json';

    // One bad read is an instant of a file being rewritten, and the figures stay put.
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS + 100);
    expect(
      screen.getByRole('heading', { level: 1, name: '2 of 24 people have finished' }),
    ).toBeTruthy();

    // Several in a row is not an instant: the reader is told, rather than left reading
    // figures that stopped being true under a request every five seconds.
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS * 3 + 100);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'That test could not be read' })).toBeTruthy();
    });
    vi.useRealTimers();
  });
});

describe('the clock in the lede', () => {
  it('prints the time alone for a test that started today', () => {
    const { container } = show(<RunningScreen run={swarmRun()} />);

    expect(container.querySelector('.lede')?.textContent).toMatch(/started \d\d:\d\d,/);
  });

  it('prints the day too for one that did not, so a stalled test reads as one', () => {
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    const run = parse({
      ...seedJson(),
      status: 'open',
      startedAt: yesterday.toISOString(),
      progress: {
        totalSessions: 24,
        finishedSessions: 2,
        perVariant: [],
        sessions: [landed(0), landed(1)].map((entry, index) => ({
          ...entry,
          sessionId: `S-0${index + 1}`,
          variant: 'A',
        })),
      },
    });

    const lede = show(<RunningScreen run={run} />).container.querySelector('.lede')?.textContent;
    // Day then month, as the rest of the product prints a date — `3 Nov`, not `Nov 3`.
    const day = new Intl.DateTimeFormat('en-US', { day: 'numeric' }).format(yesterday);
    const month = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(yesterday);
    expect(lede).toContain(`started ${day} ${month} `);
  });
});

describe('a run with no progress block yet', () => {
  const starting = (): Run => {
    const seed = seedJson();
    return parse({ ...seed, status: 'open', startedAt: minutesAgo(1), progress: undefined });
  };

  it('renders the frame and says it is starting, with no zero dressed as a measurement', () => {
    show(<RunningScreen run={starting()} />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This test is starting');
    expect(screen.getByText(/records no progress yet/)).toBeTruthy();
    // No bar, no counts, no estimate: nothing has been measured to put in any of them.
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/0 of /)).toBeNull();
    expect(screen.queryByText(/ left/)).toBeNull();
  });

  it('draws the planned people as squares nobody has started, from the run’s own manifest', () => {
    const run = starting();
    const { container } = show(<RunningScreen run={run} />);

    expect(run.sessionIds).toHaveLength(24);
    expect(squares(container)).toEqual(Array.from({ length: 24 }, () => null));
    // Nothing is claimed to be in flight on a run that has recorded nothing at all.
    expect(screen.getByText(/One square a person/).textContent).not.toMatch(/at once/);
  });

  it('still names what is being tested, and still offers the way on', () => {
    const run = starting();
    const { container } = show(<RunningScreen run={run} />);

    expect(container.querySelector('.lede')?.textContent).toContain(run.task.prompt);
    expect(screen.getByText(/Nobody has finished yet/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open the results so far/ })).toBeTruthy();
  });
});

describe('a stopped test', () => {
  it('states what stopping keeps, beside the control that would do it', () => {
    show(<RunningScreen run={swarmRun()} />);

    expect(
      screen.getByText(
        /Each person is saved as they finish; stopping keeps everyone who is already done\./,
      ),
    ).toBeTruthy();
  });

  it('reads as a finished test of the people who finished, not as one still running', async () => {
    // The owner's decision 50: a stopped test is recorded as finished and its progress still
    // says how many of how many it got through. This screen must not claim such a test is
    // still running.
    const stopped = JSON.stringify({
      ...seedJson(),
      status: 'finished',
      startedAt: minutesAgo(5),
      finishedAt: minutesAgo(1),
      progress: {
        totalSessions: 24,
        finishedSessions: 0,
        perVariant: [],
        sessions: [],
      },
    });
    await serveRunData({ files: { [`/runs/${SEED}/run.json`]: stopped } });
    mountApp(paths.run(SEED));

    await waitFor(() => {
      expect(document.querySelector('[data-section="headline"]')).not.toBeNull();
    });
    expect(screen.queryByText(/people have finished/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Stop the test/ })).toBeNull();
  });
});

describe('the screen is quiet', () => {
  it('passes axe with a hundred squares and a table on it', async () => {
    const { container } = show(<RunningScreen run={swarmRun()} />);
    const violations = await axeViolations(container);

    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('is operable by keyboard: the tab order walks forward and never sticks', async () => {
    const user = userEvent.setup();
    const { container } = show(<RunningScreen run={swarmRun({ finished: 5 })} />);

    const controls = [
      ...container.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]'),
    ];
    const first = controls[0];
    if (first === undefined) throw new Error('the screen drew no control');
    first.focus();

    const stops: Element[] = [first];
    for (let step = 0; step < Math.min(controls.length - 1, 10); step += 1) {
      await user.tab();
      const landed = document.activeElement as Element;
      // Forward, and somewhere new: a tab that lands where it started is a trap.
      expect(stops.includes(landed), landed.outerHTML.slice(0, 120)).toBe(false);
      stops.push(landed);
    }
    expect(stops.length).toBeGreaterThan(1);

    // Nothing is kept out of the tab order: the squares carry no stop and everything that
    // does is reachable.
    for (const control of controls) {
      expect(control.getAttribute('tabindex'), control.outerHTML.slice(0, 120)).not.toBe('-1');
    }
  });

  it('reads the focus ring itself out of the tokens', () => {
    // `--border-width-strong` in `--color-focus` (`docs/FLOW.md` section 10), both read from
    // the committed tokens file rather than written out here.
    const tokens = getComputedStyle(document.documentElement);
    expect(tokens.getPropertyValue('--color-focus').trim()).not.toBe('');
    expect(tokens.getPropertyValue('--border-width-strong').trim()).not.toBe('');
  });

  it('restates no visual value: every colour and every length is a token', () => {
    for (const name of ['RunningScreen.css', 'justFinished.module.css']) {
      const body = stylesheet(name)
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/@media[^{]*/gu, '');

      expect(body, name).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
      expect(body, name).not.toMatch(/\brgba?\(/iu);
      expect(body, name).not.toMatch(/\d\s*(px|rem|em)\b/iu);
    }
  });
});

describe('the screen holds at 390 px', () => {
  const sheets = ['RunningScreen.css', 'justFinished.module.css'];

  it('asks for no room in pixels: nothing on it has a fixed width', () => {
    // The four properties that make a box demand room. `0px` is not one of them — it
    // demands nothing, which is what a flex child is given so that it may shrink.
    const fixed = ['width', 'min-width', 'min-inline-size', 'inline-size'];

    for (const name of sheets) {
      for (const rule of rulesOf(stylesheet(name))) {
        for (const [property, value] of Object.entries(rule.declarations)) {
          if (!fixed.includes(property)) continue;
          const where = `${name}: ${rule.selector} ${property}: ${value}`;
          const pixels = /^(\d+(?:\.\d+)?)px$/u.exec(value.trim());
          if (pixels === null) expect(value, where).not.toMatch(/\d\s*px/u);
          else expect(Number(pixels[1]), where).toBe(0);
        }
      }
    }
  });

  it('lets only the wide table scroll sideways, inside its own card', () => {
    // The page itself never scrolls horizontally: the grid reflows, and where the table has
    // more columns than a phone has room for, the box around it scrolls.
    const scrollers: string[] = [];

    for (const name of sheets) {
      for (const rule of rulesOf(stylesheet(name))) {
        const overflow = rule.declarations['overflow-x'];
        if (overflow === undefined || overflow === 'hidden' || overflow === 'visible') continue;
        scrollers.push(`${name}: ${rule.selector}`);
        expect(rule.selector, `${name}: ${rule.selector} scrolls sideways`).toBe('.tablewrap');
      }
    }
    expect(scrollers.length).toBeGreaterThan(0);
  });
});

describe('under prefers-reduced-motion: reduce', () => {
  it('is complete and still: the figures are all there and nothing is animated by script', () => {
    prefersReducedMotion(true);
    const { container } = show(<RunningScreen run={swarmRun()} />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      '63 of 100 people have finished',
    );
    expect(squares(container)).toHaveLength(PEOPLE);
    expect(counts()).toContain('still going');

    for (const element of container.querySelectorAll<HTMLElement>('[style]')) {
      expect(element.style.animation, element.outerHTML).toBe('');
      expect(element.style.animationDuration, element.outerHTML).toBe('');
      expect(element.style.transitionDuration, element.outerHTML).toBe('');
    }
  });

  it('animates one thing, and the tokens flatten it', () => {
    // The bar's pulse is the prototype's own and the only animation on this screen. It runs
    // on `pv-pulse`, which `tokens.css` redefines to a still frame under the query, so
    // nothing here has to read the preference in script.
    const sheets = ['RunningScreen.css', 'justFinished.module.css'].map(stylesheet).join('\n');
    const animated = [...sheets.matchAll(/animation:\s*([\w-]+)/gu)].map((match) => match[1]);
    expect(animated).toEqual(['pv-pulse']);
    expect(sheets).not.toMatch(/@keyframes/u);

    const tokens = readFileSync(join(here, '../../../../docs/design/tokens.css'), 'utf8');
    expect(tokens).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*@keyframes pv-pulse/u);
  });
});
