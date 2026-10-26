// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from './setup';
import { forgetRuns, mountApp, serveRunData } from './app';
import { NEXT_PARAM, paths, patterns } from '../src/shell/paths';

/**
 * The route table of `docs/FLOW.md` section 3, over the repository's own run directories.
 *
 * What a test asserts here is what a reader sees and where a click lands — the rendered
 * words and the resulting path — never a component's internals.
 */

const SIGNED_OUT = { status: 'signed-out' } as const;

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

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('PersonaVision');
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
    await serveRunData();
    const { router } = mountApp(paths.demo, { session: SIGNED_OUT });

    expect(await screen.findByRole('heading', { name: 'Demo' })).toBeTruthy();
    expect(router.state.location.pathname).toBe(paths.demo);
    // No signed-in chrome on a public page: there is no workspace to name.
    expect(document.querySelector('[data-shell="chrome"]')).toBeNull();
  });

  it('reads /signin itself', async () => {
    await serveRunData();
    mountApp(paths.signIn, { session: SIGNED_OUT });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('a test cannot be run without an audience', () => {
  it('sends /new to the audience screen when the workspace has none', async () => {
    await serveRunData({ runIds: [] });
    const { router } = mountApp(paths.newTest, {
      audiences: { status: 'ready', audiences: [] },
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.newAudience);
    });
  });

  it('renders the New test screen once it has one', async () => {
    const { runIds } = await serveRunData();
    void runIds;
    const { router } = mountApp(paths.newTest);

    expect(await screen.findByRole('heading', { name: 'New test' })).toBeTruthy();
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

describe('every screen of docs/FLOW.md section 3 has a route', () => {
  it('resolves each one without falling through to the not-found page', async () => {
    const { runIds } = await serveRunData();
    const runId = runIds[0] as string;
    const expected: [string, string | RegExp][] = [
      [paths.signIn, 'Sign in'],
      [paths.demo, 'Demo'],
      [paths.audiences, 'Audiences'],
      [paths.newAudience, 'Audience'],
      [paths.audience('outdoor-gear-shoppers'), 'Audience'],
      [paths.newTest, 'New test'],
      [paths.breakdown(runId), 'Score breakdown'],
      [paths.attention(runId, 'B', 'review'), 'Attention'],
      [paths.sessions(runId), 'What happened to each person'],
      // The replay's heading names the person, not the screen: `S-01 · Rushed buyer · …`.
      [paths.session(runId, 'S-01'), /^S-01 · /],
    ];

    for (const [path, heading] of expected) {
      const { unmount } = mountApp(path);
      expect(await screen.findByRole('heading', { name: heading }), path).toBeTruthy();
      unmount();
    }
  });

  it('mounts exactly the patterns the contract lists, and no others', () => {
    expect(Object.values(patterns)).toEqual([
      '/',
      '/signin',
      '/demo',
      '/audiences',
      '/audiences/new',
      '/audiences/:audienceId',
      '/new',
      '/runs/:runId',
      '/runs/:runId/breakdown',
      '/runs/:runId/attention/:variant/:step',
      '/runs/:runId/sessions',
      '/runs/:runId/sessions/:sessionId',
    ]);
  });

  it('says so, rather than throwing, for a URL it has no screen for', async () => {
    await serveRunData();
    mountApp('/not/a/screen');

    expect(await screen.findByRole('heading', { name: 'There is no page here' })).toBeTruthy();
    expect(screen.getByText('/not/a/screen')).toBeTruthy();
  });
});
