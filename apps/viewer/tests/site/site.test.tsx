// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../setup';
import { axeViolations, describeViolations } from '../axe';
import { forgetRuns, mountApp } from '../app';
import { CREATED_SITE_ID, serveSite, THE_SITE, THE_TOKEN } from './fixture';
import { SERVED_CAPS } from '../sites/fixture';
import { paths } from '../../src/shell/paths';
import { clearSiteCache } from '../../src/sites/useSites';

/**
 * `/sites/new` and `/sites/:siteId` — what the URL is, and how I prove it is mine. (#269)
 *
 * The screen contract is `#screen-site` of `docs/design/prototype.html`, and what is
 * asserted here is what a reader sees: the four methods with the exact line to copy, a
 * check that is run **by the platform**, and a failed check that says what it looked for,
 * where, and what it found instead — never "something went wrong".
 *
 * Every figure comes from the fixture's served answer, which is deliberately not the
 * product's own: `packages/platform/src/caps.ts` is the only place the caps are defined, so
 * a screen that agreed with this suite by accident would be a screen printing a number it
 * holds itself.
 */

/**
 * The screen, by the question it is answering: `/sites/new` is still _Add a site_ — the
 * route table's own name for it, which `tests/routes.test.tsx` pins — and it becomes the
 * prototype's `.pagehead` the moment there is a site to prove.
 */
const open = async (path: string, heading = 'Prove this site is yours') => {
  const mounted = mountApp(path);
  await screen.findByRole('heading', { level: 1, name: heading });
  return mounted;
};

const openNew = async () => open(paths.newSite, 'Add a site');

/** One method's block, by the heading `#screen-site` gives it. */
const blockFor = (heading: string): HTMLElement => {
  const title = screen.getByRole('heading', { level: 2, name: heading });
  return title.closest('section') as HTMLElement;
};

/** The exact line to copy inside a method's block, as a reader would copy it. */
const lineIn = (heading: string): string =>
  blockFor(heading).querySelector('code')?.textContent ?? '';

/** Everything the screen says, as one string, for a sentence broken across elements. */
const said = (): string => screen.getByRole('main').textContent ?? '';

const HEADINGS = ['DNS TXT record', 'Meta tag', 'File', 'Connect the GitHub repository'];

const urlField = (): HTMLInputElement =>
  screen.getByLabelText('The URL the feature starts on') as HTMLInputElement;

const FAILED = {
  passed: false,
  sentence: 'no TXT record found on beta.clipforge.example or clipforge.example',
  checkedAt: '2026-11-03T09:04:00.000Z',
} as const;

const PASSED = {
  passed: true,
  sentence: 'the TXT record on clipforge.example has this token',
  checkedAt: '2026-11-03T09:11:00.000Z',
} as const;

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
  it('asks for the URL alone, and offers the four methods only once the site exists', async () => {
    await serveSite();
    await openNew();

    expect(urlField()).toBeTruthy();
    for (const heading of HEADINGS) {
      expect(screen.queryByRole('heading', { level: 2, name: heading })).toBeNull();
    }
    expect(said()).toContain('The four ways to prove it appear once the site is added.');
  });

  it('creates the site and shows that site’s verification screen', async () => {
    const served = await serveSite({ site: { ...THE_SITE, id: CREATED_SITE_ID } });
    await openNew();

    await userEvent.type(urlField(), 'https://beta.clipforge.example/create');
    await userEvent.click(screen.getByRole('button', { name: 'Add the site' }));

    expect(served.created()).toEqual(['https://beta.clipforge.example/create']);
    // The created site's own screen: the four methods, with its token in the lines to copy.
    await waitFor(() => {
      expect(lineIn('DNS TXT record')).toContain(THE_TOKEN);
    });
    expect(urlField().value).toBe('https://beta.clipforge.example/create');
  });

  it.each([
    ['a URL with no scheme', 'app.clipforge.example'],
    ['a URL that is not one', 'not a url at all'],
    ['a URL already in this workspace', 'https://beta.clipforge.example/create'],
  ])('refuses %s against the field, and creates nothing', async (_what, typed) => {
    const refuse = `"${typed}" is not a site this workspace can add`;
    await serveSite({ create: { refuse } });
    await openNew();

    await userEvent.type(urlField(), typed);
    await userEvent.click(screen.getByRole('button', { name: 'Add the site' }));

    await waitFor(() => {
      expect(screen.getByText(refuse)).toBeTruthy();
    });
    expect(urlField().getAttribute('aria-invalid')).toBe('true');
    // Nothing was created: the screen is still the one that asks for a URL, and what was
    // typed is still in the field.
    expect(screen.queryByRole('heading', { level: 2, name: 'DNS TXT record' })).toBeNull();
    expect(urlField().value).toBe(typed);
  });
});

describe('how the site stands, and what binds it', () => {
  it('states the platform’s figures, and what verifying is worth', async () => {
    await serveSite({ site: THE_SITE });
    await open(paths.site(THE_SITE.id as string));

    await waitFor(() => {
      expect(screen.getByText('Unverified')).toBeTruthy();
    });
    expect(said()).toContain(
      `${SERVED_CAPS.agents} agents per run allowed · ${SERVED_CAPS.runs} runs an hour · ${SERVED_CAPS.browsers} browsers at a time`,
    );
    expect(said()).toContain('Testing is not held back · verifying unlocks Improve my site');
  });

  it('states the same figures for a verified site: nothing on this screen is gated', async () => {
    await serveSite({
      site: { ...THE_SITE, verified: { method: 'dns-txt', at: '2026-11-02T10:00:00.000Z' } },
    });
    await open(paths.site(THE_SITE.id as string));

    await waitFor(() => {
      expect(screen.getByText(/^Verified by DNS · /)).toBeTruthy();
    });
    // Decision 71, as the owner settled it on 2026-11-03: the caps protect the site being
    // driven, so they are the same three numbers a verified site states.
    expect(said()).toContain(
      `${SERVED_CAPS.agents} agents per run allowed · ${SERVED_CAPS.runs} runs an hour · ${SERVED_CAPS.browsers} browsers at a time`,
    );
    expect(said()).toContain('Improve my site is unlocked');
  });

  it('renders a site that was verified and no longer is as unverified, with the check that now fails', async () => {
    await serveSite({
      site: { ...THE_SITE, lastCheck: { ...FAILED, method: 'dns-txt' } },
    });
    await open(paths.site(THE_SITE.id as string));

    await waitFor(() => {
      expect(screen.getByText('Unverified')).toBeTruthy();
    });
    expect(
      within(blockFor('DNS TXT record')).getByText(/^Last check: no TXT record found/),
    ).toBeTruthy();
    expect(said()).not.toMatch(/Verified by/);
  });
});

describe('the four ways to prove it', () => {
  beforeEach(async () => {
    await serveSite({ site: THE_SITE });
    await open(paths.site(THE_SITE.id as string));
    await waitFor(() => {
      expect(lineIn('DNS TXT record')).toContain(THE_TOKEN);
    });
  });

  it('renders all four, in the order section 13 lists them', async () => {
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(HEADINGS);
  });

  it('prints the exact line to copy for each, with this site’s own token in it whole', () => {
    expect(lineIn('DNS TXT record')).toBe(
      `beta.clipforge.example.  TXT  "personavision-site-verification=${THE_TOKEN}"`,
    );
    expect(lineIn('Meta tag')).toBe(
      `<meta name="personavision-site-verification" content="${THE_TOKEN}">`,
    );
    expect(lineIn('File')).toBe(
      'https://beta.clipforge.example/.well-known/personavision-site-verification.txt',
    );
    // The token is a public proof of control, not a secret: nothing on this screen hides
    // part of it, because a line with an elided token in it is a line that does not work.
    expect(said()).not.toContain('…');
    expect(said()).not.toContain('pv_7f3c…');
  });

  it('leaves every line selectable and reachable from the keyboard', () => {
    for (const heading of ['DNS TXT record', 'Meta tag', 'File']) {
      const line = blockFor(heading).querySelector('code') as HTMLElement;
      expect(line.getAttribute('tabindex')).toBe('0');
    }
  });

  it('sends the GitHub method to the GitHub connection screen', () => {
    const connect = within(blockFor('Connect the GitHub repository')).getByRole('link', {
      name: 'Connect GitHub',
    });
    expect(connect.getAttribute('href')).toBe(paths.githubSettings);
  });
});

describe('a check', () => {
  const openSite = async (behaviour: Parameters<typeof serveSite>[0]) => {
    const served = await serveSite(behaviour);
    await open(paths.site(THE_SITE.id as string));
    await waitFor(() => {
      expect(lineIn('DNS TXT record')).toContain(THE_TOKEN);
    });
    return served;
  };

  it('is run by the platform, for the method whose button was pressed', async () => {
    const served = await openSite({ site: THE_SITE, checks: { 'meta-tag': FAILED } });

    await userEvent.click(
      within(blockFor('Meta tag')).getByRole('button', { name: 'Check the page' }),
    );

    await waitFor(() => {
      expect(served.checked()).toEqual(['meta-tag']);
    });
  });

  it('renders what a failed check looked for, where, and what it found, with the time it ran', async () => {
    await openSite({ site: THE_SITE, checks: { 'dns-txt': FAILED } });

    await userEvent.click(
      within(blockFor('DNS TXT record')).getByRole('button', { name: 'Check the record' }),
    );

    const block = blockFor('DNS TXT record');
    await waitFor(() => {
      expect(
        within(block).getByText(
          `Last check: ${FAILED.sentence} at ${new Intl.DateTimeFormat('en-US', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).format(new Date(FAILED.checkedAt))}.`,
        ),
      ).toBeTruthy();
    });
    // The failure is a result, not an error: the method says nothing generic about it, and
    // the screen raises no alert over a check that simply did not find what it looked for.
    expect(block.textContent ?? '').not.toMatch(
      /something went wrong|unexpected error|try again later/i,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('verifies the site in front of the reader when it passes, and names the method', async () => {
    await openSite({ site: THE_SITE, checks: { 'dns-txt': PASSED } });
    const figures = `${SERVED_CAPS.agents} agents per run allowed · ${SERVED_CAPS.runs} runs an hour · ${SERVED_CAPS.browsers} browsers at a time`;
    expect(said()).toContain(figures);

    await userEvent.click(
      within(blockFor('DNS TXT record')).getByRole('button', { name: 'Check the record' }),
    );

    await waitFor(() => {
      expect(screen.getByText(/^Verified by DNS · /)).toBeTruthy();
    });
    expect(said()).toContain('Improve my site is unlocked');
    // No cap figure moves, because none of them depends on verification.
    expect(said()).toContain(figures);
  });

  it('renders a GitHub connection as verification when the platform reports one', async () => {
    await openSite({ site: THE_SITE, checks: { 'connected-repository': PASSED } });

    await userEvent.click(
      within(blockFor('Connect the GitHub repository')).getByRole('button', {
        name: 'Check the connection',
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(/^Verified by the GitHub repository · /)).toBeTruthy();
    });
    expect(blockFor('Connect the GitHub repository').getAttribute('aria-current')).toBe('true');
  });

  it('pulses the method it is running on, and takes no second check while it runs', async () => {
    const served = await openSite({
      site: THE_SITE,
      checks: { 'dns-txt': { ...PASSED, hold: true } },
    });

    await userEvent.click(
      within(blockFor('DNS TXT record')).getByRole('button', { name: 'Check the record' }),
    );

    const block = blockFor('DNS TXT record');
    await waitFor(() => {
      expect(block.getAttribute('aria-busy')).toBe('true');
    });
    // The product's one moving thing, which the tokens stop under `prefers-reduced-motion`.
    expect(block.className).toContain('running');
    for (const button of within(screen.getByRole('main')).getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }

    served.releaseCheck();
    await waitFor(() => {
      expect(screen.getByText(/^Verified by DNS · /)).toBeTruthy();
    });
    expect(blockFor('DNS TXT record').getAttribute('aria-busy')).toBeNull();
  });

  it('says one sentence when the platform cannot be reached, and keeps the lines to copy', async () => {
    await openSite({
      site: THE_SITE,
      checks: { 'dns-txt': { ...FAILED, unreachable: true } },
    });

    await userEvent.click(
      within(blockFor('DNS TXT record')).getByRole('button', { name: 'Check the record' }),
    );

    const notice = await waitFor(() => screen.getByRole('alert'));
    expect(notice.textContent).toContain('could not be read');
    expect(lineIn('DNS TXT record')).toContain(THE_TOKEN);
    expect(lineIn('Meta tag')).toContain(THE_TOKEN);
  });
});

describe('the states of the screen', () => {
  it('renders the frame and the four methods with their buttons disabled while the site is read', async () => {
    const served = await serveSite({ site: THE_SITE, hold: true });
    await open(paths.site(THE_SITE.id as string));

    for (const heading of HEADINGS) {
      expect(screen.getByRole('heading', { level: 2, name: heading })).toBeTruthy();
    }
    // Scoped to the screen: the product chrome around it has buttons of its own.
    for (const button of within(screen.getByRole('main')).getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }

    served.release();
    await waitFor(() => {
      expect(lineIn('DNS TXT record')).toContain(THE_TOKEN);
    });
  });

  it('says so when the site cannot be read, rather than rendering an empty page', async () => {
    await serveSite({ site: THE_SITE, unreachable: true });
    await open(paths.site(THE_SITE.id as string));

    const notice = await waitFor(() => screen.getByRole('alert'));
    expect(notice.textContent).toContain('could not be read');
    expect(screen.getByRole('heading', { level: 2, name: 'DNS TXT record' })).toBeTruthy();
  });

  it('says a path naming no site names none, and offers the way back', async () => {
    await serveSite({ site: null });
    await open(paths.site('site-gone'));

    await waitFor(() => {
      expect(said()).toContain('This workspace has no site at');
    });
    expect(screen.getByRole('link', { name: 'Back to your sites' })).toBeTruthy();
  });

  it('is complete and still under prefers-reduced-motion: reduce', async () => {
    prefersReducedMotion();
    await serveSite({ site: { ...THE_SITE, lastCheck: { ...FAILED, method: 'dns-txt' } } });
    await open(paths.site(THE_SITE.id as string));

    // Nothing on this screen is an animated reveal, so everything a reader came for is
    // there: the state line, the four methods, every line to copy, and the failed check.
    await waitFor(() => {
      expect(lineIn('DNS TXT record')).toContain(THE_TOKEN);
    });
    expect(said()).toContain('Unverified');
    expect(said()).toContain(`Last check: ${FAILED.sentence}`);
    for (const heading of HEADINGS) {
      expect(screen.getByRole('heading', { level: 2, name: heading })).toBeTruthy();
    }
    for (const button of within(screen.getByRole('main')).getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('passes axe, on the empty screen and on a site with its four methods', async () => {
    await serveSite();
    const { unmount } = await openNew();
    expect(describeViolations(await axeViolations(screen.getByRole('main')))).toBe('');
    unmount();

    await serveSite({ site: { ...THE_SITE, lastCheck: { ...FAILED, method: 'dns-txt' } } });
    await open(paths.site(THE_SITE.id as string));
    await waitFor(() => {
      expect(lineIn('DNS TXT record')).toContain(THE_TOKEN);
    });
    expect(describeViolations(await axeViolations(screen.getByRole('main')))).toBe('');
  });
});
