// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEATMAP_OVERLAYS } from '@personavision/contract';
import type { Citation, Run, Session } from '@personavision/contract';
import { loadDesignTokens } from '../setup';
import { mountApp } from '../app';
import { stage, stubVideoPlayback } from '../replay/harness';
import { citationLink } from '../../src/screens/summary/Citations';
import { paths } from '../../src/shell/paths';
import {
  forget,
  prose,
  RECOMMENDATIONS,
  RUN_ID,
  screenAt,
  screenNamed,
  SCREENS,
  serveHundred,
  serveWhole,
} from './fixture';

/**
 * **Every citation resolves, end to end.**
 *
 * The step's six screens each prove their own screen. This suite proves they are one
 * results page: that a recommendation's evidence, followed from the screen a reader is on,
 * lands on the screen, the second and the filters the citation named — and that the same
 * walk made from the Analysis lands in the same places.
 *
 * Nothing here reads a component's internals. Each citation is **clicked**, as a reader
 * clicks it, and what is asserted afterwards is the `href` the chip carried and the state
 * the screen it led to is in: the player's time, the overlay pressed, the area isolated,
 * the funnel row marked. A citation that lands on the wrong screen, the wrong second or an
 * unfiltered screen fails here (`docs/FLOW.md` section 14).
 *
 * The run is the shared hundred-session fixture of `fixture.tsx`, served the way the app
 * serves a run.
 */

/**
 * How close the player has to be to the second a citation named, as `toBeCloseTo`'s digits:
 * one, so within a twentieth of a second. It is the tolerance `replay/video.test.tsx` holds
 * the player's own seek to.
 */
const DIGITS = 1;

/** The query of one link, parsed, so a landing is asserted against what the link asked for. */
const askedFor = (href: string): { pathname: string; query: URLSearchParams } => {
  const asked = new URL(href, 'https://personavision.test');
  return { pathname: asked.pathname, query: asked.searchParams };
};

/** Which of the three evidence screens a link leads to, read off the link and not guessed. */
const destinationOf = (href: string): 'replay' | 'heatmap' | 'funnel' => {
  const { pathname } = askedFor(href);
  if (pathname.startsWith(`${paths.sessions(RUN_ID)}/`)) return 'replay';
  if (pathname.startsWith(`/runs/${RUN_ID}/attention/`)) return 'heatmap';
  if (pathname === paths.funnel(RUN_ID)) return 'funnel';
  throw new Error(`${href} leads to no evidence screen of this results page`);
};

/**
 * The replay, **paused on the second the citation named**.
 *
 * Three things together are what "paused on that second" means on this screen: the player's
 * own `currentTime`, the screen of the timeline that second falls in, and a Play button —
 * a replay that opened playing would be a reader chasing the frame they were sent to.
 *
 * The timeline screen is asserted **by index**, against the screen the cited session's own
 * file puts that second in. One card is always the active one, so a test that only asked
 * whether *some* card was active would pass at nought seconds and on any wrong second too.
 */
const landedOnReplay = async (href: string, sessions: readonly Session[]): Promise<void> => {
  const { pathname, query } = askedFor(href);
  await screenNamed('Session replay').settled();

  const seconds = Number(query.get('t'));
  expect(Number.isFinite(seconds), `${href} carries no second`).toBe(true);

  await waitFor(() => {
    expect(stage().currentTime).toBeCloseTo(seconds, DIGITS);
  });

  // It is this person's replay: the id the citation named heads the screen.
  const sessionId = pathname.split('/').pop() ?? '';
  expect(prose(document.querySelector('h1')?.textContent)).toContain(sessionId);

  // And the timeline is on the screen that second falls in, that one and no other.
  const person = sessions.find((candidate) => candidate.sessionId === sessionId);
  expect(person, `${sessionId} is not of this run`).toBeDefined();
  const wanted = screenAt(person as Session, seconds * 1000);
  await waitFor(() => {
    const active = [...document.querySelectorAll('[data-screen-card][data-active="true"]')].map(
      (card) => Number(card.getAttribute('data-screen-card')),
    );
    expect(active, `${href} is showing screens ${active.join(', ')}`).toEqual([wanted]);
  });

  // The recording is not running.
  expect(screen.getByRole('button', { name: 'Play the recording' })).toBeTruthy();
};

/**
 * The heatmap of the version and step cited, **with the filters the citation named applied**.
 *
 * The overlay is the one the link asked for and the other two are off, because a strip of
 * three whose off looks like its on is no filter at all; the area, where one was cited, is
 * the isolated one, named under the stage in the reader's own words.
 */
const landedOnHeatmap = async (href: string, run: Run): Promise<void> => {
  const { pathname, query } = askedFor(href);
  await screenNamed('Heatmaps').settled();

  // The variant and the step are in the path, and the screen is on them: the filmstrip has
  // the cited step pressed and every other step of the run unpressed. Asserted off the
  // screen rather than off the link, because a route that ignored its own parameters would
  // answer the link with the first step of the run and the URL would still read correctly.
  const [variant, step] = pathname.split('/').slice(-2);
  expect(run.variants.some((candidate) => candidate.id === variant)).toBe(true);
  const strip = document.querySelector('[data-section="step-filmstrip"]');
  expect(strip, 'the heatmap screen has no filmstrip').not.toBeNull();
  expect(
    [...(strip?.querySelectorAll('[data-step][aria-pressed="true"]') ?? [])].map((frame) =>
      frame.getAttribute('data-step'),
    ),
  ).toEqual([step]);

  const overlay = query.get('overlay');
  expect(overlay, `${href} names no overlay`).not.toBeNull();
  for (const one of HEATMAP_OVERLAYS) {
    const button = document.querySelector(`[data-overlay="${one}"]`);
    expect(button, `the strip has no ${one} button`).not.toBeNull();
    expect(button?.getAttribute('aria-pressed'), `${one} on ${href}`).toBe(String(one === overlay));
  }

  const aoi = query.get('aoi');
  const caption = (): string => prose(document.querySelector('#att-caption')?.textContent);
  if (aoi === null) {
    // Nothing isolated: the heatmap of the whole step, which is what a region-less citation
    // cites. The screen says so by leaving its isolate caption empty.
    expect(caption()).toBe('');
  } else {
    const area = run.aois.find((candidate) => candidate.id === aoi);
    expect(area, `${aoi} is not an area of this run`).toBeDefined();
    // The caption is withheld until this step's people have arrived, because it counts
    // their fixations: the area is isolated once it names itself.
    await waitFor(() => {
      expect(caption()).toContain(area?.label ?? aoi);
    });
    // And the link was not quietly answered with the unfiltered screen.
    expect(document.querySelector('[data-section="attention-fallback"]')).toBeNull();
  }
};

/** The funnel, with the cited step marked — in the funnel itself and in the timing table. */
const landedOnFunnel = async (href: string, run: Run): Promise<void> => {
  const { query } = askedFor(href);
  await screenNamed('Funnel and timing').settled();

  const step = query.get('step');
  expect(step, `${href} names no step`).not.toBeNull();
  expect(run.steps.some((candidate) => candidate.id === step)).toBe(true);

  await waitFor(() => {
    const marked = [
      ...document.querySelectorAll('[data-funnel] [data-step][aria-current="step"]'),
    ].map((row) => row.getAttribute('data-step'));
    // Marked, and marked nowhere else: a funnel with two steps marked answers no citation.
    expect([...new Set(marked)]).toEqual([step]);
  });
};

/** The run as it was served, which is what every landing above is asserted against. */
interface Served {
  readonly run: Run;
  readonly sessions: readonly Session[];
}

/** Wherever a link leads, the screen it led to is in the state the link asked for. */
const landedOn = async (href: string, served: Served): Promise<void> => {
  switch (destinationOf(href)) {
    case 'replay':
      return await landedOnReplay(href, served.sessions);
    case 'heatmap':
      return await landedOnHeatmap(href, served.run);
    case 'funnel':
      return await landedOnFunnel(href, served.run);
  }
};

/** Every citation chip on the screen as it is now, in page order. */
const chips = (): HTMLAnchorElement[] => [
  ...document.querySelectorAll<HTMLAnchorElement>('[data-part="cites"] a'),
];

const hrefsOn = (): string[] => chips().map((chip) => chip.getAttribute('href') ?? '');

/**
 * One citation followed from one of the two screens that cite: the chip is clicked and the
 * screen it leads to is asserted, then the walk is closed so the next one starts clean.
 */
const follow = async (
  from: 'Summary' | 'Analysis',
  href: string,
  served: Served,
): Promise<void> => {
  const source = screenNamed(from);
  const mounted = mountApp(source.path(RUN_ID));
  await source.settled();

  const chip = chips().find((candidate) => candidate.getAttribute('href') === href);
  expect(chip, `no citation on the ${from} links to ${href}`).toBeDefined();
  await userEvent.click(chip as HTMLAnchorElement);

  await landedOn(href, served);
  expect(mounted.router.state.location.pathname + mounted.router.state.location.search).toBe(href);
  mounted.unmount();
};

/** Every citation of every recommendation in the fixture, in rank order. */
const everyCitation = (): Citation[] =>
  RECOMMENDATIONS.flatMap((recommendation) => [...recommendation.citations]);

beforeEach(() => {
  loadDesignTokens();
  stubVideoPlayback();
});
afterEach(forget);

describe('the Summary cites what a reader can check', () => {
  it('renders one chip per citation, each the URL that citation’s own fields build', async () => {
    const { run } = await serveHundred();
    mountApp(paths.run(RUN_ID));
    await screenNamed('Summary').settled();

    // In the file's own order, and one chip per citation: a recommendation whose evidence
    // is dropped on the way to the screen is evidence a reader cannot check.
    expect(hrefsOn()).toEqual(everyCitation().map((citation) => citationLink(run, citation).to));
  }, 40_000);
});

describe('every citation of the Summary resolves', () => {
  for (const [position, citation] of everyCitation().entries()) {
    it(`follows citation ${String(position + 1)} (${citation.kind}) onto its own screen`, async () => {
      const served = await serveHundred();
      await follow('Summary', citationLink(served.run, citation).to, served);
    }, 40_000);
  }
});

describe('the same walk from the Analysis resolves identically', () => {
  it('cites only what the claims carry, and every chip is a citation’s own URL', async () => {
    const { run, recommendations } = await serveWhole();
    mountApp(paths.analysis(RUN_ID));
    await screenNamed('Analysis').settled();

    const allowed = new Set(
      (recommendations.writeUp ?? [])
        .flatMap((claim) => [...claim.citations])
        .map((citation) => citationLink(run, citation).to),
    );
    expect(hrefsOn().length).toBeGreaterThan(0);
    for (const href of hrefsOn()) expect(allowed.has(href), href).toBe(true);
  }, 40_000);

  it('lands each of its citations on the same screen, second and filters', async () => {
    const served = await serveHundred();
    const reading = mountApp(paths.analysis(RUN_ID));
    await screenNamed('Analysis').settled();
    const walk = [...new Set(hrefsOn())];
    expect(walk.length).toBeGreaterThan(0);
    // The walk is read off the screen and then the screen is closed, so each citation below
    // is followed from a screen of its own rather than from a copy left behind.
    reading.unmount();

    for (const href of walk) await follow('Analysis', href, served);
  }, 120_000);
});

describe('the run is read over the mount the app uses', () => {
  it('asks only for files of the run directory, and computes nothing on the server', async () => {
    const served = await serveHundred();
    const { sessions } = served;

    // The whole walk, so every read any of the six makes is in the list.
    for (const one of SCREENS) {
      const mounted = mountApp(one.path(RUN_ID));
      await one.settled();
      mounted.unmount();
    }

    // The read-only run-data interface of `docs/adr/0001`: the on-disk layout mirrored.
    // Nothing is filtered, aggregated or sorted by the server, so no request carries a
    // query and no path is anything but a file of this run directory or the workspace's
    // own listing.
    const ids = sessions.map((session) => session.sessionId).join('|');
    const allowed = new RegExp(
      `^(/audiences(/[^/]+)?|/runs/index\\.json|/runs/${RUN_ID}/(run|findings|aggregate|recommendations)\\.json|/runs/${RUN_ID}/sessions/(${ids})\\.json)$`,
      'u',
    );
    expect(served.requests.length).toBeGreaterThan(0);
    for (const path of served.requests) expect(path, path).toMatch(allowed);

    // And the recordings, read off the same mount by the same rule: a `HEAD` for the size
    // the outcome card prints, and the file itself as the stage plays it.
    for (const asked of served.videoRequests) {
      expect(asked.path, asked.path).toMatch(
        new RegExp(`^/runs/${RUN_ID}/videos/(${ids})\\.webm$`, 'u'),
      );
    }
  }, 120_000);
});

describe('an unreadable run directory', () => {
  for (const one of SCREENS) {
    it(`lands on the run-not-found screen from ${one.name}`, async () => {
      // A run directory this workspace cannot read: every one of the six routes reads the
      // run through the shell's one read, so every one of them falls to the same screen
      // rather than each inventing an error state of its own.
      await serveHundred();
      const { container } = mountApp(one.path('2026-01-01-0000-no-such-test'));

      expect(
        await screen.findByRole('heading', { name: 'No test with that id' }, { timeout: 15_000 }),
      ).toBeTruthy();
      expect(container.querySelector('[data-part="cites"]')).toBeNull();
    }, 40_000);
  }
});
