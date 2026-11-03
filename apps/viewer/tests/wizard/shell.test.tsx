// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanup as cleanupBetweenRenders,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../setup';
import { axeViolations, describeViolations } from '../axe';
import { forgetRuns, mountApp, serveRunData } from '../app';
import { ruleIn, rulesOf } from '../cssom';
import { servePlatform } from '../newtest/fixture';
import { newTestStep, paths, STEP_PARAM } from '../../src/shell/paths';
import {
  canLaunch,
  emptyWizardDraft,
  forgetWizardDraft,
  readWizardDraft,
  useHeldWizardDraft,
  useWizardDraft,
  WizardDraftContext,
  writeWizardDraft,
} from '../../src/screens/newtest/wizard/draft';
import type { WizardDraft } from '../../src/screens/newtest/wizard/draft';

/**
 * `/new` — the wizard's frame: the step in the query, the breadcrumb and the draft.
 *
 * What is asserted here is the shell the four step tickets inherit and nothing inside it:
 * which step an address renders, what the URL becomes, what the crumbs read and link to, and
 * what survives a reload. Each step's own content is its own suite's.
 */

/** The step the URL names, as the router holds it after a render. */
const stepInUrl = (search: string): string | null => new URLSearchParams(search).get(STEP_PARAM);

/** The breadcrumb of the step on the screen. */
const breadcrumb = (): HTMLElement => document.querySelector('.breadcrumb') as HTMLElement;

const heading = async (name: string | RegExp): Promise<HTMLElement> =>
  screen.findByRole('heading', { level: 1, name });

/** A draft a user has filled in, reviewed audience and all. */
const filledDraft = (): WizardDraft => ({
  site: { id: 'site-clipforge', url: 'https://app.clipforge.example/create' },
  feature: 'generating a video from a prompt',
  audience: {
    sentence: 'first-time creators in Kazakhstan, mostly on phones',
    audienceId: 'aud-first-time-creators',
    reviewed: true,
  },
  goal: {
    task: 'Generate a video from a text prompt on this page.',
    success: 'A video preview is visible on the page.',
    author: 'model',
  },
});

beforeEach(loadDesignTokens);
afterEach(() => {
  forgetRuns();
  forgetWizardDraft();
});

describe('the step in the query', () => {
  it('renders the step the query names', async () => {
    await serveRunData();

    for (const [step, name] of [
      ['path', 'Path'],
      ['audience', 'Audience & feature'],
      ['goal', 'Goal'],
      ['estimate', 'Launch'],
    ] as const) {
      const { unmount } = mountApp(newTestStep(step));
      expect(await heading(name), step).toBeTruthy();
      unmount();
    }
  });

  it('reads ?step=feature as the audience-and-feature step, which is section 13’s own name for it', async () => {
    await serveRunData();
    const { router } = mountApp(newTestStep('feature'));

    expect(await heading('Audience & feature')).toBeTruthy();
    // Canonicalised in place: the alias rendered its step and the address now names it, so
    // a reload or a shared link lands on the same screen.
    await waitFor(() => {
      expect(stepInUrl(router.state.location.search)).toBe('audience');
    });
    expect(router.state.location.pathname).toBe(paths.newTest);
  });

  it('renders the path chooser for no step at all, and names it in the URL', async () => {
    await serveRunData();
    const { router } = mountApp(paths.newTest);

    expect(await heading('Path')).toBeTruthy();
    await waitFor(() => {
      expect(router.state.location.search).toBe(`?${STEP_PARAM}=path`);
    });
  });

  it('renders the path chooser for a step nobody knows, rather than a not-found', async () => {
    await serveRunData();
    const { router } = mountApp(newTestStep('mezzanine'));

    expect(await heading('Path')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'There is no page here' })).toBeNull();
    await waitFor(() => {
      expect(stepInUrl(router.state.location.search)).toBe('path');
    });
  });

  it('replaces the address rather than stacking one, so Back leaves the wizard', async () => {
    await serveRunData();
    const { router } = mountApp(paths.newTest);

    await waitFor(() => {
      expect(stepInUrl(router.state.location.search)).toBe('path');
    });
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('opens the launch step directly from a link to it', async () => {
    await serveRunData();
    writeWizardDraft(filledDraft());
    const { router } = mountApp(newTestStep('estimate'));

    expect(await heading('Launch')).toBeTruthy();
    expect(stepInUrl(router.state.location.search)).toBe('estimate');
  });

  it('lands on the goal step with the draft intact after a reload', async () => {
    await serveRunData();
    const draft = filledDraft();
    writeWizardDraft(draft);

    const first = mountApp(newTestStep('goal'));
    expect(await heading('Goal')).toBeTruthy();
    first.unmount();

    // The reload: the app mounted again on the same address, with nothing in memory.
    const { router } = mountApp(newTestStep('goal'));
    expect(await heading('Goal')).toBeTruthy();
    expect(stepInUrl(router.state.location.search)).toBe('goal');
    expect(readWizardDraft()).toEqual(draft);
  });
});

describe('the breadcrumb', () => {
  it('names the four steps in the prototype’s order and wording', async () => {
    await serveRunData();
    mountApp(newTestStep('audience'));
    await heading('Audience & feature');

    expect(breadcrumb().textContent).toBe('Path / Audience & feature / Goal / Launch');
  });

  it('marks the current step, and only that one', async () => {
    await serveRunData();
    mountApp(newTestStep('goal'));
    await heading('Goal');

    const marked = breadcrumb().querySelectorAll('b');
    expect([...marked].map((crumb) => crumb.textContent)).toEqual(['Goal']);
  });

  it('links the steps already passed, and leaves the steps ahead as plain text', async () => {
    await serveRunData();
    mountApp(newTestStep('goal'));
    await heading('Goal');

    const crumbs = within(breadcrumb());
    expect(crumbs.getByRole('link', { name: 'Path' }).getAttribute('href')).toBe(
      newTestStep('path'),
    );
    expect(crumbs.getByRole('link', { name: 'Audience & feature' }).getAttribute('href')).toBe(
      newTestStep('audience'),
    );
    // Launch is ahead: a user cannot jump to a step they have not filled in.
    expect(crumbs.queryByRole('link', { name: 'Launch' })).toBeNull();
    expect(crumbs.getAllByRole('link')).toHaveLength(2);
  });

  it('links nothing on the first step', async () => {
    await serveRunData();
    mountApp(newTestStep('path'));
    await heading('Path');

    expect(within(breadcrumb()).queryAllByRole('link')).toHaveLength(0);
  });
});

describe('the draft', () => {
  it('records the site, the feature sentence, the audience and the goal with its author', () => {
    const draft = filledDraft();
    writeWizardDraft(draft);

    const read = readWizardDraft();
    expect(read.site?.url).toBe('https://app.clipforge.example/create');
    expect(read.feature).toBe('generating a video from a prompt');
    expect(read.audience?.audienceId).toBe('aud-first-time-creators');
    expect(read.audience?.reviewed).toBe(true);
    expect(read.goal?.success).toBe('A video preview is visible on the page.');
    expect(read.goal?.author).toBe('model');
  });

  it('is a first visit when there is nothing stored, and when what is stored is not a draft', () => {
    expect(readWizardDraft()).toEqual(emptyWizardDraft());

    sessionStorage.setItem('personavision.newtest.draft', '{"feature":42}');
    expect(readWizardDraft()).toEqual(emptyWizardDraft());

    sessionStorage.setItem('personavision.newtest.draft', 'not json at all');
    expect(readWizardDraft()).toEqual(emptyWizardDraft());
  });

  it('renders the step rather than failing when the browser refuses storage', async () => {
    await serveRunData();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is not available in this context');
    });

    expect(readWizardDraft()).toEqual(emptyWizardDraft());
    mountApp(newTestStep('goal'));
    expect(await heading('Goal')).toBeTruthy();

    vi.restoreAllMocks();
  });
});

/**
 * What a step ticket will really render: a control that writes the draft and, beside it, one
 * that reads `canLaunch`. Both go through `useWizardDraft`, as the handoff on #264 says.
 */
function DraftProbe({ label }: { label: string }) {
  const { draft, update } = useWizardDraft();

  return (
    <p>
      <button
        type="button"
        onClick={() => {
          update({
            audience: { sentence: 'first-time creators', audienceId: 'aud-ftc', reviewed: true },
          });
        }}
      >
        {`Review the audience in ${label}`}
      </button>
      <span>{`${label} may launch: ${String(canLaunch(draft))}`}</span>
    </p>
  );
}

/** The wizard's own wiring: the draft held once, shared with everything the step renders. */
function HeldByTheWizard() {
  const held = useHeldWizardDraft();

  return (
    <WizardDraftContext.Provider value={held}>
      <DraftProbe label="the form" />
      <DraftProbe label="the button beside it" />
    </WizardDraftContext.Provider>
  );
}

describe('the draft the steps read', () => {
  it('is one copy: what the form writes, the button beside it reads at once', async () => {
    render(<HeldByTheWizard />);

    expect(screen.getByText('the form may launch: false')).toBeTruthy();
    expect(screen.getByText('the button beside it may launch: false')).toBeTruthy();

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /^Review the audience in the form/ }));

    expect(screen.getByText('the form may launch: true')).toBeTruthy();
    expect(screen.getByText('the button beside it may launch: true')).toBeTruthy();
    // And written through, so a reload in the middle of the step keeps it.
    expect(readWizardDraft().audience?.reviewed).toBe(true);
  });

  it('is read back by a step mounted after a reload, through the same hook', async () => {
    render(<HeldByTheWizard />);
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /^Review the audience in the form/ }));

    cleanupBetweenRenders();
    render(<HeldByTheWizard />);
    expect(screen.getByText('the form may launch: true')).toBeTruthy();
  });
});

describe('canLaunch', () => {
  it('is false until the audience has been reviewed', () => {
    const draft = filledDraft();

    expect(canLaunch(emptyWizardDraft())).toBe(false);
    expect(canLaunch({ ...draft, audience: null })).toBe(false);
    expect(
      canLaunch({
        ...draft,
        audience: { ...(draft.audience as NonNullable<WizardDraft['audience']>), reviewed: false },
      }),
    ).toBe(false);
    expect(canLaunch(draft)).toBe(true);
  });
});

describe('the two-URL A/B form', () => {
  it('is the wizard’s variants step', async () => {
    await servePlatform();
    const { router } = mountApp(newTestStep('variants'));

    expect(await screen.findByRole('button', { name: /^Start test/ })).toBeTruthy();
    expect(await heading('New test')).toBeTruthy();
    expect(router.state.location.pathname).toBe(paths.newTest);
    expect(stepInUrl(router.state.location.search)).toBe('variants');
  });

  it('is not offered by the path chooser, which has no second URL to ask for', async () => {
    await serveRunData();
    mountApp(paths.newTest);
    await heading('Path');

    expect(
      [...document.querySelectorAll('a[href]')].map((link) => link.getAttribute('href')),
    ).not.toContain(newTestStep('variants'));
  });

  it('sends a workspace with no audience to the screen that asks for one', async () => {
    await servePlatform({ records: [] });
    const { router } = mountApp(newTestStep('variants'));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.audiences);
    });
  });

  it('opens the wizard’s own steps for a workspace with no audience, because that is where one is described', async () => {
    await servePlatform({ records: [] });
    const { router } = mountApp(paths.newTest);

    expect(await heading('Path')).toBeTruthy();
    expect(router.state.location.pathname).toBe(paths.newTest);
  });
});

describe('every screen this ticket mounts', () => {
  /** The wizard's four steps and the four screens the route table gained. */
  const addresses: readonly string[] = [
    newTestStep('path'),
    newTestStep('audience'),
    newTestStep('goal'),
    newTestStep('estimate'),
    paths.sites,
    paths.newSite,
    paths.site('site-clipforge'),
    paths.githubSettings,
  ];

  it('passes axe cleanly', async () => {
    await serveRunData();

    for (const address of addresses) {
      const { container, unmount } = mountApp(address);
      await screen.findByRole('heading', { level: 1 });
      // The screen itself: the chrome above it is `tests/chrome.test.tsx`'s, as every other
      // screen suite scopes its pass.
      const violations = await axeViolations(container.querySelector('main') as HTMLElement);
      expect(violations, `${address}\n${describeViolations(violations)}`).toHaveLength(0);
      unmount();
    }
  });

  it('is complete and still on first paint under prefers-reduced-motion: reduce', async () => {
    await serveRunData();
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

    for (const address of addresses) {
      const { unmount } = mountApp(address);
      // The whole screen is there on the first render: nothing here animates in, so there is
      // no finished state to wait for and nothing to shorten.
      expect((await screen.findByRole('heading', { level: 1 })).textContent, address).not.toBe('');
      unmount();
    }
  });

  it('lays itself out in a shared responsive column, and restates no value by hand', async () => {
    await serveRunData();

    for (const address of addresses) {
      const { unmount } = mountApp(address);
      await screen.findByRole('heading', { level: 1 });

      // `.wrap` and `.wrap-narrow` carry the narrow gutter of `docs/design/tokens.css` under
      // the prototype's own media query, which is what makes a screen work at 390px; a
      // hand-written width or colour would be a value restated outside the tokens.
      const main = document.querySelector('main') as HTMLElement;
      expect(main.querySelector('.wrap, .wrap-narrow'), address).not.toBeNull();
      expect([...main.querySelectorAll('[style]')], address).toHaveLength(0);
      unmount();
    }
  });

  it('is operable by keyboard, with the app’s own focus ring', async () => {
    await serveRunData();
    mountApp(newTestStep('goal'));
    await heading('Goal');

    // The crumbs behind are the only controls this ticket adds, and they are links: reachable
    // by Tab, openable in a new window, and not a button pretending to be one.
    const crumb = within(breadcrumb()).getByRole('link', { name: 'Path' });
    expect(crumb.tagName).toBe('A');
    expect(crumb.getAttribute('href')).toBe(newTestStep('path'));
    crumb.focus();
    expect(document.activeElement).toBe(crumb);

    // The ring itself is the app's one `:focus-visible` rule, in the tokens' own values —
    // jsdom paints nothing, so it is read off the stylesheet the app ships.
    const appCss = join(dirname(fileURLToPath(import.meta.url)), '../../src/app.css');
    const ring = ruleIn(rulesOf(readFileSync(appCss, 'utf8')))(':focus-visible');
    expect(ring.outline).toBe('var(--border-width-strong) solid var(--color-focus)');
  });

  it('tells a screen reader which step is the current one', async () => {
    await serveRunData();
    mountApp(newTestStep('goal'));
    await heading('Goal');

    const marked = breadcrumb().querySelectorAll('[aria-current="step"]');
    expect([...marked].map((crumb) => crumb.textContent)).toEqual(['Goal']);
  });
});
