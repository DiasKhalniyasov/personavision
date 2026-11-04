// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { axeViolations, describeViolations } from '../axe';
import { forgetRuns, mountApp } from '../app';
import { serveWorkspace } from '../newtest/templates.fixture';
import { paths, STEP_PARAM } from '../../src/shell/paths';
import { EXAMPLE_TESTS } from '../../src/screens/newtest/templates';
import { forgetWizardDraft, readWizardDraft } from '../../src/screens/newtest/wizard/draft';
import { forgetGithubConnection } from '../../src/screens/settings/connection';

/**
 * `/` for a workspace with no test — the **No tests** state, and the five example tests on
 * it (#417).
 *
 * The screen keeps both of the actions it was built with: the committed demo run (decision
 * 20) and a new test. What it gains is the same five the first New test screen offers, read
 * from the same file — so this suite asserts that the two surfaces cannot drift, and that
 * choosing one from here does what choosing one from there does even though this screen is
 * not a step of the wizard.
 */

const STRIPE = EXAMPLE_TESTS[0] as (typeof EXAMPLE_TESTS)[number];

const open = async () => {
  const mounted = mountApp(paths.home);
  await screen.findByRole('heading', { name: 'No tests yet' });
  return mounted;
};

/** The screen's own two actions, which the chrome above it repeats one of. */
const emptyCard = (): HTMLElement =>
  screen.getByRole('heading', { name: 'No tests yet' }).closest('.empty') as HTMLElement;

beforeEach(loadDesignTokens);
afterEach(() => {
  forgetRuns();
  forgetWizardDraft();
  forgetGithubConnection();
});

describe('the No tests screen', () => {
  it('keeps both of its own actions', async () => {
    await serveWorkspace({ runIds: [] });
    await open();

    const card = within(emptyCard());
    expect(card.getByRole('link', { name: 'Open the example test' }).getAttribute('href')).toBe(
      paths.demo,
    );
    expect(card.getByRole('link', { name: 'New test' }).getAttribute('href')).toBe(paths.newTest);
  });

  it('offers the same five, from the same file and in its order', async () => {
    await serveWorkspace({ runIds: [] });
    await open();

    const section = screen
      .getByRole('heading', { level: 2, name: 'Or try one of these, on a real public site' })
      .closest('section') as HTMLElement;

    expect(
      within(section)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(EXAMPLE_TESTS.map((template) => new URL(template.siteUrl).host));
    expect(within(section).getAllByRole('button', { name: 'Try this test' })).toHaveLength(
      EXAMPLE_TESTS.length,
    );
  });

  it('fills the New test draft and goes to its audience step, as the path screen does', async () => {
    const served = await serveWorkspace({ runIds: [] });
    const { router } = await open();

    await userEvent.click(
      within(screen.getByRole('group', { name: 'docs.stripe.com' })).getByRole('button', {
        name: 'Try this test',
      }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.newTest);
    });
    expect(new URLSearchParams(router.state.location.search).get(STEP_PARAM)).toBe('audience');
    expect(served.created()).toEqual([STRIPE.siteUrl]);

    const draft = readWizardDraft();
    expect(draft.site?.url).toBe(STRIPE.siteUrl);
    expect(draft.feature).toBe(STRIPE.feature);
    expect(draft.audienceSentence).toBe(STRIPE.audienceSentence);
    expect(draft.goal?.task).toBe(STRIPE.task);
    expect(draft.goal?.author).toBe('user');
  });

  it('passes axe with the five on it, and restates no value inline', async () => {
    await serveWorkspace({ runIds: [] });
    const { container } = await open();
    await waitFor(() => {
      expect(screen.getAllByRole('group')).toHaveLength(EXAMPLE_TESTS.length);
    });

    const main = container.querySelector('main') as HTMLElement;
    expect([...main.querySelectorAll('[style]')]).toHaveLength(0);

    const violations = await axeViolations(main);
    expect(violations, describeViolations(violations)).toHaveLength(0);
  });
});
