// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp } from '../app';
import { paths, signInWithNext } from '../../src/shell/paths';
import { forgetSession } from '../../src/shell/useSession';
import { DEMO_ACCOUNT, SIGNIN_FAILED, servePlatform } from './platform';

/**
 * `/signin` — the screen the product starts on.
 *
 * What these tests hold is the ticket's own acceptance: the card on the dark band with the
 * two fields and the fresh-install line and no chrome at all; signing in landing on the
 * Verdict of the workspace's latest test with no list and no second form in between; the
 * two redirects, neither of them flashing the other screen; one vague sentence for a
 * refusal, announced, with what was typed still in the form; and a password that is in the
 * body of a POST and nowhere else.
 *
 * The server is `./platform`, which answers the three routes
 * `packages/platform/src/server/routes/auth.ts` mounts, so the screen is tested against
 * what the platform says rather than against a mocked module of its own.
 */

/** `/signin` with nothing overriding the session: the app reads `GET /auth/session` itself. */
const mountSignIn = (path: string = paths.signIn) => mountApp(path, { session: null });

const card = (): HTMLElement => document.querySelector<HTMLElement>('.signin-card')!;

const signInWith = async (email: string, password: string) => {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Work email'), email);
  await user.type(await screen.findByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
};

beforeEach(loadDesignTokens);
afterEach(() => {
  // The tree comes down before the shared session store is reset: Vitest runs the last
  // registered `afterEach` first, so `setup.ts`'s own `cleanup` would otherwise run after
  // this one and a still-mounted tree would ask for a session the next test has not
  // served yet. `cleanup` is idempotent, so the one in `setup.ts` then does nothing.
  cleanup();
  forgetRuns();
  forgetSession();
  vi.restoreAllMocks();
});

describe('the screen', () => {
  it('renders the card on the dark band, with both fields, the action and the fresh-install line', async () => {
    await servePlatform();
    mountSignIn();
    await screen.findByRole('button', { name: 'Sign in' });
    const form = within(card());

    // The band is `.strip-dark`, which `styles/base.css` declares from the tokens, so the
    // one dark band in the product is declared once.
    expect(document.querySelector('.signin-band')?.classList.contains('strip-dark')).toBe(true);
    expect(screen.getByText('PersonaVision')).toBeTruthy();
    expect(form.getByRole('heading', { level: 1, name: 'Sign in' })).toBeTruthy();
    expect(form.getByText('Test a change on your own audience before you ship it.')).toBeTruthy();
    expect(form.getByLabelText('Work email')).toBeTruthy();
    expect(form.getByLabelText('Password')).toBeTruthy();
    expect(form.getByRole('button', { name: 'Sign in' })).toBeTruthy();

    // The line a fresh installation's user needs: where their password was printed.
    expect(form.getByText(/the password printed by/)).toBeTruthy();
    expect(form.getByText('personavision serve')).toBeTruthy();
    expect(
      form.getByText('No card, no API key. Your tests and audiences stay in your workspace.'),
    ).toBeTruthy();
  });

  it('carries no product chrome: no workspace name, no test picker, no tabs, no badge', async () => {
    await servePlatform();
    mountSignIn();
    await screen.findByRole('button', { name: 'Sign in' });

    for (const slot of ['chrome', 'tabbar', 'workspace-name', 'account-menu']) {
      expect(document.querySelector(`[data-shell="${slot}"]`), slot).toBeNull();
    }
    expect(document.querySelector('.sim-badge')).toBeNull();
    expect(document.querySelectorAll('nav')).toHaveLength(0);
  });

  it('is operable by keyboard alone, from the first field to the action', async () => {
    await servePlatform();
    mountSignIn();
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Sign in' });

    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Work email'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sign in' }));
  });

  it('is clean under axe', async () => {
    await servePlatform();
    mountSignIn();
    await screen.findByRole('button', { name: 'Sign in' });

    const results = await axe.run(card(), { resultTypes: ['violations'] });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe('signing in', () => {
  it('lands on the Verdict of the workspace’s latest test, with no list and no second form', async () => {
    const platform = await servePlatform();
    const { router } = mountSignIn();

    await signInWith(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password);

    const latest = platform.runIds[0] as string;
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.run(latest));
    });
    // Zero clicks to the verdict: nothing in between asked the reader anything.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('.signin-card')).toBeNull();
  });

  it('returns to the exact URL a signed-out visit was sent here from', async () => {
    const platform = await servePlatform();
    const intended = `${paths.run(platform.runIds[0] as string)}?variant=B`;
    const { router } = mountSignIn(signInWithNext(intended));

    await signInWith(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password);

    await waitFor(() => {
      expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(intended);
    });
  });

  it.each([
    'https://elsewhere.example/phish',
    '//elsewhere.example/phish',
    '/\\elsewhere.example/phish',
    // This screen itself: signing in must not land back on the form it was done from.
    '/signin',
  ])('refuses to be turned into an open redirect by ?next=%s', async (next) => {
    await servePlatform();
    const { router } = mountSignIn(`${paths.signIn}?${new URLSearchParams({ next }).toString()}`);

    await signInWith(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password);

    // Not a path of this site — or this screen — so it is not where the sign-in goes: `/`
    // is, and `/` carries on to the workspace's latest test.
    await waitFor(() => {
      expect(router.state.location.pathname.startsWith('/runs/')).toBe(true);
    });
    expect(router.state.location.pathname).not.toContain('elsewhere.example');
  });

  it('sends the password in the body of a POST, never in the document and never to a log', async () => {
    const platform = await servePlatform();
    const logs: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
    }

    const { router } = mountSignIn();
    await signInWith(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password);
    await waitFor(() => {
      expect(platform.attempts).toHaveLength(1);
    });

    expect(platform.attempts[0]).toEqual({ email: DEMO_ACCOUNT.email, sentPassword: true });
    // Nothing anybody can read it off: not an attribute, not the URL, not the console.
    expect(document.body.innerHTML).not.toContain(DEMO_ACCOUNT.password);
    expect(router.state.location.search).not.toContain(DEMO_ACCOUNT.password);
    expect(JSON.stringify(logs)).not.toContain(DEMO_ACCOUNT.password);
  });

  it('is a POST, so a browser with no JavaScript does not put the password in a query string', async () => {
    await servePlatform();
    mountSignIn();
    await screen.findByRole('button', { name: 'Sign in' });

    const form = card() as HTMLFormElement;
    expect(form.tagName).toBe('FORM');
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    // React sets a field's value as a property; the document itself carries none.
    expect(screen.getByLabelText('Password').getAttribute('value')).toBeNull();
  });
});

describe('a refused sign-in', () => {
  const refuse = async () => {
    const platform = await servePlatform();
    mountSignIn();
    await signInWith(DEMO_ACCOUNT.email, 'not the password');
    return platform;
  };

  it('states that the email or password was wrong, without saying which', async () => {
    await refuse();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(SIGNIN_FAILED);
    // Neither field is named: the screen cannot be used to find out which addresses exist.
    expect(alert.textContent).not.toMatch(/\bemail is\b|\bpassword is\b|no account for/i);
  });

  it('is announced to a screen reader, and both fields point at it', async () => {
    await refuse();
    const alert = await screen.findByRole('alert');

    for (const label of ['Work email', 'Password']) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute('aria-invalid'), label).toBe('true');
      expect(field.getAttribute('aria-describedby'), label).toBe(alert.id);
    }
  });

  it('keeps the typed email, so the correction is one field', async () => {
    await refuse();
    await screen.findByRole('alert');

    expect((screen.getByLabelText('Work email') as HTMLInputElement).value).toBe(
      DEMO_ACCOUNT.email,
    );
  });

  it('renders above the fields, as the screen contract asks', async () => {
    await refuse();
    const alert = await screen.findByRole('alert');
    const rows = [...card().children];

    expect(rows.indexOf(alert)).toBeGreaterThanOrEqual(0);
    expect(rows.indexOf(alert)).toBeLessThan(
      rows.findIndex((row) => row.contains(screen.getByLabelText('Work email'))),
    );
  });
});

describe('a server that cannot be reached', () => {
  it('says so and offers to try again, rather than clearing the form', async () => {
    await servePlatform({ unreachable: true });
    mountSignIn();
    await signInWith(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not be reached/i);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    // Nothing was tested, so neither field is marked wrong — and what was typed is still
    // there for the retry.
    expect((screen.getByLabelText('Work email') as HTMLInputElement).value).toBe(
      DEMO_ACCOUNT.email,
    );
    expect(screen.getByLabelText('Work email').getAttribute('aria-invalid')).toBeNull();
  });
});

describe('a server that answered, but not with a session', () => {
  it('does not report a bad password when the server itself had the problem', async () => {
    // A proxy's 502, with no sentence of its own: the credentials were never tested, so
    // saying they are wrong would be a guess about somebody's password.
    await servePlatform({ signinAnswers: { status: 502, body: { signedIn: false } } });
    mountSignIn();
    await signInWith(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain(SIGNIN_FAILED);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('does not report a bad password when a 200 carries a session it cannot read', async () => {
    // The cookie is set by now: the only thing wrong is the body, so the reader is offered
    // the same form again rather than told their password is wrong.
    await servePlatform({ signinAnswers: { status: 200, body: { signedIn: true } } });
    mountSignIn();
    await signInWith(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain(SIGNIN_FAILED);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('the two redirects', () => {
  it('sends a signed-out visit to a protected route to /signin, carrying the path', async () => {
    const platform = await servePlatform();
    const intended = paths.run(platform.runIds[0] as string);
    const { router } = mountApp(intended, { session: null });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.signIn);
    });
    expect(`${paths.signIn}${router.state.location.search}`).toBe(signInWithNext(intended));
  });

  it('sends a signed-in visit to /signin to /, and on to the latest test', async () => {
    const platform = await servePlatform({ signedIn: true });
    const { router } = mountSignIn();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.run(platform.runIds[0] as string));
    });
    // `/` was passed through, not stopped at: the reader was asked nothing in between.
    expect(screen.queryByLabelText('Work email')).toBeNull();
  });

  it('flashes neither screen while the session is unresolved', async () => {
    const platform = await servePlatform({ signedIn: true, holdSession: true });
    const { router } = mountSignIn();

    // The session is still being resolved: a quiet card, no form to fill in, and nothing
    // of the screen the reader is about to be sent to.
    expect(card().getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(router.state.location.pathname).toBe(paths.signIn);
    expect(document.querySelector('[data-shell="chrome"]')).toBeNull();

    // The same rows, in the same order, as the resolved card has: the card does not change
    // shape when the answer arrives.
    const whileLoading = [...card().children].map((row) => row.className);
    expect(whileLoading.slice(0, 3)).toEqual(['', 'field-group', 'field-group']);
    expect(whileLoading.slice(-2)).toEqual(['demo-creds', 'footnote']);

    platform.release();
    await waitFor(() => {
      expect(router.state.location.pathname).not.toBe(paths.signIn);
    });
  });

  it('is not undone by a session read that answers after the sign-in', async () => {
    // The server was not there when the app started, so the reader was sent here and the
    // next screen to mount asked again — and that read is still in flight while they sign
    // in. Its answer is older than the sign-in and must not sign them back out.
    const platform = await servePlatform({ unreachableSession: 1, holdSession: true });
    const { router } = mountApp(paths.run(platform.runIds[0] as string), { session: null });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.signIn);
    });

    await signInWith(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password);
    await waitFor(() => {
      expect(router.state.location.pathname.startsWith('/runs/')).toBe(true);
    });

    // Inside `act`, so whatever the late answer schedules is flushed before it is read.
    platform.release();
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });

    expect(router.state.location.pathname.startsWith('/runs/')).toBe(true);
    expect(screen.queryByLabelText('Work email')).toBeNull();
  });

  it('does not flash the sign-in card on a protected route while the session is unresolved', async () => {
    const platform = await servePlatform({ holdSession: true });
    mountApp(paths.run(platform.runIds[0] as string), { session: null });

    expect(document.querySelector('.signin-card')).toBeNull();
    // #12's chrome holds its shape instead, which is what `RequireSession` renders.
    expect(document.querySelector('[data-shell="chrome"]')).toBeTruthy();
    platform.release();
  });
});

describe('the front door while the session is unresolved', () => {
  it('shows a signed-out visitor no signed-in chrome at /', async () => {
    const platform = await servePlatform({ holdSession: true });
    mountApp(paths.home, { session: null });

    // `/` is public and protected at once: until the answer arrives neither page is drawn,
    // and above all not the bar of a product the visitor may not be signed in to.
    expect(document.querySelector('[data-shell="chrome"]')).toBeNull();
    expect(document.querySelector('[data-shell="tabbar"]')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();

    platform.release();
    await waitFor(() => {
      expect(document.querySelector('[data-shell="chrome"]')).toBeNull();
    });
  });
});

describe('the stylesheet', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, '../../src/screens/signin/signin.css'), 'utf8');

  /** One rule of the stylesheet, read back through the CSSOM. */
  const rule = (selector: string): Record<string, string> => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const found = [...(style.sheet as CSSStyleSheet).cssRules].filter(
      (item): item is CSSStyleRule =>
        item instanceof CSSStyleRule && item.selectorText === selector,
    );
    expect(found, selector).toHaveLength(1);
    const declarations = (found[0] as CSSStyleRule).style;
    return Object.fromEntries(
      Array.from({ length: declarations.length }, (_unused, index) => declarations.item(index)).map(
        (property) => [property, declarations.getPropertyValue(property)],
      ),
    );
  };

  it('takes the card and the band from the tokens', () => {
    expect(rule('.signin-card')['background']).toBe('var(--color-surface)');
    expect(rule('.signin-card')['border-radius']).toBe('var(--radius-xl)');
    expect(rule('.signin-card')['box-shadow']).toBe('var(--shadow-lg)');
    expect(rule('.signin-mark')['color']).toBe('var(--color-on-canvas-dark)');
  });

  it('draws the focus ring in lime on the dark band, and in the token’s colour on the card', () => {
    // `--color-focus` is dark fir on a light surface and does not read on the band itself.
    expect(rule('.signin-band :focus-visible')['outline-color']).toBe('var(--color-accent)');
    expect(rule('.signin-card :focus-visible')['outline-color']).toBe('var(--color-focus)');
  });
});
