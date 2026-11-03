// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns } from '../app';
import { axeViolations, describeViolations } from '../axe';
import { paths } from '../../src/shell/paths';
import {
  FIXTURE_PATCH,
  IMPROVE_PATH,
  pathOneRun,
  pathTwoRun,
  serveImprove,
  showImprove,
} from './fixture';

/**
 * `/runs/:runId/improve` — the screen path 2 ends on, and the screen a user who has
 * connected nothing still sees.
 *
 * The two faces of `#screen-improve` are **states**, so each test here puts one connection
 * answer and one run in front of the screen and reads what a reader reads. Every figure
 * asserted is one the fixture run carries, so the suite is about the screen rather than
 * about a second copy of the artifact's numbers, and it is offline: the run data and the
 * platform are served over a stubbed `fetch`.
 */

/** The page's own heading, which is on every state of the screen. */
const HEADING = 'Have the first change written for you';

/** The screen, once it is on the page. */
const settled = async (): Promise<void> => {
  await waitFor(() => {
    expect(document.querySelector('[data-screen="improve"]')).not.toBeNull();
  });
};

const section = (name: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-section="${name}"]`);

const sectionText = (name: string): string => section(name)?.textContent ?? '';

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the locked face, which is the normal one', () => {
  it('renders the heading, the lede with the no-merge sentence, and the lock', async () => {
    await serveImprove({ connection: { repository: null } });
    showImprove();
    await settled();

    expect(screen.getByRole('heading', { level: 1, name: HEADING })).toBeDefined();
    const lede = screen.getByText(/One targeted change, picked from the recommendations above/);
    expect(lede.textContent).toContain('PersonaVision never merges it. You do.');
    // The promise is bold, in the prototype's own emphasis, and is not softened.
    expect(lede.querySelector('b')?.textContent).toBe('PersonaVision never merges it.');
  });

  it("states the app's permissions and that it has no merge permission", async () => {
    await serveImprove({ connection: { repository: null } });
    showImprove();
    await settled();

    const lock = sectionText('lock');
    expect(lock).toContain('Not connected yet.');
    expect(lock).toContain('read access to the code and write access to pull requests');
    expect(lock).toContain('nothing else, and no merge permission');
  });

  it('names the site the one repository would have to deploy, from the run', async () => {
    await serveImprove({ connection: { repository: null } });
    showImprove();
    await waitFor(() => {
      expect(sectionText('lock')).toContain('localhost:4173');
    });
  });

  it('sends its one control to the connection screen', async () => {
    await serveImprove({ connection: { repository: null } });
    showImprove();
    await settled();

    const connect = screen.getByRole('link', { name: 'Connect GitHub' });
    expect(connect.getAttribute('href')).toBe(paths.githubSettings);
  });

  it('says so while the GitHub App is not registered, and still offers the screen', async () => {
    await serveImprove({ connection: { registered: false } });
    showImprove();
    await waitFor(() => {
      expect(sectionText('lock')).toContain('GitHub App is not registered yet');
    });
    expect(screen.getByRole('link', { name: 'Connect GitHub' })).toBeDefined();
  });

  it('stays locked when the connection could not be checked, and says why', async () => {
    await serveImprove({ connection: { unreachable: true } });
    showImprove();
    await waitFor(() => {
      expect(sectionText('lock')).toContain('could not be checked, so this path stays locked');
    });
    expect(sectionText('lock')).toContain('The platform could not be reached');
  });

  it('draws the illustration under what it looks like once connected', async () => {
    await serveImprove({ connection: { repository: null } });
    showImprove();
    await settled();

    const illustration = section('illustration');
    expect(illustration?.textContent).toContain('What it looks like once connected');
    expect(illustration?.textContent).toContain('clipforge/web #482');
    // The example links nowhere: an example pull request has nowhere to go.
    expect(illustration?.querySelector('a')).toBeNull();
  });

  it('is on the page with its lock before the connection answers, and does not jump', async () => {
    const served = await serveImprove({ connection: { hold: true, repository: 'northwind/web' } });
    showImprove();
    await settled();

    expect(screen.getByRole('heading', { level: 1, name: HEADING })).toBeDefined();
    expect(sectionText('lock')).toContain('Not connected yet.');

    served.release();
    await waitFor(() => {
      expect(section('lock')).toBeNull();
    });
  });
});

describe('the pull request it wrote', () => {
  const connected = { repository: 'northwind/web' };

  it('renders the title, the repository and number with its state, and the diff', async () => {
    await serveImprove({ run: pathTwoRun(), connection: connected });
    showImprove();

    await waitFor(() => {
      expect(section('pull-request')).not.toBeNull();
    });
    expect(sectionText('pull-request')).toContain('Show the expected wait before Generate');
    expect(sectionText('pull-request')).toContain('northwind/web #482 · open');
    const link = screen.getByRole('link', { name: 'Show the expected wait before Generate' });
    expect(link.getAttribute('href')).toBe('https://github.example/northwind/web/pull/482');
    expect(sectionText('diff')).toContain(FIXTURE_PATCH.split('\n')[1] as string);
  });

  it('names the recommendation the change came from and the one file it touches', async () => {
    await serveImprove({ run: pathTwoRun(), connection: connected });
    showImprove();

    await waitFor(() => {
      expect(section('from-recommendation')).not.toBeNull();
    });
    const sentence = sectionText('from-recommendation');
    expect(sentence).toContain('From recommendation R-1');
    expect(sentence).toContain('tell people how long the video will take');
    expect(sentence).toContain('app/views/waiting.html');
    expect(sentence).toContain('one change, so the before/after says what the change did');
  });

  it('says where the change itself is when the run recorded no patch and no state', async () => {
    await serveImprove({ run: pathTwoRun({ bare: true }), connection: connected });
    showImprove();

    await waitFor(() => {
      expect(sectionText('diff')).toContain('recorded no patch');
    });
    // Nothing is invented: no recorded state means the chip claims none.
    expect(sectionText('pull-request')).toContain('northwind/web #482');
    expect(sectionText('pull-request')).not.toContain('· open');
  });

  it('renders the preview URL with what it is', async () => {
    await serveImprove({ run: pathTwoRun(), connection: connected });
    showImprove();

    await waitFor(() => {
      expect(section('preview')).not.toBeNull();
    });
    expect(sectionText('preview')).toContain('https://northwind-web-git-pv-wait.preview.example');
    expect(sectionText('preview')).toContain(
      "your repository's own preview deployment for this pull request",
    );
  });

  it('names the audience, the people, the seeds and the holdout it was tested with', async () => {
    await serveImprove({ run: pathTwoRun(), connection: connected });
    showImprove();

    await waitFor(() => {
      expect(section('tested-with')).not.toBeNull();
    });
    const tested = sectionText('tested-with');
    // The fixture run: four people generated, one of them held out, three seed groups.
    expect(tested).toContain('Outdoor-gear shoppers');
    expect(tested).toContain('the same 3 people');
    expect(tested).toContain('the same 3 seeds');
    expect(tested).toContain('holdout of 1 person');
    expect(tested).toContain('seeds this change was never chosen against');
  });

  it('is drawn with no illustration label for a connected workspace', async () => {
    await serveImprove({ run: pathTwoRun(), connection: connected });
    showImprove();

    await waitFor(() => {
      expect(section('pull-request')).not.toBeNull();
    });
    expect(section('illustration')).toBeNull();
    expect(section('lock')).toBeNull();
    expect(document.body.textContent).not.toContain('What it looks like once connected');
  });

  it('says in one sentence that a connected run tested no change', async () => {
    await serveImprove({ run: pathOneRun(), connection: connected });
    showImprove();

    await waitFor(() => {
      expect(sectionText('no-change')).toContain('This test tested no change');
    });
    expect(section('before-after')).toBeNull();
    // The lede is kept: the screen still says what path 2 does and that it never merges.
    expect(screen.getByText(/PersonaVision never merges it\./)).toBeDefined();
  });
});

describe('a change that was never reached', () => {
  it('renders the reason in place of the preview and no before/after', async () => {
    const reason = 'this repository publishes no preview deployment for a pull request';
    await serveImprove({
      run: pathTwoRun({ noPreview: reason }),
      connection: { repository: 'northwind/web' },
    });
    showImprove();

    await waitFor(() => {
      expect(section('no-preview')).not.toBeNull();
    });
    expect(sectionText('no-preview')).toContain('the changed version could not be reached');
    expect(sectionText('no-preview')).toContain(reason);
    expect(section('before-after')).toBeNull();
    // The pull request is still shown: it was opened, whatever happened after.
    expect(sectionText('pull-request')).toContain('northwind/web #482');
  });
});

describe('the before and after, with the holdout beside it', () => {
  const connected = { repository: 'northwind/web' };

  const figures = (): string[] =>
    [...document.querySelectorAll('[data-section="before-after"] figure')].map(
      (figure) => figure.textContent ?? '',
    );

  it('renders the three figures with their people, read from the stored scores', async () => {
    await serveImprove({ run: pathTwoRun(), connection: connected });
    showImprove();

    await waitFor(() => {
      expect(figures()).toHaveLength(3);
    });
    const [baseline, change, holdout] = figures();
    // The fixture's stored rates: A 0.818182, B 0.181818, and the holdout's own 0.5.
    expect(baseline).toContain('82%');
    expect(baseline).toContain('Baseline');
    expect(baseline).toContain('9 of 11 people');
    expect(change).toContain('18%');
    expect(change).toContain('With the change');
    expect(change).toContain('2 of 11 people');
    expect(holdout).toContain('50%');
    expect(holdout).toContain('Holdout');
    expect(holdout).toContain('1 of 2 people, seeds never used to choose the change');
  });

  it('renders the notice for a confirmed holdout', async () => {
    await serveImprove({ run: pathTwoRun({ holdout: 'confirmed' }), connection: connected });
    showImprove();

    await waitFor(() => {
      expect(sectionText('holdout-verdict')).toContain('Confirmed on the holdout.');
    });
    expect(section('holdout-verdict')?.className).toContain('info');
  });

  it('renders its own sentence when the holdout did not confirm, with no win framing', async () => {
    await serveImprove({ run: pathTwoRun({ holdout: 'not_confirmed' }), connection: connected });
    showImprove();

    await waitFor(() => {
      expect(sectionText('holdout-verdict')).toContain('Not confirmed on the holdout.');
    });
    // Not the quiet informational notice, and nothing marks a version as the one to ship.
    expect(section('holdout-verdict')?.className).not.toContain('info');
    expect(sectionText('before-after')).not.toContain('the one to ship');
  });

  it('says that the holdout did not judge when no holdout verdict was recorded', async () => {
    await serveImprove({ run: pathTwoRun({ holdout: 'none' }), connection: connected });
    showImprove();

    await waitFor(() => {
      expect(sectionText('holdout-verdict')).toContain('The holdout did not judge this change.');
    });
    // Two figures, not three: a holdout nobody measured has no figure of its own.
    expect(figures()).toHaveLength(2);
    // The run's own sentence is beside it, so the reader is told what it did say.
    expect(sectionText('holdout-verdict')).toContain(pathTwoRun().verdict.audienceSentence);
  });

  it('renders the why from the run and the footnote in full', async () => {
    const run = pathTwoRun();
    await serveImprove({ run, connection: connected });
    showImprove();

    await waitFor(() => {
      expect(section('reasons')).not.toBeNull();
    });
    for (const reason of run.verdict.reasons) {
      expect(sectionText('reasons')).toContain(reason);
    }

    const footnote = document.querySelector('[data-section="before-after"] .footnote');
    const text = footnote?.textContent ?? '';
    expect(text).toContain('Simulated for Outdoor-gear shoppers');
    expect(text).toContain('it does not estimate what it will do to your conversion rate');
    expect(text).toContain('Merging is yours.');
  });
});

describe('the screen itself', () => {
  it('resolves on its own route inside the chrome', async () => {
    await serveImprove({ run: pathTwoRun(), connection: { repository: 'northwind/web' } });
    const { router } = showImprove();
    await settled();

    expect(router.state.location.pathname).toBe(IMPROVE_PATH);
    expect(document.querySelector('[data-shell="chrome"]')).not.toBeNull();
  });

  it('renders one sentence for a run that cannot be read, not a blank', async () => {
    await serveImprove({ connection: { repository: 'northwind/web' } });
    showImprove(paths.improve('no-such-test'));

    // The shell's own answer, which every other run screen gives: the id that was looked
    // for and the file that was read for it, never a blank page.
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('No test with that id');
    });
    expect(screen.getByText('no-such-test')).toBeDefined();
  });

  it('is clean under axe on both faces', async () => {
    // The screen itself: the chrome above it is `tests/chrome.test.tsx`'s, as every other
    // screen's suite scopes it.
    const screenOf = (container: HTMLElement): HTMLElement =>
      container.querySelector('main') as HTMLElement;

    await serveImprove({ connection: { repository: null } });
    const locked = showImprove();
    await settled();
    const lockedViolations = await axeViolations(screenOf(locked.container));
    expect(lockedViolations, describeViolations(lockedViolations)).toHaveLength(0);
    locked.unmount();

    forgetRuns();
    await serveImprove({ run: pathTwoRun(), connection: { repository: 'northwind/web' } });
    const connected = showImprove();
    await waitFor(() => {
      expect(section('before-after')).not.toBeNull();
    });
    const violations = await axeViolations(screenOf(connected.container));
    expect(violations, describeViolations(violations)).toHaveLength(0);
  });

  it('is operable by keyboard: the lock reaches the connection screen', async () => {
    await serveImprove({ connection: { repository: null } });
    const { router } = showImprove();
    await settled();

    const connect = screen.getByRole('link', { name: 'Connect GitHub' });
    connect.focus();
    expect(document.activeElement).toBe(connect);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.githubSettings);
    });
  });
});
