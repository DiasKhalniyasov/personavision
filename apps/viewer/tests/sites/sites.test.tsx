// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../setup';
import { axeViolations, describeViolations } from '../axe';
import { forgetRuns, mountApp } from '../app';
import {
  A_VERIFIED_SITE,
  AN_UNVERIFIED_SITE,
  FIXTURE_RUN_ID,
  FIXTURE_RUN_NAME,
  SERVED_CAPS,
  serveSites,
} from './fixture';
import { paths } from '../../src/shell/paths';
import { signOut } from '../../src/shell/useSession';
import { clearSiteCache } from '../../src/sites/useSites';

/**
 * `/sites` — which of my sites can I test, and which are proved mine? (#267)
 *
 * The screen contract is `#screen-sites` of `docs/design/prototype.html`, and what is
 * asserted here is what a reader sees: the figures that bind each site, where each card
 * goes, and that **no card states a smaller number for being unverified** — decision 71, as
 * the owner settled it on 2026-11-03.
 *
 * Every figure comes from the fixture's served answer, which is deliberately not the
 * product's own: `packages/platform/src/caps.ts` is the only place the caps are defined, so
 * a screen that agreed with this suite by accident would be a screen printing a number it
 * holds itself.
 */

const open = async () => {
  const mounted = mountApp(paths.sites);
  await screen.findByRole('heading', { level: 1, name: 'Your sites' });
  return mounted;
};

/**
 * The cards of this screen, which are links: a site's, and the way in to adding one.
 *
 * Scoped to the screen rather than to the document: the product chrome around it is full of
 * links of its own, and this suite is about the screen.
 */
const cards = (): HTMLElement[] => [
  ...screen.getByRole('main').querySelectorAll<HTMLElement>('a[href]'),
];

/** Everything the screen says, as one string, for a sentence broken across elements. */
const said = (): string => screen.getByRole('main').textContent ?? '';

/** One site's card, by the address it is headed with. */
const cardFor = (name: string): HTMLElement => {
  const heading = screen.getByRole('heading', { level: 2, name });
  return heading.closest('a') as HTMLElement;
};

/** The lines of figures on a card, in the order they are drawn. */
const factsOf = (card: HTMLElement): string[] =>
  [...card.querySelectorAll('div > span')].map((line) => line.textContent ?? '');

const addCard = (): HTMLElement => cardFor('+ Add a site');

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

describe('the sites of the workspace', () => {
  it('lists each site with its address, how it stands and what binds it', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE, AN_UNVERIFIED_SITE] });
    await open();

    await waitFor(() => {
      expect(cardFor('app.clipforge.example')).toBeTruthy();
    });
    expect(cardFor('beta.clipforge.example/create')).toBeTruthy();
  });

  it('says how a verified site was verified and when', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE] });
    await open();

    const card = await waitFor(() => cardFor('app.clipforge.example'));
    expect(within(card).getByText(/^Verified by DNS · [A-Z][a-z]{2} \d{1,2}$/)).toBeTruthy();
  });

  it('names the test a site last ran, in the words that test was asked for', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE] });
    await open();

    const card = await waitFor(() => cardFor('app.clipforge.example'));
    await waitFor(() => {
      expect(
        within(card).getByText(
          new RegExp(
            `^Last test: ${FIXTURE_RUN_NAME.replace('.', '\\.')} · \\w{3} \\d{1,2} \\d{2}:\\d{2}$`,
          ),
        ),
      ).toBeTruthy();
    });
  });

  it('says nothing about tests for a site the platform has none on record for', async () => {
    await serveSites({ sites: [AN_UNVERIFIED_SITE] });
    await open();

    // Not "no test yet": the platform reads `lastTest` off a ledger trimmed to the last
    // day, so an absent value is nothing on record rather than a site never tested, and a
    // card that claimed otherwise could contradict a test still in the reader's own list.
    const card = await waitFor(() => cardFor('beta.clipforge.example/create'));
    expect(within(card).queryByText(/test/i)).toBeNull();
    expect(factsOf(card)).toEqual([
      `${SERVED_CAPS.agents} agents per run allowed`,
      `${SERVED_CAPS.runs} runs an hour · ${SERVED_CAPS.browsers} browsers at a time`,
      'Verify it to unlock Improve my site',
    ]);
  });

  it('marks the site the workspace’s most recent test ran against, and only that one', async () => {
    await serveSites({
      sites: [A_VERIFIED_SITE, AN_UNVERIFIED_SITE],
    });
    await open();

    await waitFor(() => {
      expect(cardFor('app.clipforge.example').getAttribute('aria-current')).toBe('true');
    });
    expect(cardFor('beta.clipforge.example/create').getAttribute('aria-current')).toBeNull();
  });
});

describe('what each site is allowed', () => {
  it('states the agents, the runs an hour and the browsers at a time, from the platform', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE] });
    await open();

    const card = await waitFor(() => cardFor('app.clipforge.example'));
    const facts = factsOf(card);
    expect(facts[0]).toBe(`${SERVED_CAPS.agents} agents per run allowed`);
    expect(facts[1]).toBe(
      `${SERVED_CAPS.runs} runs an hour · ${SERVED_CAPS.browsers} browsers at a time`,
    );
  });

  it('prints whatever the platform answers, so no cap is written into this screen', async () => {
    // Not the product's figures and not the fixture's default either: if these three
    // numbers reach the card, nothing on the screen is holding a number of its own.
    await serveSites({
      sites: [{ ...A_VERIFIED_SITE, caps: { agents: 73, runs: 9, browsers: 2 } }],
    });
    await open();

    const card = await waitFor(() => cardFor('app.clipforge.example'));
    const facts = factsOf(card);
    expect(facts[0]).toBe('73 agents per run allowed');
    expect(facts[1]).toBe('9 runs an hour · 2 browsers at a time');
  });

  it('says a cap of one as one, rather than pluralising a figure it was handed', async () => {
    await serveSites({
      sites: [{ ...A_VERIFIED_SITE, caps: { agents: 1, runs: 1, browsers: 1 } }],
    });
    await open();

    const card = await waitFor(() => cardFor('app.clipforge.example'));
    const facts = factsOf(card);
    expect(facts[0]).toBe('1 agent per run allowed');
    expect(facts[1]).toBe('1 run an hour · 1 browser at a time');
  });

  it('reads the same figures on an unverified site as on a verified one', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE, AN_UNVERIFIED_SITE] });
    await open();

    await waitFor(() => {
      expect(cardFor('app.clipforge.example')).toBeTruthy();
    });
    const verified = factsOf(cardFor('app.clipforge.example'));
    const unverified = factsOf(cardFor('beta.clipforge.example/create'));

    expect(unverified.slice(0, 2)).toEqual(verified.slice(0, 2));
  });

  it('offers verification for what it is worth, and never as permission to test', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE, AN_UNVERIFIED_SITE] });
    await open();

    const card = await waitFor(() => cardFor('beta.clipforge.example/create'));
    expect(factsOf(card)).toContain('Verify it to unlock Improve my site');
    // And nowhere on the screen is a figure held back for being unverified.
    expect(said().toLowerCase()).not.toContain('until this site is verified');
    expect(said()).not.toContain(`of ${SERVED_CAPS.agents} agents`);
  });

  it('says both facts about a verified site whose last check now fails', async () => {
    // Decision 89, settled as _it stays verified, and the card also says what the last
    // check found_: a removed record never costs a site its caps, and the reader decides.
    await serveSites({
      sites: [
        {
          ...A_VERIFIED_SITE,
          lastCheck: {
            passed: false,
            sentence: 'no TXT record found on clipforge.example',
            checkedAt: '2026-11-04T09:04:00.000Z',
          },
        },
      ],
    });
    await open();

    const card = await waitFor(() => cardFor('app.clipforge.example'));
    expect(within(card).getByText(/^Verified by DNS · /)).toBeTruthy();
    expect(
      within(card).getByText(
        /^Last check: no TXT record found on clipforge\.example at \w{3} \d{1,2} \d{2}:\d{2}\.$/,
      ),
    ).toBeTruthy();
  });

  it('says nothing about a check that passed: the state above it already does', async () => {
    await serveSites({
      sites: [
        {
          ...A_VERIFIED_SITE,
          lastCheck: {
            passed: true,
            sentence: 'the TXT record was there',
            checkedAt: '2026-11-04T09:04:00.000Z',
          },
        },
      ],
    });
    await open();

    const card = await waitFor(() => cardFor('app.clipforge.example'));
    expect(within(card).queryByText(/Last check/)).toBeNull();
  });
});

describe('where the cards go', () => {
  it('sends the add-a-site card to /sites/new', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE] });
    const { router } = await open();

    await userEvent.click(addCard());
    expect(router.state.location.pathname).toBe(paths.newSite);
  });

  it('sends a site’s card to that site', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE] });
    const { router } = await open();

    await userEvent.click(await waitFor(() => cardFor('app.clipforge.example')));
    expect(router.state.location.pathname).toBe(paths.site(A_VERIFIED_SITE.id as string));
  });

  it('builds both addresses through the route table rather than writing them', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE] });
    await open();

    await waitFor(() => {
      expect(cardFor('app.clipforge.example').getAttribute('href')).toBe(
        paths.site(A_VERIFIED_SITE.id as string),
      );
    });
    expect(addCard().getAttribute('href')).toBe(paths.newSite);
  });
});

describe('a workspace with no sites', () => {
  it('renders the heading, the lede and the add-a-site card alone', async () => {
    await serveSites({ sites: [] });
    const { container } = await open();

    await waitFor(() => {
      expect(cards()).toHaveLength(1);
    });
    expect(addCard()).toBeTruthy();
    expect(screen.getByText(/A site is a URL in this workspace\./)).toBeTruthy();
    // No grid around one card, and no count of what is not there.
    expect(container.querySelector('[class*="siteGrid"]')).toBeNull();
    expect(said()).not.toMatch(/\b0\b/);
  });

  it('states the footnote whether or not the workspace has a site', async () => {
    await serveSites({ sites: [] });
    await open();

    expect(said()).toContain(
      'Connecting a GitHub repository counts as verification for the site that repository' +
        ' deploys, and is what unlocks Improve my site.',
    );
  });
});

describe('a site in one workspace is never listed in another', () => {
  it('lists exactly what this workspace’s /sites answered, and nothing else', async () => {
    // Asserted over the route and not over internals: the screen renders the answer to
    // `GET /sites`, which `packages/platform` scopes to the session's own workspace
    // (`packages/platform/test/sites.test.ts` holds that end of it over HTTP). A card for a
    // site the route did not name could only come from the screen inventing one.
    await serveSites({ sites: [AN_UNVERIFIED_SITE] });
    await open();

    await waitFor(() => {
      expect(cards()).toHaveLength(2);
    });
    expect(
      cards().map((card) => within(card).getByRole('heading', { level: 2 }).textContent),
    ).toEqual(['beta.clipforge.example/create', '+ Add a site']);
  });

  it('asks for this workspace’s sites and nothing about another', async () => {
    const served = await serveSites({ sites: [A_VERIFIED_SITE] });
    await open();

    await waitFor(() => {
      expect(served.reads()).toBe(1);
    });
    // One read while the app is open, and no site id in it: the list is the workspace's.
    expect(served.reads()).toBe(1);
  });
});

describe('the sites belong to the session that read them', () => {
  it('forgets them when the session changes hands, so the next one reads its own', async () => {
    const served = await serveSites({ sites: [A_VERIFIED_SITE] });
    await open();
    await waitFor(() => {
      expect(served.reads()).toBe(1);
    });

    // The list is read once while the app is open, which is the point of the cache — and
    // the thing that would otherwise hand the next person at this browser the addresses,
    // verification states and caps of the workspace that just left.
    cleanup();
    await signOut();
    await open();

    await waitFor(() => {
      expect(served.reads()).toBe(2);
    });
  });
});

describe('while the platform is being read', () => {
  it('renders the frame and skeletons, and the add-a-site card is already there', async () => {
    const served = await serveSites({ sites: [A_VERIFIED_SITE], hold: true });
    const { container } = await open();

    expect(screen.getByRole('status').textContent).toBe('Reading your sites…');
    expect(container.querySelectorAll('[data-loading="site"]')).toHaveLength(2);
    expect(addCard()).toBeTruthy();

    served.release();
    await waitFor(() => {
      expect(cardFor('app.clipforge.example')).toBeTruthy();
    });
  });

  it('does not move the page when the sites arrive', async () => {
    const served = await serveSites({ sites: [A_VERIFIED_SITE, AN_UNVERIFIED_SITE], hold: true });
    const { container } = await open();

    const grid = container.querySelector('[class*="siteGrid"]') as HTMLElement;
    // The placeholders stand in a grid of the same shape, in the same place on the page:
    // two cards and the one for adding a site, which is already there.
    const cells = grid.children.length;
    expect(cells).toBe(3);
    const before = said();

    served.release();
    await waitFor(() => {
      expect(cardFor('app.clipforge.example')).toBeTruthy();
    });

    // The same grid element, with the same number of cells in it, and the words around it
    // unchanged: nothing above or below the cards has appeared or gone away.
    expect(container.querySelector('[class*="siteGrid"]')).toBe(grid);
    expect(grid.children).toHaveLength(cells);
    expect(before).toContain('Your sites');
    expect(said().startsWith('Your sites')).toBe(true);
    expect(said()).toContain('Connecting a GitHub repository counts as verification');
  });
});

describe('a platform that cannot be read', () => {
  it('says so in one sentence and still offers the add-a-site card', async () => {
    await serveSites({ unreachable: true });
    await open();

    const said = await waitFor(() => screen.getByRole('alert'));
    expect(said.textContent).toContain('Your sites could not be read.');
    expect(addCard()).toBeTruthy();
    expect(cards()).toHaveLength(1);
  });

  it('names the status when the platform answers one, rather than a shrug', async () => {
    await serveSites({ answers: { status: 503, body: {} } });
    await open();

    const said = await waitFor(() => screen.getByRole('alert'));
    expect(said.textContent).toBe('Your sites could not be read. It answered 503.');
  });

  it('says what it could not read when the answer is not a list of sites', async () => {
    await serveSites({ answers: { status: 200, body: { sites: [{ id: 'half-a-site' }] } } });
    await open();

    const said = await waitFor(() => screen.getByRole('alert'));
    expect(said.textContent).toContain('sites.0.url');
  });
});

describe('the screen itself', () => {
  it('passes axe, with the sites listed', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE, AN_UNVERIFIED_SITE] });
    const { container } = await open();
    await waitFor(() => {
      expect(cardFor('app.clipforge.example')).toBeTruthy();
    });

    const violations = await axeViolations(container);
    expect(describeViolations(violations)).toBe('');
  });

  it('passes axe while the platform is being read', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE], hold: true });
    const { container } = await open();

    expect(describeViolations(await axeViolations(container))).toBe('');
  });

  it('passes axe on a workspace with no sites', async () => {
    await serveSites({ sites: [] });
    const { container } = await open();

    expect(describeViolations(await axeViolations(container))).toBe('');
  });

  it('is operable by keyboard: the cards take focus in the order they are drawn', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE, AN_UNVERIFIED_SITE] });
    await open();
    await waitFor(() => {
      expect(cardFor('app.clipforge.example')).toBeTruthy();
    });

    const [first, ...rest] = cards();
    // Tabbed to rather than focused directly: what is asserted is that the keyboard
    // reaches them at all, through the chrome's own links, and then in which order.
    for (let presses = 0; presses < 40 && document.activeElement !== first; presses += 1) {
      await userEvent.tab();
    }
    expect(document.activeElement).toBe(first);
    for (const card of rest) {
      await userEvent.tab();
      expect(document.activeElement).toBe(card);
    }
    // And each of them takes the app's one focus ring, which is a token's.
    expect(cards().map((card) => card.tagName)).toEqual(cards().map(() => 'A'));
  });

  it('puts one heading under the page’s own on each card, so the order does not skip', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE, AN_UNVERIFIED_SITE] });
    await open();
    await waitFor(() => {
      expect(cardFor('app.clipforge.example')).toBeTruthy();
    });

    expect(screen.getAllByRole('heading').map((heading) => heading.tagName)).toEqual([
      'H1',
      'H2',
      'H2',
      'H2',
    ]);
  });

  it('sets no inline style, so every value comes from the stylesheet and the tokens', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE, AN_UNVERIFIED_SITE] });
    const { container } = await open();
    await waitFor(() => {
      expect(cardFor('app.clipforge.example')).toBeTruthy();
    });

    expect([...container.querySelectorAll('[style]')]).toHaveLength(0);
  });

  it('is complete and still for a reader who has asked for reduced motion', async () => {
    await serveSites({ sites: [A_VERIFIED_SITE, AN_UNVERIFIED_SITE] });
    prefersReducedMotion();
    await open();

    // Every card, every figure, nothing deferred to an animation that will not play.
    await waitFor(() => {
      expect(cardFor('app.clipforge.example')).toBeTruthy();
    });
    expect(factsOf(cardFor('app.clipforge.example'))[0]).toContain('agents per run allowed');
    expect(cards()).toHaveLength(3);
    // And nothing the screen itself renders declares an animation or a transition. The
    // chrome around it is its own ticket's, and the tokens zero every duration here.
    expect(screen.getByRole('main').innerHTML).not.toMatch(/animation|transition-|\banimate-/);
  });

  it('still names a site’s test when another entry in the listing has no id', async () => {
    // One unusable entry costs the reader nothing: it addresses no run, so it is dropped,
    // and the listing either side of it is still what names a test on a card.
    await serveSites({
      sites: [A_VERIFIED_SITE],
      files: {
        '/runs/index.json': JSON.stringify([
          { name: 'A test with no id', createdAt: '2026-11-04T00:00:00.000Z' },
          { runId: FIXTURE_RUN_ID, name: FIXTURE_RUN_NAME, createdAt: '2026-10-24T14:02:00.000Z' },
        ]),
      },
    });
    await open();

    const card = await waitFor(() => cardFor('app.clipforge.example'));
    await waitFor(() => {
      expect(factsOf(card).at(-1)).toContain(`Last test: ${FIXTURE_RUN_NAME}`);
    });
  });

  it('reads the workspace’s run listing once, however many sites name a test', async () => {
    const served = await serveSites({
      sites: [
        A_VERIFIED_SITE,
        { ...AN_UNVERIFIED_SITE, lastTest: { runId: FIXTURE_RUN_ID, at: '2026-11-03T09:12:00Z' } },
      ],
    });
    const data = await open();
    await waitFor(() => {
      expect(cardFor('app.clipforge.example')).toBeTruthy();
    });

    // One listing for the whole screen, rather than one `run.json` per site: the figure
    // this would otherwise cost grows with the number of sites a workspace has.
    expect(served.reads()).toBe(1);
    expect(data.container.querySelectorAll('[class*="siteCard"]').length).toBeGreaterThan(0);
  });
});
