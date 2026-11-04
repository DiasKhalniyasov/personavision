// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSchema } from '@personavision/contract';
import type { Run, SessionProgress } from '@personavision/contract';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../app';
import { paths } from '../../src/shell/paths';
import { RunFailedScreen } from '../../src/screens/runstatus/RunFailedScreen';
import { RunningScreen } from '../../src/screens/runstatus/RunningScreen';

/**
 * The two states `/runs/:runId` shows when a test is not a finished comparison:
 * `#screen-running-swarm` and `#screen-error` of `docs/design/prototype.html`.
 *
 * Every figure on both screens is read from the run artifact as the pipeline wrote it, so
 * every run below is **the repository's own example run** taken somewhere the pipeline
 * could take it and parsed through `packages/contract`: a field these screens name is a
 * field the artifact really carries, and a fixture the schema would reject is never
 * rendered. What is asserted is what a reader can see — the counts, the wording, the log's
 * order, what each button does — and never a class name.
 */

const SEED = '2026-10-24-1402-northwind-demo';

/** The example run's own JSON, which every fixture here is a patch of. */
const seedJson = (): Record<string, unknown> => readRunFile(SEED);

/** Anything the pipeline could write, parsed the way `useRun` parses what it reads. */
const parse = (run: Record<string, unknown>): Run => runSchema.parse(run);

const minutesAgo = (minutes: number): string =>
  // Two seconds past the minute, so a floor to whole minutes cannot land on the boundary.
  new Date(Date.now() - minutes * 60_000 - 2_000).toISOString();

/** One finished session, in the shape the run's progress block records it. */
const finished = (patch: Partial<SessionProgress> & { sessionId: string }): SessionProgress => ({
  personaName: 'Rushed buyer',
  variant: 'A',
  seed: 1,
  finishedAt: minutesAgo(1),
  durationMs: 31_000,
  status: 'success',
  step: 'confirm',
  reason: '',
  attribution: 'product',
  ...patch,
});

/** `count` finished sessions on one variant, oldest first, as the artifact appends them. */
const landed = (count: number, variant: string, from: number): SessionProgress[] =>
  Array.from({ length: count }, (_unused, index) =>
    finished({
      sessionId: `S-${String(from + index).padStart(2, '0')}`,
      variant,
      seed: (index % 3) + 1,
      finishedAt: minutesAgo(3 - (index + 1) / (count + 1)),
    }),
  );

interface OpenRunOptions {
  /** Minutes since the swarm started. */
  readonly elapsed?: number;
  readonly totalSessions?: number;
  readonly perVariant?: readonly { variant: string; totalSessions: number }[];
  readonly sessions?: readonly SessionProgress[];
  readonly engine?: Partial<Run['engine']>;
  readonly usage?: Run['usage'];
}

const BOTH_VARIANTS = [
  { variant: 'A', totalSessions: 12 },
  { variant: 'B', totalSessions: 12 },
] as const;

/**
 * The example run, still open: the status, the start, the progress block and whatever
 * engine ran it. The per-variant finished counts are derived from the log, as the contract
 * holds them to be, so a fixture cannot claim a split that does not add up.
 */
const openRun = (options: OpenRunOptions = {}): Run => {
  const sessions = options.sessions ?? [...landed(10, 'A', 1), ...landed(7, 'B', 11)];
  const planned = options.perVariant ?? BOTH_VARIANTS;
  const seed = seedJson();

  return parse({
    ...seed,
    status: 'open',
    startedAt: minutesAgo(options.elapsed ?? 3),
    engine: { ...(seed.engine as Record<string, unknown>), ...options.engine },
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    progress: {
      totalSessions: options.totalSessions ?? 24,
      finishedSessions: sessions.length,
      perVariant: planned.map((variant) => ({
        ...variant,
        finishedSessions: sessions.filter((entry) => entry.variant === variant.variant).length,
      })),
      sessions,
    },
  });
};

/** The example run, failed before it simulated anybody. */
const failedRun = (
  failure: Run['failure'],
  options: { engine?: Partial<Run['engine']> } = {},
): Run => {
  const seed = seedJson();
  return parse({
    ...seed,
    status: 'failed',
    startedAt: minutesAgo(1),
    finishedAt: minutesAgo(1),
    engine: { ...(seed.engine as Record<string, unknown>), ...options.engine },
    failure,
  });
};

/** A run that called the standard model, and what such a run spends. */
const MODEL: Partial<Run['engine']> = {
  mode: 'model',
  modelMode: 'standard',
  provider: 'meta',
  models: {
    decision: 'muse-spark-1.3',
    segmentation: 'muse-spark-1.3',
    planning: 'muse-spark-1.3',
  },
};

const CONTRIBUTOR: Partial<Run['engine']> = { ...MODEL, modelMode: 'contributor' };

const USAGE: Run['usage'] = {
  calls: 312,
  inputTokens: 1_200_000,
  cachedInputTokens: 400_000,
  outputTokens: 88_000,
  reasoningTokens: 12_000,
  estimatedCostUsd: 0.42,
};

/** Both screens are mounted the way the run route mounts them: inside the router. */
const show = (ui: ReactElement) => render(ui, { wrapper: MemoryRouter });

/** The *Just finished* rows, in the order they are rendered, cell by cell. */
const finishedRows = (): string[][] =>
  screen
    .queryAllByRole('row')
    .map((row) => [...row.querySelectorAll('td')].map((cell) => (cell.textContent ?? '').trim()))
    .filter((cells) => cells.length > 0);

/** One row as one string, for an assertion about the row rather than about a cell. */
const finishedLines = (): string[] => finishedRows().map((cells) => cells.join(' · '));

/** The heading of the Running screen, which is the count. */
const heading = (): string => screen.getByRole('heading', { level: 1 }).textContent ?? '';

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the Running screen', () => {
  it('counts the people who have finished against the run’s total, in its heading', () => {
    show(<RunningScreen run={openRun()} />);

    expect(heading()).toBe('17 of 24 people have finished');
  });

  it('names what was tested and for whom, with the clock, in the lede', () => {
    const run = openRun();
    const { container } = show(<RunningScreen run={run} />);
    const lede = container.querySelector('.lede')?.textContent ?? '';

    // A run carrying no feature sentence is named by the task it was asked for, which is
    // what the chrome names it too.
    expect(run.feature).toBeUndefined();
    expect(lede).toContain(run.task.prompt);
    expect(lede).toContain(run.audience.name);
    expect(lede).toMatch(/started \d\d:\d\d/);
    // One sentence, with the parts separated by the prototype's own middle dots and no
    // stray space before the full stop.
    expect(lede).toMatch(
      /^.+ · Outdoor-gear shoppers · started \d\d:\d\d, about \d+ minutes? left · offline deterministic engine\. You can open a session the moment it lands\.$/,
    );
  });

  it('takes the counts from the artifact rather than re-deriving them from the sessions', () => {
    // The run plans twenty but holds twenty-four session files: the screen reports what the
    // run recorded, because the run is what knows how far along it is.
    const run = openRun({
      totalSessions: 20,
      perVariant: [
        { variant: 'A', totalSessions: 10 },
        { variant: 'B', totalSessions: 10 },
      ],
    });

    expect(run.sessionIds).toHaveLength(24);
    show(<RunningScreen run={run} />);

    expect(heading()).toBe('17 of 20 people have finished');
  });

  it('draws one row per version, with its own count and its own bar', () => {
    show(<RunningScreen run={openRun()} />);

    expect(screen.getAllByRole('progressbar', { name: /checkout|candidate/i })).toHaveLength(2);

    const current = screen.getByRole('progressbar', { name: /Current checkout/ });
    expect(current.getAttribute('aria-valuenow')).toBe('10');
    expect(current.getAttribute('aria-valuemax')).toBe('12');
    expect(current.getAttribute('aria-valuetext')).toBe('10 of 12 people finished');

    expect(screen.getByText('10 / 12')).toBeTruthy();
    expect(screen.getByText('7 / 12')).toBeTruthy();
  });

  it('draws no version rows for a run with one version, as the prototype does not', () => {
    const { container } = show(
      <RunningScreen
        run={openRun({
          perVariant: [{ variant: 'A', totalSessions: 24 }],
          sessions: landed(17, 'A', 1),
        })}
      />,
    );

    expect(container.querySelector('[data-section="per-version"]')).toBeNull();
    expect(screen.getByRole('progressbar', { name: /overall/i })).toBeTruthy();
    expect(screen.queryAllByRole('progressbar')).toHaveLength(1);
  });

  it('announces the counts to assistive technology, and does not let the rows do it', () => {
    const { container } = show(<RunningScreen run={openRun()} />);

    // The counts above the grid are the claim the grid is a picture of, so they are what is
    // announced as they change.
    const announced = screen.getByRole('status');
    expect(announced.textContent).toMatch(/\d+ succeeded · \d+ gave up · \d+ failed/);

    // The rows change far more often than the counts and are the one thing on this screen a
    // reader scrolls: they announce nothing and take no focus of their own.
    const rows = screen.getByRole('region', { name: /just finished/i });
    expect(rows.getAttribute('aria-live')).toBeNull();
    expect(rows.contains(announced)).toBe(false);
    expect(document.activeElement).toBe(container.ownerDocument.body);
  });

  it('lists the people who just finished, newest first', () => {
    const run = openRun();
    show(<RunningScreen run={run} />);

    // The prototype shows the last handful rather than all seventeen.
    const lines = finishedLines();
    expect(lines).toHaveLength(5);
    // The artifact appends in the order they finished, so its last entry is the first row.
    expect(lines[0]).toContain(run.progress?.sessions.at(-1)?.sessionId ?? '');
    expect(lines.at(-1)).toContain(run.progress?.sessions.at(-5)?.sessionId ?? '');

    // And it says how many of how many it is showing, so a reader who cannot see that the
    // card holds five rows is not left thinking those five are everybody.
    expect(screen.getByText(/The 5 most recent of the 17 people who have finished/)).toBeTruthy();
  });

  it('renders each row from the stored fields: who, the outcome, the time, where they ended', () => {
    const run = openRun({
      sessions: [
        finished({
          sessionId: 'S-24',
          personaName: 'Price-sensitive scanner',
          variant: 'B',
          durationMs: 68_000,
          status: 'abandoned',
          step: 'review',
          reason: 'service fee revealed late',
          attribution: 'product',
        }),
      ],
    });

    show(<RunningScreen run={run} />);
    const [session, person, outcome, time, where] = finishedRows()[0] ?? [];

    expect(session).toBe('S-24');
    // The person's own name, and the age and device of the persona the run carries by that
    // name — the progress entry names the person, the run describes them.
    // The example run's people carry no stated age, so the clause is simply absent rather
    // than printing somebody aged nothing.
    expect(person).toBe('Price-sensitive scanner · iPhone 15');
    // The vocabulary of `docs/FLOW.md` section 8, and the step as the run labels it.
    expect(outcome).toBe('Abandoned');
    expect(time).toBe('1:08');
    expect(where).toBe('Review');
  });

  it('keeps success, a failed task and our own automation breaking three different things', () => {
    const run = openRun({
      totalSessions: 12,
      perVariant: [{ variant: 'A', totalSessions: 12 }],
      sessions: [
        finished({ sessionId: 'S-01', durationMs: 58_400, status: 'success' }),
        finished({
          sessionId: 'S-02',
          status: 'failed',
          step: 'payment',
          reason: 'the saved card was rejected',
        }),
        finished({
          sessionId: 'S-03',
          status: 'automation_failure',
          step: 'payment',
          reason: 'selector timeout on card iframe, will retry once',
          attribution: 'automation',
        }),
      ],
    });

    show(<RunningScreen run={run} />);
    const [newest, middle, oldest] = finishedRows();

    expect(oldest?.[2]).toBe('Success');
    expect(middle?.[2]).toBe('Failed');
    expect(middle?.[4]).toBe('Payment');
    expect(newest?.[2]).toBe('Automation failure');
    // Ours, on the same step, and said to be excluded rather than counted as a loss.
    expect(newest?.[4]).toBe('Payment · excluded');
    expect(screen.getByText(/our own automation failing, not this site/i)).toBeTruthy();

    // Never folded into the two outcomes of the product under test: it is counted on its
    // own, and nobody in this run gave up.
    const counts = screen.getByRole('status').textContent ?? '';
    expect(counts).toContain('1 our own automation failing, excluded');
    expect(counts).toContain('0 gave up');
    expect(counts).toContain('1 failed');
  });

  it('times a session from the duration the artifact records, not from the clock', () => {
    const run = openRun({
      totalSessions: 12,
      perVariant: [{ variant: 'A', totalSessions: 12 }],
      sessions: [finished({ sessionId: 'S-01', durationMs: 161_000 })],
    });

    show(<RunningScreen run={run} />);

    expect(finishedRows()[0]?.[3]).toBe('2:41');
  });

  it('renders a run that has finished nobody as zeroed, and says nobody has landed', () => {
    show(<RunningScreen run={openRun({ sessions: [] })} />);

    expect(heading()).toBe('0 of 24 people have finished');
    expect(
      screen.getByRole('progressbar', { name: /overall/i }).getAttribute('aria-valuenow'),
    ).toBe('0');
    expect(screen.getByText(/Nobody has finished yet/i)).toBeTruthy();
    expect(finishedRows()).toEqual([]);
  });

  it('shows the start, and an estimate only once there is something to estimate from', () => {
    show(<RunningScreen run={openRun({ elapsed: 3 })} />);

    expect(screen.getByText(/started \d\d:\d\d/)).toBeTruthy();
    // Seventeen of twenty-four in three minutes: a little over a minute left, rounded.
    expect(screen.getByText(/about 1 minute left/)).toBeTruthy();
  });

  it('invents no estimate for a run that has finished nobody', () => {
    show(<RunningScreen run={openRun({ elapsed: 3, sessions: [] })} />);

    expect(screen.getByText(/started \d\d:\d\d/)).toBeTruthy();
    expect(screen.queryByText(/ left/)).toBeNull();
  });

  it('times nothing for a run that records no start', () => {
    const run = parse({
      ...seedJson(),
      status: 'open',
      progress: { totalSessions: 24, finishedSessions: 0, perVariant: [], sessions: [] },
    });

    show(<RunningScreen run={run} />);

    expect(screen.queryByText(/started /)).toBeNull();
    expect(heading()).toBe('0 of 24 people have finished');
  });

  it('states that the numbers are simulated, as every results screen does', () => {
    show(<RunningScreen run={openRun()} />);

    expect(screen.getByText(/not a conversion-lift estimate/i)).toBeTruthy();
  });
});

describe('the engine line', () => {
  it('reads “offline deterministic engine” when no model ran, with no cost beside it', () => {
    show(<RunningScreen run={openRun()} />);

    expect(screen.getByText(/offline deterministic engine/)).toBeTruthy();
    expect(screen.queryByText(/calls/)).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it('names the model and the mode the artifact recorded, with the calls and the cost', () => {
    show(<RunningScreen run={openRun({ engine: MODEL, usage: USAGE })} />);

    expect(screen.getByText(/Muse Spark 1\.3 · standard mode/)).toBeTruthy();
    expect(screen.getByText(/312 calls/)).toBeTruthy();
    expect(screen.getByText(/\$0\.42 so far/)).toBeTruthy();
  });

  it('shows the training sentence for a contributor test', () => {
    show(<RunningScreen run={openRun({ engine: CONTRIBUTOR, usage: USAGE })} />);

    expect(screen.getByText(/Muse Spark 1\.3 · contributor mode/)).toBeTruthy();
    const notice = screen.getByText(/train its models/);
    expect(notice.textContent).toContain('Meta');
    expect(notice.textContent).toMatch(/paying workspace/);
  });

  it('shows it for no other test: not for a standard one, not for an offline one', () => {
    const { unmount } = show(<RunningScreen run={openRun({ engine: MODEL, usage: USAGE })} />);
    expect(screen.queryByText(/train its models/)).toBeNull();
    unmount();

    show(<RunningScreen run={openRun()} />);
    expect(screen.queryByText(/train its models/)).toBeNull();
  });
});

describe('the buttons on the Running screen', () => {
  it('shows what there is so far on the Verdict, without leaving the test', async () => {
    await serveRunData();
    const { container } = show(<RunningScreen run={openRun()} />);

    await userEvent.click(screen.getByRole('button', { name: /Open the results so far/ }));

    await waitFor(() => {
      expect(container.querySelector('[data-section="headline"]')).not.toBeNull();
    });
    // The partial figures are labelled as partial, and the way back to the progress is on
    // the screen: the reader is still reading one open test. This is also what a stopped
    // test reads as — the people who had already finished (the owner's decision 50).
    expect(screen.getByText(/still running/i)).toBeTruthy();
    expect(screen.getByText(/the 17 of 24 people who have finished so far/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Back to progress/ }));
    expect(heading()).toBe('17 of 24 people have finished');
  });

  it('leaves Stop the test inert, and says in a title that it is not wired yet', () => {
    show(<RunningScreen run={openRun()} />);

    const stop = screen.getByRole('button', { name: /Stop the test/ });
    expect(stop.getAttribute('aria-disabled')).toBe('true');
    expect(stop.getAttribute('title')).toMatch(/not wired/i);
  });

  it('keeps the prototype’s line about what stopping does', () => {
    show(<RunningScreen run={openRun()} />);

    expect(
      screen.getByText(
        /Each person is saved as they finish; stopping keeps everyone who is already done\./,
      ),
    ).toBeTruthy();
  });
});

describe('the Test failed screen', () => {
  const FAILURE = {
    reason: 'The second URL could not be opened',
    detail:
      'playwright: net::ERR_CONNECTION_REFUSED at http://localhost:4173/checkout-b\nvariant A responded 200 in 38 ms — only B is unreachable',
  } as const;

  it('leads with what could not be opened, and that nobody was simulated', () => {
    show(<RunFailedScreen run={failedRun(FAILURE)} />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Test failed to start');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(FAILURE.reason);
    expect(screen.getByText(/Nobody was simulated and no result was saved\./)).toBeTruthy();
  });

  it('shows the captured detail verbatim', () => {
    show(<RunFailedScreen run={failedRun(FAILURE)} />);

    // Verbatim, its own line breaks included: what was captured is what is shown.
    expect(screen.getByText(/ERR_CONNECTION_REFUSED/).textContent).toBe(FAILURE.detail);
  });

  it('says that nothing was captured rather than drawing an empty block', () => {
    show(
      <RunFailedScreen run={failedRun({ reason: 'The browser would not start', detail: '' })} />,
    );

    expect(screen.getByText(/Nothing was captured/i)).toBeTruthy();
  });

  it('offers the three ways on, with the one that is not wired yet labelled as such', () => {
    show(<RunFailedScreen run={failedRun(FAILURE)} />);

    const again = screen.getByRole('button', { name: /Try again/ });
    expect(again.getAttribute('aria-disabled')).toBe('true');
    expect(again.getAttribute('title')).toMatch(/not wired/i);

    expect(screen.getByRole('link', { name: /Edit the test/ }).getAttribute('href')).toBe('/new');
    expect(screen.getByRole('link', { name: /Open the last good test/ }).getAttribute('href')).toBe(
      '/',
    );
  });

  it('lists the things to check', () => {
    show(<RunFailedScreen run={failedRun(FAILURE)} />);

    const checks = screen.getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(checks).toHaveLength(3);
    expect(checks[0]).toMatch(/reachable at that address/);
    expect(checks[2]).toMatch(/a comparison is only valid from one test/);
  });

  it('explains the offline engine when that is what ran', () => {
    show(<RunFailedScreen run={failedRun(FAILURE)} />);

    const notice = screen.getByText(/offline deterministic engine/);
    expect(notice.textContent).toMatch(/No model key is configured for this workspace/);
    expect(notice.textContent).toMatch(/terser than with a model/);
  });

  it('names the model a standard test could not use, and substitutes nothing for it', () => {
    show(<RunFailedScreen run={failedRun(FAILURE, { engine: MODEL })} />);

    const notice = screen.getByText(/Muse Spark 1\.3 · standard mode/);
    expect(notice.textContent).toMatch(/could not be used/);
    expect(notice.textContent).toMatch(/nobody was simulated/i);
    // The one thing this screen must never do (#144): report some other engine's result in
    // the place of the model that was asked for.
    expect(screen.queryByText(/offline deterministic engine/)).toBeNull();
    expect(screen.queryByText(/contributor/)).toBeNull();
  });

  it('names the contributor model the same way, and claims no result for it either', () => {
    show(<RunFailedScreen run={failedRun(FAILURE, { engine: CONTRIBUTOR })} />);

    expect(screen.getByText(/Muse Spark 1\.3 · contributor mode/)).toBeTruthy();
    expect(screen.queryByText(/train its models/)).toBeNull();
  });

  it('states something rather than nothing when a failed run carries no failure block', () => {
    // The contract refuses a failed run with no failure, so the run route never hands this
    // screen one; what it renders when handed one anyway is a statement, not a blank card.
    const run: Run = { ...failedRun(FAILURE), failure: undefined };
    show(<RunFailedScreen run={run} />);

    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/did not start/i);
    expect(screen.getByText(/Nobody was simulated and no result was saved\./)).toBeTruthy();
  });
});

describe('both screens', () => {
  it('each sit in one section the shell can find', () => {
    const { container, unmount } = show(<RunningScreen run={openRun()} />);
    expect(container.querySelector('[data-section="run-progress"]')).not.toBeNull();
    unmount();

    const failed = show(
      <RunFailedScreen run={failedRun({ reason: 'Nothing to open', detail: '' })} />,
    );
    expect(failed.container.querySelector('[data-section="run-failure"]')).not.toBeNull();
  });

  it('are neither of them for a run whose status the viewer does not know', async () => {
    // A status outside the contract's three is a run this viewer cannot read, not a state
    // to guess at: the route says so rather than rendering one of these two screens.
    await serveRunData({
      files: {
        [`/runs/${SEED}/run.json`]: JSON.stringify({ ...seedJson(), status: 'cancelled' }),
      },
    });
    mountApp(paths.run(SEED));

    expect(
      await screen.findByRole('heading', { name: 'That test could not be read' }),
    ).toBeTruthy();
    expect(screen.queryByText(/people finished/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Test failed to start' })).toBeNull();
  });
});
