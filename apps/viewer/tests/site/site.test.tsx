// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../setup';
import { axeViolations, describeViolations } from '../axe';
import { forgetRuns, mountApp } from '../app';
import { CREATED_SITE_ID, serveSite, THE_SITE } from './fixture';
import { FIXTURE_RUN_ID, SERVED_CAPS } from '../sites/fixture';
import { paths } from '../../src/shell/paths';
import { clearSiteCache } from '../../src/sites/useSites';

/**
 * `/sites/new` and `/sites/:siteId` — the URL, and the site it became. (#269, #394)
 *
 * The screen contract is `#screen-site` of `docs/design/prototype.html`, and what is asserted
 * here is what a reader sees: the URL as the heading, the URL read-only with *Remove this
 * site* beside it, the figures the site is bound by, and one line about what **Improve my
 * site** needs.
 *
 * **Nothing on either screen asks a reader to prove anything about the address**, because a
 * site is a URL and nothing more — `docs/FLOW.md` section 13, as the owner's input of
 * 2026-11-04 settles it. The suite holds that end of it by reading the whole screen.
 *
 * Every figure comes from the fixture's served answer, which is deliberately not the
 * product's own: `packages/platform/src/caps.ts` is the only place the caps are defined, so
 * a screen that agreed with this suite by accident would be a screen printing a number it
 * holds itself.
 */

/** The heading of a site's own page: the site's address, as `siteName` writes it. */
const THE_HEADING = 'beta.clipforge.example/create';

/** The screen, by the heading it is drawn under. */
const open = async (path: string, heading: string | RegExp = THE_HEADING) => {
  const mounted = mountApp(path);
  await screen.findByRole('heading', { level: 1, name: heading });
  return mounted;
};

const openNew = async () => open(paths.newSite, 'Add a site');

/** The site's own page, read to the point where the platform's answer is on it. */
const openSite = async (behaviour: Parameters<typeof serveSite>[0] = { site: THE_SITE }) => {
  const served = await serveSite(behaviour);
  const mounted = await open(paths.site(THE_SITE.id as string), /./);
  await waitFor(() => {
    expect(urlField().value).toBe(THE_SITE.url);
  });
  return { ...served, ...mounted };
};

/** Everything the screen says, as one string, for a sentence broken across elements. */
const said = (): string => screen.getByRole('main').textContent ?? '';

const urlField = (): HTMLInputElement =>
  screen.getByLabelText('The URL the feature starts on') as HTMLInputElement;

const removeButton = (): HTMLButtonElement =>
  within(screen.getByRole('main')).getByRole('button', {
    name: 'Remove this site',
  }) as HTMLButtonElement;

/** The three figures the platform served, as one line. */
const FIGURES = `${SERVED_CAPS.agents} agents per run allowed · ${SERVED_CAPS.runs} runs an hour · ${SERVED_CAPS.browsers} browsers at a time`;

/**
 * The vocabulary this product used to prove a site with, in one place.
 *
 * Not the words _prove_ and _proof_ themselves: the screen says there is nothing to prove
 * about a site, and names the GitHub App installation as the only proof of control it asks
 * for — which is the prototype's own wording. What may not survive anywhere is a state, a
 * method, a token or a check.
 */
const PROOF_WORDS =
  /verif|unverified|site-verification|TXT record|meta tag|well-known|check the (record|page|file|connection)/i;

/** jsdom answers every media query `false`; this makes the motion one answer `true`. */
const prefersReducedMotion = (): void => {
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
};

beforeEach(loadDesignTokens);
afterEach(() => {
  forgetRuns();
  clearSiteCache();
});

describe('adding a site', () => {
  it('asks for the URL alone, and nothing about proving it', async () => {
    await serveSite();
    await openNew();

    expect(urlField()).toBeTruthy();
    expect(said()).toMatch(/A site is a URL and nothing more/);
    expect(said()).not.toMatch(PROOF_WORDS);
    // The one button on the empty screen is the one that adds the site.
    expect(
      within(screen.getByRole('main'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Add the site']);
  });

  it('creates the site and lands on that site’s own page', async () => {
    const served = await serveSite({ site: { ...THE_SITE, id: CREATED_SITE_ID } });
    const { router } = await openNew();

    await userEvent.type(urlField(), THE_SITE.url);
    await userEvent.click(screen.getByRole('button', { name: 'Add the site' }));

    expect(served.created()).toEqual([THE_SITE.url]);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.site(CREATED_SITE_ID));
    });
    // The created site's own page: its URL as the heading, and the figures it is bound by.
    await screen.findByRole('heading', { level: 1, name: THE_HEADING });
    expect(urlField().value).toBe(THE_SITE.url);
    expect(said()).toContain(FIGURES);
  });

  it.each([
    ['a URL with no scheme', 'app.clipforge.example'],
    ['a URL that is not one', 'not a url at all'],
    ['a URL already in this workspace', 'https://beta.clipforge.example/create'],
  ])('refuses %s against the field, and creates nothing', async (_what, typed) => {
    const refuse = `"${typed}" is not a site this workspace can add`;
    await serveSite({ create: { refuse } });
    const { router } = await openNew();

    await userEvent.type(urlField(), typed);
    await userEvent.click(screen.getByRole('button', { name: 'Add the site' }));

    await waitFor(() => {
      expect(screen.getByText(refuse)).toBeTruthy();
    });
    expect(urlField().getAttribute('aria-invalid')).toBe('true');
    // Nothing was created: the screen is still the one that asks for a URL, and what was
    // typed is still in the field.
    expect(router.state.location.pathname).toBe(paths.newSite);
    expect(urlField().value).toBe(typed);
  });

  it('takes the refusal off the field as the reader retypes the URL', async () => {
    const refuse = '"app.clipforge.example" is not a whole web address';
    await serveSite({ create: { refuse } });
    await openNew();

    await userEvent.type(urlField(), 'app.clipforge.example');
    await userEvent.click(screen.getByRole('button', { name: 'Add the site' }));
    await waitFor(() => {
      expect(screen.getByText(refuse)).toBeTruthy();
    });

    await userEvent.type(urlField(), '/create');

    expect(screen.queryByText(refuse)).toBeNull();
    expect(urlField().getAttribute('aria-invalid')).toBe('false');
  });

  it('says a refusal that names no field above the form, rather than nowhere', async () => {
    await serveSite({ create: { refuse: 'that workspace already holds the most sites it may' } });
    await openNew();

    await userEvent.type(urlField(), THE_SITE.url);
    await userEvent.click(screen.getByRole('button', { name: 'Add the site' }));

    // The fixture refuses against `url`; a message the field cannot show would otherwise be
    // a button that does nothing when it is pressed.
    await waitFor(() => {
      expect(screen.getByText('that workspace already holds the most sites it may')).toBeTruthy();
    });
  });
});

describe('the site’s own page', () => {
  it('heads the page with the URL, and states it read-only in the field', async () => {
    await openSite();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(THE_HEADING);
    expect(urlField().readOnly).toBe(true);
    expect(urlField().value).toBe(THE_SITE.url);
    // No route updates a site's URL (#269), so the page says what to do instead.
    expect(said()).toContain('To test a different URL, add another site.');
  });

  it('breadcrumbs back to the list it came from', async () => {
    await openSite();

    const back = within(screen.getByRole('main')).getByRole('link', { name: 'Sites' });
    expect(back.getAttribute('href')).toBe(paths.sites);
  });

  it('states when the site was added, and the test it last ran', async () => {
    await openSite({
      site: { ...THE_SITE, lastTest: { runId: FIXTURE_RUN_ID, at: '2026-11-03T09:12:00.000Z' } },
    });

    const instant = (at: string, withTime: boolean): string =>
      new Intl.DateTimeFormat('en-US', {
        day: 'numeric',
        month: 'short',
        ...(withTime
          ? { hour: '2-digit' as const, minute: '2-digit' as const, hour12: false }
          : {}),
      }).format(new Date(at));

    expect(said()).toContain(
      `Added ${instant(THE_SITE.createdAt as string, false)} · last test ${instant('2026-11-03T09:12:00.000Z', true)}.`,
    );
  });

  it('claims nothing about tests for a site the platform has none on record for', async () => {
    // Not "no tests yet": the platform reads `lastTest` off a ledger trimmed to the last
    // day, so an absent value is nothing on record rather than a site never tested.
    await openSite();

    expect(said()).not.toMatch(/no tests? yet/i);
    expect(said()).not.toMatch(/never been tested/i);
    expect(said()).toMatch(/^.*Added \w{3} \d{1,2}\. To test a different URL/s);
  });

  it('states the figures the platform served, and no figure of its own', async () => {
    await openSite();

    expect(said()).toContain(FIGURES);
  });

  it('prints whatever the platform answers, so no cap is written into this screen', async () => {
    // Not the product's figures and not the fixture's default either: if these three
    // numbers reach the page, nothing on it is holding a number of its own.
    await openSite({ site: { ...THE_SITE, caps: { agents: 73, runs: 9, browsers: 2 } } });

    expect(said()).toContain('73 agents per run allowed · 9 runs an hour · 2 browsers at a time');
  });

  it('says a cap of one as one, rather than pluralising a figure it was handed', async () => {
    await openSite({ site: { ...THE_SITE, caps: { agents: 1, runs: 1, browsers: 1 } } });

    expect(said()).toContain('1 agent per run allowed · 1 run an hour · 1 browser at a time');
  });

  it('points at the GitHub App as the one thing Improve my site needs', async () => {
    await openSite();

    const footnote = screen.getByText(/needs the PersonaVision app installed/);
    expect(footnote.textContent).toContain('the only proof of control this product asks for');
    expect(
      within(footnote).getByRole('link', { name: 'Connect GitHub' }).getAttribute('href'),
    ).toBe(paths.githubSettings);
  });

  it('offers nothing to prove, in any state of the screen', async () => {
    await openSite();

    expect(said()).not.toMatch(PROOF_WORDS);
    // And no second heading: the page's own is the only one on it.
    expect(screen.getAllByRole('heading').map((heading) => heading.tagName)).toEqual(['H1']);
  });
});

describe('removing the site', () => {
  it('asks the platform to remove it, and goes back to the list', async () => {
    const served = await openSite();
    const { router } = served;

    await userEvent.click(removeButton());

    await waitFor(() => {
      expect(served.removed()).toEqual([THE_SITE.id]);
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.sites);
    });
  });

  it('takes no second press while the first is in flight', async () => {
    const served = await openSite({ site: THE_SITE, removal: { hold: true } });

    await userEvent.click(removeButton());
    await waitFor(() => {
      expect(removeButton().disabled).toBe(true);
    });

    served.releaseRemoval();
    await waitFor(() => {
      expect(served.router.state.location.pathname).toBe(paths.sites);
    });
    expect(served.removed()).toEqual([THE_SITE.id]);
  });

  it('keeps the page standing and says why when the platform refuses', async () => {
    const refusal = 'That site is running a test right now.';
    const served = await openSite({
      site: THE_SITE,
      removal: { answers: { status: 409, body: { error: refusal } } },
    });

    await userEvent.click(removeButton());

    const notice = await waitFor(() => screen.getByRole('alert'));
    expect(notice.textContent).toBe(refusal);
    // The platform answered, so nothing here says it is away or asks the reader to wait.
    expect(notice.textContent).not.toContain('try again when it is back');
    expect(served.router.state.location.pathname).toBe(paths.site(THE_SITE.id as string));
    expect(urlField().value).toBe(THE_SITE.url);
  });

  it('says one sentence when the platform cannot be reached at all', async () => {
    await openSite({ site: THE_SITE, removal: { unreachable: true } });

    await userEvent.click(removeButton());

    const notice = await waitFor(() => screen.getByRole('alert'));
    expect(notice.textContent).toContain('That site could not be removed.');
    expect(notice.textContent).toContain('Try again when it is back.');
    expect(urlField().value).toBe(THE_SITE.url);
  });
});

describe('the states of the screen', () => {
  it('renders the frame and a disabled field while the site is read', async () => {
    const served = await serveSite({ site: THE_SITE, hold: true });
    await open(paths.site(THE_SITE.id as string), 'Site');

    // The frame: the breadcrumb, the heading, the lede, the form and the row of figures —
    // with the field disabled, and no address invented in it.
    expect(urlField().disabled).toBe(true);
    expect(urlField().value).toBe('');
    expect(removeButton().disabled).toBe(true);
    expect(said()).toMatch(/A site is a URL and nothing more/);

    served.release();
    await waitFor(() => {
      expect(urlField().value).toBe(THE_SITE.url);
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(THE_HEADING);
  });

  it('says so when the site cannot be read, rather than rendering an empty page', async () => {
    await serveSite({ site: THE_SITE, unreachable: true });
    await open(paths.site(THE_SITE.id as string), 'Site');

    const notice = await waitFor(() => screen.getByRole('alert'));
    expect(notice.textContent).toBe(
      'That site could not be read. Failed to fetch Try again when it is back.',
    );
    // Nothing was typed on this screen, so the sentence promises nothing about that.
    expect(notice.textContent).not.toContain('Nothing you typed');
    // The frame stands, with nothing invented in the field.
    expect(urlField().value).toBe('');
    expect(urlField().disabled).toBe(true);
  });

  it('says a path naming no site names none, and offers the way back', async () => {
    await serveSite({ site: null });
    await open(paths.site('site-gone'), 'No site with that id');

    expect(said()).toContain('This workspace has no site at');
    expect(screen.getByRole('link', { name: 'Back to your sites' })).toBeTruthy();
  });

  it('is complete and still under prefers-reduced-motion: reduce', async () => {
    prefersReducedMotion();
    await openSite();

    // Nothing on this screen is an animated reveal, so everything a reader came for is
    // there: the URL, the figures, the footnote and the button that removes it.
    expect(urlField().value).toBe(THE_SITE.url);
    expect(said()).toContain(FIGURES);
    expect(removeButton().disabled).toBe(false);
    // And nothing is left pulsing on a page that has everything on it. The transitions the
    // shadcn primitives carry are theirs, and `site.module.css` declares no animation at
    // all — `stylesheet.test.ts` holds that end of it.
    expect(screen.getByRole('main').innerHTML).not.toMatch(/\banimate-/);
  });

  it('sets no inline style, so every value comes from the stylesheet and the tokens', async () => {
    const { container } = await openSite();

    expect([...container.querySelectorAll('[style]')]).toHaveLength(0);
  });

  it('is operable by keyboard: the field and the button are both reached', async () => {
    await openSite();

    for (let presses = 0; presses < 40 && document.activeElement !== urlField(); presses += 1) {
      await userEvent.tab();
    }
    expect(document.activeElement).toBe(urlField());
    await userEvent.tab();
    expect(document.activeElement).toBe(removeButton());
  });

  it('passes axe, on the empty screen, while reading, and on a site', async () => {
    await serveSite();
    const { unmount } = await openNew();
    expect(describeViolations(await axeViolations(screen.getByRole('main')))).toBe('');
    unmount();

    const held = await serveSite({ site: THE_SITE, hold: true });
    const reading = await open(paths.site(THE_SITE.id as string), 'Site');
    expect(describeViolations(await axeViolations(screen.getByRole('main')))).toBe('');
    held.release();
    reading.unmount();

    await openSite();
    expect(describeViolations(await axeViolations(screen.getByRole('main')))).toBe('');
  });
});
