// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EVIDENCE_LINK_PARAMS } from '@personavision/contract';
import { loadDesignTokens } from './setup';
import { forgetRuns, mountApp, readRunFile, serveRunData } from './app';
import {
  funnelLink,
  heatmapLink,
  newTestStep,
  NEXT_PARAM,
  paths,
  patterns,
  RESULT_LINK_PARAMS,
  sessionAtSecond,
  sessionsLink,
} from '../src/shell/paths';
import type { SessionState } from '../src/shell/useSession';

/**
 * The route table of `docs/FLOW.md` sections 3 and 13, over the repository's own run
 * directories.
 *
 * What a test asserts here is what a reader sees and where a click lands — the rendered
 * words and the resulting path — never a component's internals.
 */

const SIGNED_OUT = { status: 'signed-out' } as const;

/** One run's own headline sentence, which is the heading of both `/` and `/demo`. */
const sentenceOf = (runId: string): string =>
  (readRunFile(runId) as unknown as { verdict: { audienceSentence: string } }).verdict
    .audienceSentence;

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('/ — the answer, with no clicks', () => {
  it('redirects a signed-in visitor to the Verdict of the most recent test', async () => {
    const { runIds } = await serveRunData();
    const { router } = mountApp(paths.home);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.run(runIds[0] as string));
    });
  });

  it('renders the Landing page for a visitor with no session, rather than sending them to sign in', async () => {
    await serveRunData();
    const { router } = mountApp(paths.home, { session: SIGNED_OUT });

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Know which version your customers can actually use',
    );
    expect(router.state.location.pathname).toBe(paths.home);
  });

  it('renders the No tests screen, with both of its actions, for a workspace with no test', async () => {
    await serveRunData({ runIds: [] });
    mountApp(paths.home);

    const heading = await screen.findByRole('heading', { name: 'No tests yet' });
    // Scoped to the screen itself: the chrome above it offers a New test button too.
    const card = within(heading.closest('.empty') as HTMLElement);

    expect(card.getByRole('link', { name: 'Open the example test' }).getAttribute('href')).toBe(
      paths.demo,
    );
    expect(card.getByRole('link', { name: 'New test' }).getAttribute('href')).toBe(paths.newTest);
    expect(card.getByText(/needs no API key and no network/)).toBeTruthy();
  });
});

describe('a signed-out visitor', () => {
  it('lands on /signin carrying the protected path they asked for', async () => {
    const { runIds } = await serveRunData();
    const intended = paths.breakdown(runIds[0] as string);
    const { router } = mountApp(intended, { session: SIGNED_OUT });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.signIn);
    });
    expect(new URLSearchParams(router.state.location.search).get(NEXT_PARAM)).toBe(intended);
  });

  it('reads /demo with no session at all', async () => {
    const { runIds } = await serveRunData();
    const { router } = mountApp(paths.demo, { session: SIGNED_OUT });

    // The demo is the committed example run's Verdict, so its heading is that run's own
    // sentence (#124). `DemoPage.test.tsx` is where the page itself is asserted.
    expect(
      await screen.findByRole('heading', { name: sentenceOf(runIds[0] as string) }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe(paths.demo);
    // No signed-in chrome on a public page: there is no workspace to name.
    expect(document.querySelector('[data-shell="chrome"]')).toBeNull();
  });

  it('lands on /signin from the two new results tabs, carrying the one it asked for', async () => {
    const { runIds } = await serveRunData();
    const runId = runIds[0] as string;

    for (const intended of [paths.funnel(runId), paths.analysis(runId)]) {
      const { router, unmount } = mountApp(intended, { session: SIGNED_OUT });
      await waitFor(() => {
        expect(router.state.location.pathname, intended).toBe(paths.signIn);
      });
      expect(new URLSearchParams(router.state.location.search).get(NEXT_PARAM)).toBe(intended);
      unmount();
    }
  });

  it('reads /signin itself', async () => {
    await serveRunData();
    mountApp(paths.signIn, { session: SIGNED_OUT });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });

  it('reads /signup with no session, outside the product chrome', async () => {
    await serveRunData();
    const { router } = mountApp(paths.signUp, { session: SIGNED_OUT });

    expect(await screen.findByRole('heading', { name: 'Create your workspace' })).toBeTruthy();
    expect(router.state.location.pathname).toBe(paths.signUp);
    // There is no workspace to name before one has been created (#265).
    expect(document.querySelector('[data-shell="chrome"]')).toBeNull();
  });

  it('lands on /signin from each of the onboarding screens, carrying the one it asked for', async () => {
    await serveRunData();

    for (const intended of [
      paths.sites,
      paths.newSite,
      paths.site('site-clipforge'),
      paths.githubSettings,
    ]) {
      const { router, unmount } = mountApp(intended, { session: SIGNED_OUT });
      await waitFor(() => {
        expect(router.state.location.pathname, intended).toBe(paths.signIn);
      });
      expect(new URLSearchParams(router.state.location.search).get(NEXT_PARAM)).toBe(intended);
      unmount();
    }
  });
});

describe('the two-URL A/B form cannot be filled in without an audience', () => {
  it('sends /new?step=variants to the audience screen when the workspace has none', async () => {
    await serveRunData({ runIds: [], audiences: [] });
    const { router } = mountApp(newTestStep('variants'), {
      audiences: { status: 'ready', audiences: [] },
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.audiences);
    });
  });

  it('renders the New test form once it has one', async () => {
    await serveRunData();
    const { router } = mountApp(newTestStep('variants'));

    expect(await screen.findByRole('heading', { name: 'New test' })).toBeTruthy();
    expect(router.state.location.pathname).toBe(paths.newTest);
  });

  it('opens /new itself on the path chooser, whatever the workspace has described', async () => {
    await serveRunData({ runIds: [], audiences: [] });
    const { router } = mountApp(paths.newTest, {
      audiences: { status: 'ready', audiences: [] },
    });

    // The wizard's second step is where an audience is described (`docs/FLOW.md` section
    // 12), so asking for one before the chooser would be a loop (#264).
    expect(
      await screen.findByRole('heading', { name: 'What would you like us to do?' }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe(paths.newTest);
  });
});

describe('an unknown test id', () => {
  it('renders a not-found state naming what was looked for, and nothing throws', async () => {
    await serveRunData();
    mountApp(paths.run('2026-01-01-0000-no-such-test'));

    expect(await screen.findByRole('heading', { name: 'No test with that id' })).toBeTruthy();
    expect(screen.getByText('2026-01-01-0000-no-such-test')).toBeTruthy();
    expect(screen.getByText('/runs/2026-01-01-0000-no-such-test/run.json')).toBeTruthy();
  });

  it('renders it inside the chrome, so the reader still has a way on', async () => {
    await serveRunData();
    mountApp(paths.run('2026-01-01-0000-no-such-test'));

    await screen.findByRole('heading', { name: 'No test with that id' });
    expect(document.querySelector('[data-shell="chrome"]')).not.toBeNull();
    expect(
      screen.getByRole('link', { name: 'Open the most recent test' }).getAttribute('href'),
    ).toBe(paths.home);
  });
});

describe('every screen of docs/FLOW.md sections 3 and 13 has a route', () => {
  it('resolves each one without falling through to the not-found page', async () => {
    const { runIds } = await serveRunData();
    const runId = runIds[0] as string;
    // The third entry is who is signed in, where it matters: since #103 a signed-in
    // reader is redirected away from `/signin`, so that route is checked signed out.
    const expected: [string, string | RegExp, SessionState?][] = [
      [paths.signIn, 'Sign in', { status: 'signed-out' }],
      // The demo is the example run's Verdict, so its heading is that run's sentence.
      [paths.demo, sentenceOf(runId)],
      // The audience screens are named for what they ask, not for the route (#109).
      [paths.audiences, 'Who does your business serve?'],
      [paths.newAudience, 'Describe your audience'],
      [paths.audience('aud-outdoor-gear-shoppers'), 'Outdoor-gear shoppers'],
      // The onboarding screens of section 13. The ones not built yet name the ticket that
      // fills them (#264); the wizard's steps are `tests/wizard/shell.test.tsx`. Sign-up is
      // checked signed out, as `/signin` is: since #265 a visitor who already has a
      // workspace is sent on rather than offered a second one.
      [paths.signUp, 'Create your workspace', { status: 'signed-out' }],
      [paths.sites, 'Your sites'],
      [paths.newSite, 'Add a site'],
      [paths.site('site-clipforge'), 'Prove this site is yours'],
      [paths.githubSettings, 'Where would the pull request go?'],
      // `/new` is one route with a step in the query: no step is the path chooser, and the
      // two-URL A/B form is the variants step.
      [paths.newTest, 'What would you like us to do?'],
      [newTestStep('variants'), 'New test'],
      [paths.breakdown(runId), 'How sure is this, and what drove it'],
      [paths.attention(runId, 'B', 'review'), 'Where your audience looked'],
      // Sessions opens on the grid of video thumbnails, whose heading is the people and
      // the recordings; the rows of `#screen-sessions` are `?view=rows` (#268).
      [paths.sessions(runId), /^\d+ (person|people)/],
      // The replay's heading names the person, not the screen: `S-01 · Rushed buyer · …`.
      [paths.session(runId, 'S-01'), /^S-01 · /],
      // The two tabs of section 14 this ticket mounts. Their headers are the prototype's;
      // what goes under each is #274's and #277's.
      [paths.funnel(runId), 'Where the hundred of them went'],
      [paths.analysis(runId), 'What Muse Wonder makes of it'],
    ];

    for (const [path, heading, session] of expected) {
      const { unmount } = mountApp(path, session === undefined ? {} : { session });
      expect(await screen.findByRole('heading', { name: heading }), path).toBeTruthy();
      unmount();
    }
  });

  it('mounts exactly the patterns the contract lists, and no others', () => {
    expect(Object.values(patterns)).toEqual([
      '/',
      '/signin',
      '/signup',
      '/demo',
      '/audiences',
      '/audiences/new',
      '/audiences/:audienceId',
      '/sites',
      '/sites/new',
      '/sites/:siteId',
      '/new',
      '/runs/:runId',
      '/runs/:runId/breakdown',
      '/runs/:runId/attention/:variant/:step',
      '/runs/:runId/sessions',
      '/runs/:runId/sessions/:sessionId',
      '/runs/:runId/funnel',
      '/runs/:runId/analysis',
      '/settings/github',
    ]);
  });

  it('says so, rather than throwing, for a URL it has no screen for', async () => {
    await serveRunData();
    mountApp('/not/a/screen');

    expect(await screen.findByRole('heading', { name: 'There is no page here' })).toBeTruthy();
    expect(screen.getByText('/not/a/screen')).toBeTruthy();
  });
});

describe('the citation link builders', () => {
  /** A run id, and one with a character that has to survive being put in a path. */
  const RUN = '2026-10-24-1402-northwind-demo';

  it('name only parameters a citation may carry, and between them name every one of them', () => {
    const named = Object.values(RESULT_LINK_PARAMS).flat();

    // The contract's own list, not a copy of it: a builder that invents a parameter name,
    // or a parameter no screen honours, fails here.
    for (const key of named) expect(EVIDENCE_LINK_PARAMS, key).toContain(key);
    expect([...new Set(named)].sort()).toEqual([...EVIDENCE_LINK_PARAMS].sort());
  });

  it('builds the funnel, by segment and for the whole audience', () => {
    expect(funnelLink(RUN)).toBe(`/runs/${RUN}/funnel`);
    expect(funnelLink(RUN, { segment: 'first-time' })).toBe(
      `/runs/${RUN}/funnel?segment=first-time`,
    );
    // A filter nobody asked for is absent rather than empty: `?segment=` narrows to nothing.
    expect(funnelLink(RUN, { segment: '' })).toBe(funnelLink(RUN));
  });

  it('builds the analysis, which takes no parameter', () => {
    expect(paths.analysis(RUN)).toBe(`/runs/${RUN}/analysis`);
  });

  it('builds a heatmap on its version and step, with any of its four filters', () => {
    expect(heatmapLink(RUN, 'B', 'waiting')).toBe(`/runs/${RUN}/attention/B/waiting`);
    expect(
      heatmapLink(RUN, 'B', 'waiting', {
        aoi: 'progress',
        overlay: 'attention',
        segment: 'phone',
        outcome: 'abandoned',
      }),
    ).toBe(
      `/runs/${RUN}/attention/B/waiting?aoi=progress&overlay=attention&segment=phone&outcome=abandoned`,
    );
  });

  it('builds a session at the second a citation reads, in seconds', () => {
    expect(sessionAtSecond(RUN, 'S-07', 48)).toBe(`/runs/${RUN}/sessions/S-07?t=48`);
    // `S-07 · 0:48.5`: a citation is sometimes written finer than a whole second.
    expect(sessionAtSecond(RUN, 'S-07', 48.5)).toBe(`/runs/${RUN}/sessions/S-07?t=48.5`);
    expect(sessionAtSecond(RUN, 'S-07', 0)).toBe(`/runs/${RUN}/sessions/S-07?t=0`);
  });

  it('builds a sessions list narrowed by any composition of its five', () => {
    expect(sessionsLink(RUN)).toBe(`/runs/${RUN}/sessions`);
    expect(sessionsLink(RUN, { outcome: 'failed' })).toBe(`/runs/${RUN}/sessions?outcome=failed`);
    expect(sessionsLink(RUN, { variant: 'A', segment: 'phone' })).toBe(
      `/runs/${RUN}/sessions?variant=A&segment=phone`,
    );
    expect(
      sessionsLink(RUN, {
        variant: 'A',
        step: 'waiting',
        aoi: 'progress',
        outcome: 'abandoned',
        segment: 'first-time',
      }),
    ).toBe(
      `/runs/${RUN}/sessions?variant=A&step=waiting&aoi=progress&outcome=abandoned&segment=first-time`,
    );
  });

  it('percent-encodes its values, and the browser’s own parsing gives back what went in', () => {
    const segment = 'first time & phone';
    const aoi = 'a/b?c=d#e';
    const url = new URL(sessionsLink(RUN, { variant: 'A', aoi, segment }), 'https://example.test');

    expect(url.pathname).toBe(`/runs/${RUN}/sessions`);
    expect(url.searchParams.get('variant')).toBe('A');
    expect(url.searchParams.get('aoi')).toBe(aoi);
    expect(url.searchParams.get('segment')).toBe(segment);
  });

  it('percent-encodes the ids it puts in the path, so one cannot climb out of it', () => {
    const url = new URL(sessionAtSecond('../../etc', 'S 7/8', 1), 'https://example.test');

    expect(url.pathname).toBe('/runs/..%2F..%2Fetc/sessions/S%207%2F8');
    expect(url.searchParams.get('t')).toBe('1');
  });
});
