// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { mountApp, serveRunData } from '../app';
import { stubVideoPlayback } from '../replay/harness';
import { paths } from '../../src/shell/paths';
import {
  CITED_STEP,
  DRAWN,
  forget,
  prose,
  RUN_ID,
  SCREENS,
  screenNamed,
  serveHundred,
  unrecordedSessions,
  VARIANT,
} from './fixture';
import type { ResultScreen } from './fixture';

/**
 * **Every results screen is labelled, and the tab bar is one bar.**
 *
 * Two promises of `docs/FLOW.md` section 8 are about the results page as a whole and are
 * therefore asserted here rather than six times over: *every screen states that the numbers
 * are simulated for the named audience*, and *no screen implies a conversion lift*. The
 * second is a **negative**, asserted over the rendered text of all six, so a screen added
 * later cannot quietly introduce one — which is the only way a promise of that shape can be
 * kept.
 *
 * The tab bar is the other cross-screen promise: five sections of section 14, the same bar
 * on each of them, the run kept as a reader moves across it, and *Score breakdown* only for
 * a run with two versions, because a run with one has nothing to compare.
 *
 * The third state the step's contract covers lives here too: **a run that recorded
 * nothing**. The owner's decision 74 is that the tab stays and the screen says what the
 * test recorded, so the five tabs are present over a run with no aggregate, no
 * recommendations and no videos, each screen states its own absence in words, and not one of
 * them draws a figure or a chart — which is what would read as a measurement somebody took.
 */

/** The bar every signed-in screen renders, by the labels it carries, in its own order. */
const tabBar = (): string[] =>
  [...document.querySelectorAll('[data-shell="tabbar"] a')].map((tab) => prose(tab.textContent));

/** The five sections of section 14, as the bar names them: the tabs about this test. */
const RUN_TABS = ['Summary', 'Attention', 'Sessions', 'Funnel & timing', 'Analysis'] as const;

/** The two tabs about the workspace, which `#tabbar` puts after the gap. */
const WORKSPACE_TABS = ['Sites', 'Audiences'] as const;

/** The screen one of those five tabs opens, where the bar's word differs from the screen's. */
const screenOfTab = (label: (typeof RUN_TABS)[number]): ResultScreen =>
  screenNamed(
    label === 'Attention' ? 'Heatmaps' : label === 'Funnel & timing' ? 'Funnel and timing' : label,
  );

/** What a screen reads with the simulated line taken out of it. */
const withoutTheDisclaimer = (container: HTMLElement): string => {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const line of copy.querySelectorAll('[data-shell="simulated-disclaimer"]')) line.remove();
  return prose(copy.textContent);
};

const barIsThere = async (): Promise<void> => {
  await waitFor(
    () => {
      expect(tabBar().length).toBeGreaterThan(0);
    },
    { timeout: 15_000 },
  );
};

beforeEach(() => {
  loadDesignTokens();
  stubVideoPlayback();
});
afterEach(forget);

describe('every one of the six says the numbers are simulated', () => {
  for (const one of SCREENS) {
    it(`carries the line and the badge on ${one.name}`, async () => {
      const { run } = await serveHundred();
      const { container } = mountApp(one.path(RUN_ID));
      await one.settled();

      // The closing line of `#screen-verdict`, naming the audience the figures are of.
      // The line reads the run through the shell's own read, which a screen that mounts it
      // late answers a tick after the screen itself has settled — so it is awaited rather
      // than read off the first paint.
      const line = (): string =>
        prose(container.querySelector('[data-shell="simulated-disclaimer"]')?.textContent);
      await waitFor(() => {
        expect(line(), one.name).toContain(run.audience.name);
      });
      expect(line(), one.name).toContain('is simulated, for the audience named at the top');

      // And the word in the chrome above it, wherever the reader is.
      const badge = prose(container.querySelector('[data-shell="simulated-badge"]')?.textContent);
      expect(badge, one.name).toContain('Simulated audience');
    }, 40_000);
  }
});

describe('no screen implies a conversion lift', () => {
  for (const one of SCREENS) {
    it(`says nothing about a lift anywhere on ${one.name}`, async () => {
      await serveHundred();
      const { container } = mountApp(one.path(RUN_ID));
      await one.settled();

      // The one sentence in the product that may use the words is the disclaimer, which
      // uses them to deny the claim; everything else on the screen is held to silence.
      expect(withoutTheDisclaimer(container), one.name).not.toMatch(/lift/iu);
      expect(withoutTheDisclaimer(container), one.name).not.toMatch(/conversion/iu);
      expect(
        prose(container.querySelector('[data-shell="simulated-disclaimer"]')?.textContent),
        one.name,
      ).toContain('it is not a conversion-lift estimate');
    }, 40_000);
  }
});

describe('the tab bar is one bar', () => {
  it('is the same bar, in the same shape, on every one of the six', async () => {
    await serveHundred();
    const shapes: string[][] = [];

    for (const one of SCREENS) {
      const mounted = mountApp(one.path(RUN_ID));
      await one.settled();
      shapes.push(tabBar());
      mounted.unmount();
    }

    expect(shapes[0]).toEqual([...RUN_TABS, ...WORKSPACE_TABS]);
    for (const [position, shape] of shapes.entries()) {
      expect(shape, SCREENS[position]?.name).toEqual(shapes[0]);
    }
  }, 90_000);

  it('keeps the run as a reader moves across the five sections', async () => {
    const { run } = await serveHundred();
    const mounted = mountApp(paths.run(RUN_ID));
    await screenNamed('Summary').settled();

    for (const label of RUN_TABS) {
      const tab = [...document.querySelectorAll<HTMLAnchorElement>('[data-shell="tabbar"] a')].find(
        (candidate) => prose(candidate.textContent) === label,
      );
      expect(tab, `the bar has no ${label} tab`).toBeDefined();
      await userEvent.click(tab as HTMLAnchorElement);

      // The same test, whichever of its sections is open: the path is inside this run and
      // the chrome still names it.
      await waitFor(() => {
        expect(mounted.router.state.location.pathname.startsWith(paths.run(RUN_ID))).toBe(true);
      });
      await waitFor(() => {
        expect(prose(document.querySelector('[data-shell="test-picker"]')?.textContent)).toContain(
          run.task.prompt,
        );
      });
      // And the tab the reader is on is the current one, said in a way a screen reader
      // reaches: one tab, not none and not two.
      const current = [
        ...document.querySelectorAll('[data-shell="tabbar"] a[aria-current="page"]'),
      ].map((tab2) => prose(tab2.textContent));
      expect(current, label).toHaveLength(1);
    }
  }, 90_000);

  it('carries Score breakdown only for a run with two versions', async () => {
    await serveHundred();
    mountApp(paths.run(RUN_ID));
    await screenNamed('Summary').settled();

    expect(tabBar()).not.toContain('Score breakdown');
    expect(tabBar()).toContain('Summary');
  }, 40_000);

  it('carries it, and leads with the Verdict, for the two-version run', async () => {
    // The repository's committed run compares two versions, which is the shape the bar adds
    // the tab for; it is served exactly as it is on disk.
    await serveRunData();
    mountApp(paths.run(RUN_ID));
    await barIsThere();

    await waitFor(() => {
      expect(tabBar()).toContain('Score breakdown');
    });
    expect(tabBar()).toEqual([
      'Verdict',
      'Score breakdown',
      'Attention',
      'Sessions',
      'Funnel & timing',
      'Analysis',
      ...WORKSPACE_TABS,
    ]);
  }, 40_000);
});

describe('a run that recorded nothing', () => {
  /** No aggregate, no recommendations, no recordings: the absence of decision 74. */
  const nothingRecorded = async () =>
    await serveHundred({
      aggregate: null,
      recommendations: null,
      sessions: unrecordedSessions(),
      videos: false,
    });

  for (const one of SCREENS) {
    it(`keeps all five tabs on ${one.name}`, async () => {
      await nothingRecorded();
      const { container } = mountApp(one.path(RUN_ID));
      await waitFor(
        () => {
          expect(prose(container.textContent)).not.toBe('');
        },
        { timeout: 15_000 },
      );
      await barIsThere();

      expect(tabBar(), one.name).toEqual([...RUN_TABS, ...WORKSPACE_TABS]);
    }, 40_000);
  }

  it('says what the test recorded on each of the five, and draws no chart', async () => {
    await nothingRecorded();

    const stated: Record<string, string> = {};
    for (const name of RUN_TABS) {
      const one = screenOfTab(name);
      const mounted = mountApp(one.path(RUN_ID));
      await waitFor(
        () => {
          expect(prose(mounted.container.textContent)).not.toBe('');
        },
        { timeout: 15_000 },
      );
      // Settling here is the absence arriving, not the figures: every file this screen
      // reads has answered 404 and the screen has said so.
      await waitFor(() => {
        expect(prose(mounted.container.textContent).length).toBeGreaterThan(DRAWN);
      });
      stated[name] = prose(mounted.container.textContent);

      // Not one of them draws a figure, a funnel or a claim: a chart over nothing and a
      // zero both read as a measurement somebody took (decision 74).
      expect(mounted.container.querySelector('[data-section="headline-figures"]'), name).toBeNull();
      expect(mounted.container.querySelector('[data-funnel="rows"]'), name).toBeNull();
      expect(mounted.container.querySelector('[data-part="claim"]'), name).toBeNull();
      expect(mounted.container.querySelector('[data-part="cites"]'), name).toBeNull();
      mounted.unmount();
    }

    // Each one says, in its own words, what this test did not record.
    expect(stated['Summary']).toContain('nothing recorded');
    expect(stated['Summary']).toContain('This test recommends nothing');
    expect(stated['Funnel & timing']).toContain('This test did not record a funnel');
    expect(stated['Analysis']).toContain('This test did not record an analysis');
    expect(stated['Attention']).toContain('This test computed no click or scroll-depth figures');
    // The Sessions screen has the people and none of their recordings, and says so in its
    // own heading: what it recorded, rather than a figure about it.
    expect(stated['Sessions']).toContain('100 people, 0 videos');
  }, 120_000);

  /**
   * A screen of this state once it has stopped arriving.
   *
   * The `settled()` of each of the six is written for a run that recorded everything, and
   * three of them wait for a block this state never draws — there is no funnel, no headline
   * figures and no write-up to wait for. So the wait here is the one this state has: the
   * words are read, and read again, until two macrotasks running back to back render the
   * same ones and nothing further is on its way.
   */
  const stopped = async (container: HTMLElement): Promise<void> => {
    let before = '';
    for (let step = 0; step < 200; step += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      const now = prose(container.textContent);
      if (now === before && now.length > DRAWN) return;
      before = now;
    }
    throw new Error('the screen never stopped arriving');
  };

  /**
   * Every leaf of a screen whose whole text is a zero — `0`, `0.0`, `0%` — with the block it
   * is in, named by its `data-section` or, for a control group, by its accessible name. A
   * leaf, because an ancestor's text is the concatenation of its children's and a row reading
   * `1.5 s 4 1 100%` would otherwise be read as holding no figure at all.
   */
  const zeroFigures = (container: HTMLElement): { where: string; words: string }[] => {
    const blocks = [
      ...container.querySelectorAll('[data-section], [role="toolbar"][aria-label], [role="group"]'),
    ];

    return [...container.querySelectorAll<HTMLElement>('*')]
      .filter((element) => element.querySelector('*') === null)
      .map((element) => ({ element, words: prose(element.textContent) }))
      .filter(({ words }) => /(?:^|[^\d.])0(?:\.0+)?\s?%?$/u.test(words))
      .map(({ element, words }) => ({
        words,
        where: blocks
          .filter((block) => block.contains(element))
          .map((block) => block.getAttribute('data-section') ?? block.getAttribute('aria-label'))
          .join('>'),
      }));
  };

  it('shows no zero in place of a figure it never computed', async () => {
    // Decision 74 again, as the negative: a zero where a figure would have gone reads as a
    // measurement somebody took, which over a run that recorded nothing is a number the
    // screen invented. Two kinds of block do print a zero over this run and **neither is
    // a figure about the test**:
    //
    // - the **areas of interest**, whose metrics are in `run.json` and record that nobody
    //   looked at three of them — an area nobody looked at is a finding, and the test
    //   below holds the table to printing exactly as many of those as the run records;
    // - a **filter's own tally**, which says how many rows that filter would leave and is
    //   counted off the session files this state does have, not off the missing aggregate.
    //
    // A zero anywhere else fails, which is what makes the promise hold for a screen or a
    // figure added later.
    const allowed = /^(?:heatmaps>areas-of-interest|Filter by .+)$/u;
    const seen: string[] = [];
    await nothingRecorded();

    for (const name of RUN_TABS) {
      const mounted = mountApp(screenOfTab(name).path(RUN_ID));
      await stopped(mounted.container);

      for (const zero of zeroFigures(mounted.container)) {
        expect(zero.where, `${name} prints “${zero.words}”`).toMatch(allowed);
        seen.push(`${name}: ${zero.where}`);
      }
      mounted.unmount();
      forget();
      await nothingRecorded();
    }

    // And the walk did find zeroes to judge: a `zeroFigures` that matched nothing at all
    // would pass this test over a page covered in them.
    expect(seen.length).toBeGreaterThan(0);
  }, 120_000);

  it('reads the areas table’s zeroes off the run’s own metrics', async () => {
    // And those zeroes are the run's, one for one: an area of this step whose metrics say
    // its `lookedAtShare` was zero is an area nobody looked at, which is a finding and not
    // an absence. The screen prints as many as the run records and not one more.
    const { run } = await nothingRecorded();
    const here = new Set(
      run.aois
        .filter((area) => area.variant === VARIANT && area.step === CITED_STEP)
        .map((area) => area.id),
    );
    const never = run.aoiMetrics.filter(
      (metric) => here.has(metric.aoiId) && metric.lookedAtShare === 0,
    );
    expect(never.length).toBeGreaterThan(0);

    const mounted = mountApp(screenOfTab('Attention').path(RUN_ID));
    await stopped(mounted.container);

    const table = mounted.container.querySelector<HTMLElement>(
      '[data-section="areas-of-interest"]',
    );
    expect(table).not.toBeNull();
    expect(
      zeroFigures(table as HTMLElement).filter((zero) => zero.words.endsWith('%')),
    ).toHaveLength(never.length);

    // The five figures of this step that the aggregate would have filled say so in words
    // instead, with no digit between them at all.
    const absent = prose(
      mounted.container.querySelector('[data-section="this-screen"]')?.textContent,
    );
    expect(absent).toContain('not computed');
    expect(absent).not.toMatch(/\d/u);
  }, 60_000);
});
