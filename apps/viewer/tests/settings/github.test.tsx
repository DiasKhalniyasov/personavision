// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../setup';
import { axeViolations, describeViolations } from '../axe';
import { forgetRuns, mountApp } from '../app';
import { CONNECTED_REPOSITORY, serveConnection } from './fixture';
import { newTestStep, paths } from '../../src/shell/paths';
import { forgetGithubConnection } from '../../src/screens/settings/connection';

/**
 * `/settings/github` — where would the pull request go?
 *
 * The entry point of path 2 and nothing more: `docs/FLOW.md` sections 13 and 15. What is
 * asserted is the four things it has to state — what connecting does, what the app may do,
 * that it never merges, and what a connection is worth for the site the repository deploys —
 * and then that every state the platform can answer is said in words a user can act on,
 * with no control that leads nowhere.
 */

const open = async () => {
  const mounted = mountApp(paths.githubSettings);
  await screen.findByRole('heading', { level: 1, name: 'Where would the pull request go?' });
  return mounted;
};

/** Where this workspace stands, which is the one box that changes between states. */
const standing = (): HTMLElement => screen.getByRole('status');

beforeEach(loadDesignTokens);
afterEach(() => {
  forgetRuns();
  forgetGithubConnection();
});

describe('what the screen states', () => {
  it('asks section 13’s question, in the narrow column', async () => {
    await serveConnection();
    const { container } = await open();

    const main = container.querySelector('main') as HTMLElement;
    expect(main.querySelector('.wrap-narrow')).not.toBeNull();
    expect([...main.querySelectorAll('[style]')]).toHaveLength(0);
  });

  it('says what connecting does, in the owner’s words', async () => {
    await serveConnection();
    await open();

    expect(
      screen.getByText(
        'Connect a GitHub repository and PersonaVision can write the change and open the pull request for you. It never merges: you do.',
      ),
    ).toBeTruthy();
  });

  it('says what the app would be allowed to do, and that it never merges', async () => {
    await serveConnection();
    const { container } = await open();

    const allowed = within(container.querySelector('.card') as HTMLElement)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(allowed).toEqual([
      'One repository — the one you install the app on, and no other.',
      'Read that repository, and open and update pull requests on it.',
      'It never merges anything. You merge.',
    ]);
  });

  it('says the connection counts as verification for the site the repository deploys', async () => {
    await serveConnection();
    await open();

    expect(
      screen.getByText(
        'A connected repository also counts as proof that you control the site it deploys. That unlocks this path, and takes that site from 3 agents a run to the full 100.',
      ),
    ).toBeTruthy();
  });
});

describe('while no GitHub App is registered', () => {
  it('says so, and names the path that needs nothing from GitHub', async () => {
    await serveConnection({ registered: false });
    await open();

    await waitFor(() => {
      expect(standing().textContent).toContain(
        'PersonaVision’s GitHub App is not registered yet, so there is no repository to connect today.',
      );
    });
    expect(standing().textContent).toContain(
      'Test my site needs nothing from GitHub: start a test there, and this path unlocks once the app is live.',
    );
  });

  it('offers no button that leads nowhere', async () => {
    await serveConnection({ registered: false });
    const { container, router } = await open();
    await waitFor(() => {
      expect(standing().textContent).toContain('not registered yet');
    });

    const main = container.querySelector('main') as HTMLElement;
    // Nothing on the screen is a control that refuses the press it invites.
    expect(main.querySelectorAll('[aria-disabled]')).toHaveLength(0);
    expect(main.querySelectorAll('button:disabled')).toHaveLength(0);
    // Its one control is a link to a screen that exists, and it goes there.
    const control = within(standing()).getByRole('link', { name: 'Start a test' });
    expect(control.getAttribute('href')).toBe(newTestStep('path'));
    await userEvent.click(control);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.newTest);
    });
  });
});

describe('the other states the platform can answer', () => {
  it('says the connection is being read, in the box the answer lands in', async () => {
    const served = await serveConnection({ hold: true, registered: true, repository: null });
    await open();

    expect(standing().textContent).toContain('Checking whether this workspace has a connected');
    served.release();
    await waitFor(() => {
      expect(standing().textContent).toContain('No repository is connected to this workspace yet.');
    });
  });

  it('says a workspace with the app and no repository has none', async () => {
    await serveConnection({ registered: true, repository: null });
    await open();

    await waitFor(() => {
      expect(standing().textContent).toBe(
        'No repository is connected to this workspace yet. When the app is installed on one, it is named here.',
      );
    });
  });

  it('names the repository a connected workspace would open the pull request on', async () => {
    await serveConnection({ registered: true, repository: CONNECTED_REPOSITORY });
    await open();

    await waitFor(() => {
      expect(standing().textContent).toBe(
        `Connected to ${CONNECTED_REPOSITORY}. Pull requests go there, and the site that repository deploys counts as verified.`,
      );
    });
  });

  it('says what failed when the connection cannot be read', async () => {
    await serveConnection({ answers: { status: 503, body: { error: 'The store is not open.' } } });
    await open();

    await waitFor(() => {
      expect(standing().textContent).toContain(
        'This workspace’s GitHub connection could not be checked, so this path stays locked.',
      );
    });
    expect(standing().textContent).toContain('The store is not open.');
  });
});

describe('the screen is operable and announced', () => {
  it('passes axe in every state the platform can answer', async () => {
    for (const behaviour of [
      { hold: true },
      {},
      { registered: true, repository: null },
      { registered: true, repository: CONNECTED_REPOSITORY },
      { unreachable: true },
    ]) {
      await serveConnection(behaviour);
      const { container, unmount } = await open();
      if (behaviour.hold !== true) {
        await waitFor(() => {
          expect(standing().textContent).not.toContain('Checking whether');
        });
      }
      const violations = await axeViolations(container.querySelector('main') as HTMLElement);
      expect(
        violations,
        `${JSON.stringify(behaviour)}\n${describeViolations(violations)}`,
      ).toHaveLength(0);
      unmount();
      forgetRuns();
      forgetGithubConnection();
    }
  });

  it('is complete and still on first paint under prefers-reduced-motion: reduce', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string): MediaQueryList =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    await serveConnection({ registered: true, repository: null });
    const { container } = await open();

    expect(
      within(container.querySelector('.card') as HTMLElement).getAllByRole('listitem'),
    ).toHaveLength(3);
    expect(standing()).toBeTruthy();
  });
});
