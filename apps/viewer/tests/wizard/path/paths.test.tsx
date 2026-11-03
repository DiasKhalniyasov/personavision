// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../../setup';
import { axeViolations, describeViolations } from '../../axe';
import { forgetRuns, mountApp } from '../../app';
import { CONNECTED_REPOSITORY, serveConnection } from '../../settings/fixture';
import { newTestStep, paths, STEP_PARAM } from '../../../src/shell/paths';
import {
  forgetGithubConnection,
  useGithubConnection,
} from '../../../src/screens/settings/connection';
import {
  forgetWizardDraft,
  readWizardDraft,
  writeWizardDraft,
} from '../../../src/screens/newtest/wizard/draft';
import type { WizardDraft } from '../../../src/screens/newtest/wizard/draft';

/**
 * `/new?step=path` — the two paths, and the locked one.
 *
 * `#screen-newtest-paths` of `docs/design/prototype.html` and `docs/FLOW.md` section 11.
 * What is asserted is what a reader can see and do: the two cards in the prototype's order
 * and wording, what path 1 delivers and where it goes, and that path 2 is **shown and
 * locked** in every state but a connection — never hidden, never a control that does
 * nothing, with its reason announced beside it.
 */

const card = (name: RegExp): HTMLElement => screen.getByRole('group', { name }) as HTMLElement;

const pathOne = (): HTMLElement => card(/^Test my site$/);
const pathTwo = (): HTMLElement => card(/^Improve my site/);

/** The lock's reason, which the card points `aria-describedby` at. */
const reasonOf = (group: HTMLElement): HTMLElement => {
  const id = group.getAttribute('aria-describedby') ?? '';
  return document.getElementById(id) as HTMLElement;
};

const open = async (address: string = newTestStep('path')) => {
  const mounted = mountApp(address);
  await screen.findByRole('heading', { level: 1, name: 'What would you like us to do?' });
  return mounted;
};

/** A draft part-way through, to show that choosing a path keeps what was typed. */
const startedDraft = (): WizardDraft => ({
  site: { id: 'site-clipforge', url: 'https://app.clipforge.example/create' },
  feature: 'generating a video from a prompt',
  audience: null,
  goal: null,
});

beforeEach(loadDesignTokens);
afterEach(() => {
  forgetRuns();
  forgetWizardDraft();
  forgetGithubConnection();
});

describe('the two paths', () => {
  it('asks the prototype’s question, in its words', async () => {
    await serveConnection();
    await open();

    expect(
      screen.getByText(/^Both paths put a hundred simulated people through your site\./),
    ).toBeTruthy();
  });

  it('draws both cards, in the prototype’s order and wording', async () => {
    await serveConnection();
    const { container } = await open();

    const groups = [...container.querySelectorAll('[role="group"]')];
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toContain('Path 1');
    expect(groups[0]?.textContent).toContain('Test my site');
    expect(groups[1]?.textContent).toContain('Path 2');
    expect(groups[1]?.textContent).toContain('Improve my site');

    expect(
      within(pathOne()).getByText('A URL and the feature you want tested, in your own words.'),
    ).toBeTruthy();
    expect(
      within(pathTwo()).getByText('Everything in path 1, and then the change itself.'),
    ).toBeTruthy();
  });

  it('lists the three things path 1 delivers', async () => {
    await serveConnection();
    await open();

    expect(
      within(pathOne())
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Up to 100 people attempt the feature, each recorded on video',
      'Completion, time, where they gave up, click and attention heatmaps',
      'Ranked recommendations, each citing the session and the second it happened',
    ]);
  });

  it('lists the three things path 2 adds', async () => {
    await serveConnection();
    await open();

    expect(
      within(pathTwo())
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'One targeted change, written as a pull request on your repository',
      'The same audience and the same seeds on the before and the after, plus a holdout set',
      'The before/after verdict, on the platform and as a comment on the pull request',
    ]);
  });
});

describe('path 1 goes to the audience-and-feature step, carrying the draft', () => {
  it('links to the next step of this wizard', async () => {
    await serveConnection();
    await open();

    const control = within(pathOne()).getByRole('link', { name: 'Start here' });
    expect(control.getAttribute('href')).toBe(newTestStep('audience'));
  });

  it('keeps what the draft already holds when it is followed', async () => {
    await serveConnection();
    writeWizardDraft(startedDraft());
    const { router } = await open();

    await userEvent.click(within(pathOne()).getByRole('link', { name: 'Start here' }));

    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get(STEP_PARAM)).toBe('audience');
    });
    expect(readWizardDraft()).toEqual(startedDraft());
  });
});

describe('path 2 is shown and locked', () => {
  it('locks the card, with its reason beside the lock and announced with it', async () => {
    await serveConnection({ registered: true, repository: null });
    await open();

    await waitFor(() => {
      expect(pathTwo().getAttribute('data-locked')).not.toBeNull();
    });
    const group = pathTwo();
    expect(group.getAttribute('aria-disabled')).toBe('true');
    expect(reasonOf(group).textContent).toBe(
      'Connect a GitHub repository and PersonaVision can write the change and open the pull request for you. It never merges: you do.',
    );
    expect(group.querySelector('h2')?.textContent).toBe('Improve my site · locked');
  });

  it('leaves its one control operable, not announced as disabled with the card', async () => {
    await serveConnection({ registered: true, repository: null });
    const { router } = await open();
    await waitFor(() => {
      expect(pathTwo().getAttribute('aria-disabled')).toBe('true');
    });

    // A container's `aria-disabled` is inherited by its focusable descendants, so the one
    // control the locked card exists for takes it back: the lock is the card, not the way out.
    const control = within(pathTwo()).getByRole('link', { name: 'Connect GitHub' });
    expect(control.getAttribute('aria-disabled')).toBe('false');
    await userEvent.click(control);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.githubSettings);
    });
  });

  it('does not trap focus: the card itself is not a stop, and its one control is', async () => {
    await serveConnection({ registered: true, repository: null });
    await open();
    await waitFor(() => {
      expect(pathTwo().getAttribute('data-locked')).not.toBeNull();
    });

    const group = pathTwo();
    expect(group.getAttribute('tabindex')).toBeNull();
    group.focus();
    expect(document.activeElement).not.toBe(group);

    const control = within(group).getByRole('link', { name: 'Connect GitHub' });
    control.focus();
    expect(document.activeElement).toBe(control);
    await userEvent.tab();
    expect(document.activeElement).not.toBe(control);
  });

  it('is never hidden, whatever the platform answers', async () => {
    for (const behaviour of [
      {},
      { registered: true, repository: null },
      { registered: true, repository: CONNECTED_REPOSITORY },
      { unreachable: true },
      { answers: { status: 200, text: '<!doctype html><title>the app</title>' } },
    ]) {
      await serveConnection(behaviour);
      const { unmount } = await open();
      await waitFor(() => {
        expect(within(pathTwo()).getByRole('link'), JSON.stringify(behaviour)).toBeTruthy();
      });
      expect(pathTwo().textContent, JSON.stringify(behaviour)).toContain('Improve my site');
      unmount();
      forgetRuns();
      forgetGithubConnection();
    }
  });

  it('sends its one control to the GitHub connection screen', async () => {
    await serveConnection({ registered: true, repository: null });
    const { router } = await open();

    const control = within(pathTwo()).getByRole('link', { name: 'Connect GitHub' });
    expect(control.getAttribute('href')).toBe(paths.githubSettings);
    await userEvent.click(control);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.githubSettings);
    });
  });

  it('stays locked, and says why, when the connection cannot be read', async () => {
    await serveConnection({ unreachable: true });
    await open();

    await waitFor(() => {
      expect(reasonOf(pathTwo()).textContent).toBe(
        'This workspace’s GitHub connection could not be checked, so this path stays locked.',
      );
    });
    expect(pathTwo().getAttribute('aria-disabled')).toBe('true');
  });

  it('stays locked when the platform has no such route yet', async () => {
    await serveConnection({
      answers: { status: 200, text: '<!doctype html><title>the app</title>' },
    });
    await open();

    await waitFor(() => {
      expect(pathTwo().textContent).toContain('could not be checked');
    });
    expect(pathTwo().getAttribute('data-locked')).not.toBeNull();
  });
});

describe('the loading state', () => {
  it('draws both cards with their text and the lock while the state is read', async () => {
    const served = await serveConnection({ hold: true, registered: true, repository: null });
    const { container } = await open();

    expect(within(pathOne()).getAllByRole('listitem')).toHaveLength(3);
    const locked = pathTwo();
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    expect(reasonOf(locked).textContent).toContain('Connect a GitHub repository');

    // The shape of the card is the shape it keeps: the box holding the lock's reason is the
    // same box that holds the repository, so nothing moves when the answer arrives.
    const before = [...container.querySelectorAll('[role="group"]')].map(
      (group) => group.children.length,
    );
    served.release();
    await waitFor(() => {
      expect(served.reads()).toBe(1);
    });
    await waitFor(() => {
      expect(
        [...container.querySelectorAll('[role="group"]')].map((group) => group.children.length),
      ).toEqual(before);
    });
  });

  it('does not move the lock when a connection arrives', async () => {
    const served = await serveConnection({
      hold: true,
      registered: true,
      repository: CONNECTED_REPOSITORY,
    });
    await open();

    const slots = (): string[] => [...pathTwo().children].map((child) => child.tagName);
    const before = slots();
    served.release();
    await waitFor(() => {
      expect(pathTwo().textContent).toContain(CONNECTED_REPOSITORY);
    });
    expect(slots()).toEqual(before);
  });
});

describe('a connected repository', () => {
  it('unlocks the card and names the repository', async () => {
    await serveConnection({ registered: true, repository: CONNECTED_REPOSITORY });
    await open();

    await waitFor(() => {
      expect(pathTwo().textContent).toContain(CONNECTED_REPOSITORY);
    });
    const group = pathTwo();
    expect(group.getAttribute('data-locked')).toBeNull();
    expect(group.getAttribute('aria-disabled')).toBeNull();
    expect(group.querySelector('h2')?.textContent).toBe('Improve my site');
  });

  it('still starts nothing here: its one control is the connection screen', async () => {
    await serveConnection({ registered: true, repository: CONNECTED_REPOSITORY });
    await open();
    await waitFor(() => {
      expect(pathTwo().textContent).toContain(CONNECTED_REPOSITORY);
    });

    const controls = within(pathTwo()).getAllByRole('link');
    expect(controls).toHaveLength(1);
    expect(controls[0]?.getAttribute('href')).toBe(paths.githubSettings);
    expect(within(pathTwo()).queryByRole('button')).toBeNull();
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
          expect(within(pathTwo()).getByRole('link')).toBeTruthy();
        });
      }
      // The screen itself: the chrome above it is `tests/chrome.test.tsx`'s.
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

  it('reaches both controls by Tab, and restates no value inline', async () => {
    await serveConnection({ registered: true, repository: null });
    const { container } = await open();
    await waitFor(() => {
      expect(pathTwo().getAttribute('data-locked')).not.toBeNull();
    });

    const main = container.querySelector('main') as HTMLElement;
    expect([...main.querySelectorAll('[style]')]).toHaveLength(0);

    const start = within(pathOne()).getByRole('link', { name: 'Start here' });
    const connect = within(pathTwo()).getByRole('link', { name: 'Connect GitHub' });
    start.focus();
    expect(document.activeElement).toBe(start);
    await userEvent.tab();
    expect(document.activeElement).toBe(connect);
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
    await open();

    // Nothing here animates in: both cards and the lock are there on the first render.
    expect(within(pathOne()).getAllByRole('listitem')).toHaveLength(3);
    expect(reasonOf(pathTwo()).textContent).toContain('Connect a GitHub repository');
  });
});

describe('the connection is read once, for both screens', () => {
  it('asks the platform once however many readers there are', async () => {
    const served = await serveConnection({ registered: true, repository: CONNECTED_REPOSITORY });

    function TwoReaders() {
      const first = useGithubConnection();
      const second = useGithubConnection();
      return (
        <p>
          {first.status} {second.status}
        </p>
      );
    }

    render(<TwoReaders />);
    await waitFor(() => {
      expect(screen.getByText('connected connected')).toBeTruthy();
    });
    expect(served.reads()).toBe(1);
  });
});
