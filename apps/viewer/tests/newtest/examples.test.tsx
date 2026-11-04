// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { axeViolations, describeViolations } from '../axe';
import { forgetRuns, mountApp } from '../app';
import { ruleIn, rulesOf } from '../cssom';
import { serveWorkspace } from './templates.fixture';
import { newTestStep, STEP_PARAM } from '../../src/shell/paths';
import { EXAMPLE_TESTS } from '../../src/screens/newtest/templates';
import { forgetWizardDraft, readWizardDraft } from '../../src/screens/newtest/wizard/draft';
import { forgetGithubConnection } from '../../src/screens/settings/connection';
import type { Rule } from '../cssom';

/**
 * `/new?step=path` — **the five example tests**, under the two path cards (#417).
 *
 * What is asserted is what a reader can see and do: the five the data file holds, each as a
 * card with one control, and what pressing that control does — the site record, the four
 * fields of the draft, the step it lands on, and the refusal that leaves the draft alone.
 *
 * Nothing here asserts that a template is *valid*: `tests/newtest/templates.test.ts` holds
 * the five to the platform's, the contract's and the provider's own rules. This suite is
 * about the screen.
 */

const STRIPE = EXAMPLE_TESTS[0] as (typeof EXAMPLE_TESTS)[number];
const IKEA = EXAMPLE_TESTS[2] as (typeof EXAMPLE_TESTS)[number];

/** A template's card, by the host that names it. */
const cardFor = (host: string): HTMLElement => screen.getByRole('group', { name: host });

/** The one control on a card: the controls it holds, so a test can count them. */
const controlsIn = (card: HTMLElement): HTMLElement[] => [
  ...within(card).queryAllByRole('button'),
  ...within(card).queryAllByRole('link'),
];

const open = async (address: string = newTestStep('path')) => {
  const mounted = mountApp(address);
  await screen.findByRole('heading', { level: 1, name: 'What would you like us to do?' });
  return mounted;
};

/**
 * Press *Try this test* on one of the five.
 *
 * It waits for the control to be offered: until the workspace's sites have been read the
 * card says so instead, because a press into an unread list would add a site the workspace
 * already holds a second time.
 */
const tryIt = async (host: string): Promise<void> => {
  const control = await waitFor(() => {
    const button = within(cardFor(host)).getByRole('button', {
      name: 'Try this test',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    return button;
  });
  await userEvent.click(control);
};

beforeEach(loadDesignTokens);
afterEach(() => {
  forgetRuns();
  forgetWizardDraft();
  forgetGithubConnection();
});

describe('the five, under the two path cards', () => {
  it('offers them under one heading, from the data file and in its order', async () => {
    await serveWorkspace();
    await open();

    const section = screen
      .getByRole('heading', { level: 2, name: 'Or try one of these, on a real public site' })
      .closest('section') as HTMLElement;

    expect(
      within(section)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['docs.stripe.com', 'vercel.com', 'www.ikea.com', 'www.canva.com', 'www.apple.com']);
  });

  it('says what each one is about, what it attempts, and who it suggests', async () => {
    await serveWorkspace();
    await open();

    const card = within(cardFor('docs.stripe.com'));
    expect(card.getByText(STRIPE.feature)).toBeTruthy();
    expect(card.getByText(STRIPE.task)).toBeTruthy();
    expect(card.getByText('Suggested audience')).toBeTruthy();
    expect(card.getByText(STRIPE.audienceSentence)).toBeTruthy();
  });

  it('gives each card exactly one control, so a card is a group and not a button', async () => {
    await serveWorkspace();
    await open();
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Try this test' })).toHaveLength(
        EXAMPLE_TESTS.length,
      );
    });

    for (const template of EXAMPLE_TESTS) {
      const card = cardFor(new URL(template.siteUrl).host);
      const controls = controlsIn(card);
      expect(
        controls.map((control) => control.textContent),
        template.id,
      ).toEqual(['Try this test']);
    }
  });
});

describe('choosing one fills the draft and lands on the audience step', () => {
  it('adds the site, writes the four fields and goes to ?step=audience', async () => {
    const served = await serveWorkspace();
    const { router } = await open();

    await tryIt('www.ikea.com');

    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get(STEP_PARAM)).toBe('audience');
    });
    expect(served.created()).toEqual([IKEA.siteUrl]);

    const draft = readWizardDraft();
    expect(draft.site?.url).toBe(IKEA.siteUrl);
    expect(draft.feature).toBe(IKEA.feature);
    expect(draft.audienceSentence).toBe(IKEA.audienceSentence);
    expect(draft.goal?.task).toBe(IKEA.task);
    expect(draft.goal?.success).toBe(IKEA.successCriterion);
    // The user chose it; no model wrote it. `goalAuthorSchema` grows no third author.
    expect(draft.goal?.author).toBe('user');
    expect(draft.goal?.askedFor).toEqual({ siteUrl: IKEA.siteUrl, feature: IKEA.feature });
    // Nothing is launched and nothing is reviewed: the audience is still a sentence.
    expect(draft.audience).toBeNull();
  });

  it('survives a reload, as a typed draft does: it is sessionStorage', async () => {
    await serveWorkspace();
    const { unmount } = await open();
    await tryIt('docs.stripe.com');
    await waitFor(() => {
      expect(readWizardDraft().site?.url).toBe(STRIPE.siteUrl);
    });
    unmount();

    // A second mount is a reload: the draft is read off storage on the first render.
    const draft = readWizardDraft();
    expect(draft.feature).toBe(STRIPE.feature);
    expect(draft.goal?.task).toBe(STRIPE.task);
  });

  it('carries the sentence into the audience step’s box, and reads nothing on the user’s behalf', async () => {
    await serveWorkspace();
    const { unmount } = await open();
    await tryIt('www.ikea.com');
    await waitFor(() => {
      expect(readWizardDraft().audienceSentence).toBe(IKEA.audienceSentence);
    });
    unmount();
    forgetRuns();

    await serveWorkspace({ sites: [{ id: 'site-1', url: IKEA.siteUrl }] });
    mountApp(newTestStep('audience'));

    const box = (await screen.findByRole('textbox', {
      name: /Describe your audience in a sentence/,
    })) as HTMLTextAreaElement;
    expect(box.value).toBe(IKEA.audienceSentence);
    // The step's own control is what reads it: a template is not a way past decision 161.
    expect(screen.getByRole('button', { name: 'Turn this into an audience' })).toBeTruthy();
    expect(screen.queryByText(/What we read from that sentence/)).toBeNull();
  });

  it('opens the goal step on the template’s goal, with the user named as its author', async () => {
    await serveWorkspace();
    const { unmount } = await open();
    await tryIt('www.apple.com');
    await waitFor(() => {
      expect(readWizardDraft().goal?.author).toBe('user');
    });
    unmount();
    forgetRuns();

    const apple = EXAMPLE_TESTS[4] as (typeof EXAMPLE_TESTS)[number];
    await serveWorkspace({ sites: [{ id: 'site-1', url: apple.siteUrl }] });
    mountApp(newTestStep('goal'));

    const task = (await screen.findByRole('textbox', {
      name: 'The task each person attempts',
    })) as HTMLTextAreaElement;
    const success = screen.getByRole('textbox', {
      name: 'What counts as success',
    }) as HTMLTextAreaElement;
    expect(task.value).toBe(apple.task);
    expect(success.value).toBe(apple.successCriterion);
    // Editable, and the notice names the user: exactly as it shows a goal the user edited.
    expect(task.readOnly).toBe(false);
    expect(screen.getByText(/^Written by you,/)).toBeTruthy();
  });

  it('reuses a site the workspace already holds, and creates no second one', async () => {
    const served = await serveWorkspace({
      sites: [{ id: 'site-ikea', url: `${IKEA.siteUrl}/` }],
    });
    const { router } = await open();

    await tryIt('www.ikea.com');

    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get(STEP_PARAM)).toBe('audience');
    });
    // The same address written twice — a trailing slash — is one site, so nothing is posted.
    expect(served.created()).toEqual([]);
    expect(readWizardDraft().site).toEqual({ id: 'site-ikea', url: `${IKEA.siteUrl}/` });
  });
});

describe('a site the platform refuses', () => {
  // A refusal of the URL itself, which is what `POST /sites` answers with `400` and issues.
  // Deliberately **not** "that site is already here": the platform does not refuse one a
  // workspace already holds (`addSite`), which is why a press waits for the list instead.
  const REFUSED = 'a site is an http:// or https:// URL, and that address was refused.';

  it('states the refusal in the card that was pressed, and fills nothing', async () => {
    await serveWorkspace({
      refusesCreate: {
        status: 400,
        body: { error: REFUSED, issues: [{ path: 'url', message: REFUSED }] },
      },
    });
    const { router } = await open();

    await tryIt('www.canva.com');

    const card = cardFor('www.canva.com');
    await waitFor(() => {
      expect(within(card).getByRole('alert').textContent).toBe(REFUSED);
    });
    // Where the user pressed, and nowhere else.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(readWizardDraft()).toEqual({ site: null, feature: '', audience: null, goal: null });
    expect(new URLSearchParams(router.state.location.search).get(STEP_PARAM)).toBe('path');
  });

  it('states an unreachable platform in the same place', async () => {
    await serveWorkspace({ createUnreachable: true });
    await open();

    await tryIt('vercel.com');

    const card = cardFor('vercel.com');
    await waitFor(() => {
      expect(within(card).getByRole('alert').textContent).toContain('could not be saved');
    });
    expect(readWizardDraft().site).toBeNull();
  });
});

describe('a press is never a second site', () => {
  it('offers nothing to press until the workspace’s sites have been read', async () => {
    const served = await serveWorkspace({
      sites: [{ id: 'site-ikea', url: IKEA.siteUrl }],
      holdList: true,
    });
    await open();

    // The card says what it is doing rather than hiding its control: the audience step's
    // own words for the same wait.
    const control = within(cardFor('www.ikea.com')).getByRole('button', {
      name: 'Reading your sites…',
    }) as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    await userEvent.click(control);
    expect(served.created()).toEqual([]);

    served.release();

    // Once the list is in, the site it names is reused rather than added again.
    await tryIt('www.ikea.com');
    await waitFor(() => {
      expect(readWizardDraft().site?.id).toBe('site-ikea');
    });
    expect(served.created()).toEqual([]);
  });

  it('refuses the other four while one site is being added', async () => {
    const served = await serveWorkspace({ holdCreate: true });
    await open();

    await tryIt('docs.stripe.com');

    await waitFor(() => {
      const working = within(cardFor('docs.stripe.com')).getByRole('button', {
        name: 'Adding the site…',
      }) as HTMLButtonElement;
      expect(working.disabled).toBe(true);
    });
    for (const host of ['vercel.com', 'www.ikea.com', 'www.canva.com', 'www.apple.com']) {
      const other = within(cardFor(host)).getByRole('button', {
        name: 'Try this test',
      }) as HTMLButtonElement;
      expect(other.disabled, host).toBe(true);
    }

    served.release();
    await waitFor(() => {
      expect(readWizardDraft().feature).toBe(STRIPE.feature);
    });
    // One press, one site: the slower of two presses cannot write its draft over the other's.
    expect(served.created()).toEqual([STRIPE.siteUrl]);
  });

  it('says why none of them can be started when the sites cannot be read at all', async () => {
    await serveWorkspace({ listUnreachable: true });
    await open();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('could not be read');
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'none of them can be started until your sites can be read',
    );
    for (const template of EXAMPLE_TESTS) {
      const host = new URL(template.siteUrl).host;
      const control = within(cardFor(host)).getByRole('button', {
        name: 'Try this test',
      }) as HTMLButtonElement;
      expect(control.disabled, host).toBe(true);
    }
  });
});

describe('the screen stays accessible with the five on it', () => {
  it('passes axe, and restates no value inline', async () => {
    await serveWorkspace();
    const { container } = await open();
    await waitFor(() => {
      expect(screen.getAllByRole('group')).toHaveLength(2 + EXAMPLE_TESTS.length);
    });

    const main = container.querySelector('main') as HTMLElement;
    expect([...main.querySelectorAll('[style]')]).toHaveLength(0);

    const violations = await axeViolations(main);
    expect(violations, describeViolations(violations)).toHaveLength(0);
  });

  it('reaches every card’s control by Tab', async () => {
    await serveWorkspace();
    await open();

    const first = await waitFor(() =>
      within(cardFor('docs.stripe.com')).getByRole('button', { name: 'Try this test' }),
    );
    first.focus();
    expect(document.activeElement).toBe(first);
    await userEvent.tab();
    expect(document.activeElement).toBe(
      within(cardFor('vercel.com')).getByRole('button', { name: 'Try this test' }),
    );
  });
});

describe('the layout, read off the stylesheet', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const stylesheet = join(here, '../../src/screens/newtest/examples.module.css');
  let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

  beforeEach(() => {
    const rules: Rule[] = rulesOf(readFileSync(stylesheet, 'utf8'));
    rule = ruleIn(rules);
  });

  it('fills the row with three cards, and takes it to one in a narrow window', () => {
    expect(rule('.cards')['grid-template-columns']).toBe('repeat(3, minmax(0, 1fr))');
    expect(rule('.cards', '(max-width: 1000px)')['grid-template-columns']).toBe(
      'repeat(2, minmax(0, 1fr))',
    );
    // One column at 640px, which is what makes the five work at 390px.
    expect(rule('.cards', '(max-width: 640px)')['grid-template-columns']).toBe('1fr');
  });

  it('wraps the host rather than widening the card past its column', () => {
    expect(rule('.host')['overflow-wrap']).toBe('anywhere');
  });

  it('declares no animation of its own, so reduce has nothing to shorten', () => {
    const source = readFileSync(stylesheet, 'utf8');

    expect(source).not.toMatch(/\banimation\b/);
    expect(source).not.toMatch(/@keyframes/);
    expect(source).not.toMatch(/\btransition\b/);
  });

  it('promises no click on a card that is not one: no pointer, no hover lift', () => {
    const declarations = readFileSync(stylesheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    expect(declarations).not.toMatch(/\bcursor\b/);
    expect(declarations).not.toMatch(/:hover/);
  });
});
