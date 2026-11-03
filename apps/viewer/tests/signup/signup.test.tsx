// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp } from '../app';
import { paths } from '../../src/shell/paths';
import { forgetSession } from '../../src/shell/useSession';
import { NEW_WORKSPACE, SIGNUP_REFUSALS, servePlatform } from './platform';

/**
 * `/signup` — the way in.
 *
 * What these tests hold is the ticket's own acceptance: the three fields of
 * `#screen-signup` with their real labels, the password hint and the footnote that says what
 * the next step is; a completed sign-up landing on `/sites` signed in, with the workspace it
 * created named in the chrome; each refusal against its own field, with what was typed still
 * in the form; an email that already has a workspace told so, with the way on; and a
 * password that is in the body of a POST and nowhere else.
 *
 * The server is `./platform`, which answers the routes
 * `packages/platform/src/server/routes/auth.ts` mounts, so the screen is tested against what
 * the platform says rather than against a mocked module of its own.
 */

/** `/signup` with nothing overriding the session: the app reads `GET /auth/session` itself. */
const mountSignUp = () => mountApp(paths.signUp, { session: null });

const card = (): HTMLElement => document.querySelector<HTMLElement>('.signin-card')!;

const LABELS = { email: 'Work email', password: 'Password', workspace: 'Workspace name' };

const field = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;

/** Fill in the three fields and press the one action. Any field can be left out. */
const fillIn = async (fields: Partial<typeof NEW_WORKSPACE> = NEW_WORKSPACE) => {
  const user = userEvent.setup();
  await screen.findByRole('button', { name: 'Create workspace' });
  if (fields.email !== undefined) await user.type(field(LABELS.email), fields.email);
  if (fields.password !== undefined) await user.type(field(LABELS.password), fields.password);
  if (fields.workspaceName !== undefined) {
    await user.type(field(LABELS.workspace), fields.workspaceName);
  }
  await user.click(screen.getByRole('button', { name: 'Create workspace' }));
  return user;
};

beforeEach(loadDesignTokens);
afterEach(() => {
  // The tree comes down before the shared session store is reset; see the note in
  // `tests/signin/signin.test.tsx`.
  cleanup();
  forgetRuns();
  forgetSession();
  vi.restoreAllMocks();
});

describe('the screen', () => {
  it('renders the card on the dark band with the three fields, the hint and the footnote', async () => {
    await servePlatform();
    mountSignUp();
    await screen.findByRole('button', { name: 'Create workspace' });
    const form = within(card());

    // The band is `.strip-dark`, which `styles/base.css` declares from the tokens, so the
    // one dark band in the product is declared once.
    expect(document.querySelector('.signin-band')?.classList.contains('strip-dark')).toBe(true);
    expect(screen.getByText('PersonaVision')).toBeTruthy();
    expect(form.getByRole('heading', { level: 1, name: 'Create your workspace' })).toBeTruthy();
    expect(
      form.getByText(
        'Point it at your site, describe the people you serve, and watch a hundred of them try it.',
      ),
    ).toBeTruthy();

    for (const label of Object.values(LABELS)) expect(form.getByLabelText(label)).toBeTruthy();
    expect(
      form.getByText('At least twelve characters. We store a verifier, never the password.'),
    ).toBeTruthy();
    expect(form.getByRole('button', { name: 'Create workspace' })).toBeTruthy();
    // The prototype's own words: a new workspace is told what the next step is rather than
    // left on a screen with nothing on it.
    expect(
      form.getByText('No card. Next step is adding a site and proving it is yours.'),
    ).toBeTruthy();
  });

  it('is the empty state on the first render: no field pre-filled', async () => {
    await servePlatform();
    mountSignUp();
    await screen.findByRole('button', { name: 'Create workspace' });

    // The prototype's placeholder values are the prototype's.
    for (const label of Object.values(LABELS)) expect(field(label).value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('carries no product chrome: no workspace name, no test picker, no tabs, no badge', async () => {
    await servePlatform();
    mountSignUp();
    await screen.findByRole('button', { name: 'Create workspace' });

    for (const slot of ['chrome', 'tabbar', 'workspace-name', 'account-menu']) {
      expect(document.querySelector(`[data-shell="${slot}"]`), slot).toBeNull();
    }
    expect(document.querySelector('.sim-badge')).toBeNull();
    expect(document.querySelectorAll('nav')).toHaveLength(0);
  });

  it('is operable by keyboard alone, from the first field to the action', async () => {
    await servePlatform();
    mountSignUp();
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Create workspace' });

    for (const label of Object.values(LABELS)) {
      await user.tab();
      expect(document.activeElement, label).toBe(field(label));
    }
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create workspace' }));
  });

  it('is submittable by keyboard alone', async () => {
    const platform = await servePlatform();
    mountSignUp();
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Create workspace' });

    await user.type(field(LABELS.email), NEW_WORKSPACE.email);
    await user.type(field(LABELS.password), NEW_WORKSPACE.password);
    // Enter from inside a field submits the form: the primary action is never the only way.
    await user.type(field(LABELS.workspace), `${NEW_WORKSPACE.workspaceName}{Enter}`);

    await waitFor(() => {
      expect(platform.workspaces()).toEqual([NEW_WORKSPACE.workspaceName]);
    });
  });

  it('restates no visual value by hand: every one comes from the tokens', async () => {
    await servePlatform();
    mountSignUp();
    await screen.findByRole('button', { name: 'Create workspace' });

    // A hand-written width, colour or spacing step would be a value outside
    // `docs/design/tokens.css`, which `main.tsx` imports and this screen never copies.
    expect([...card().querySelectorAll('[style]')]).toHaveLength(0);
    expect(document.querySelector('.signin-band')?.getAttribute('style')).toBeNull();
  });

  it('is clean under axe', async () => {
    await servePlatform();
    mountSignUp();
    await screen.findByRole('button', { name: 'Create workspace' });

    const results = await axe.run(card(), { resultTypes: ['violations'] });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it('is clean under axe with a refusal on the screen', async () => {
    await servePlatform();
    mountSignUp();
    await fillIn({ ...NEW_WORKSPACE, password: 'too-short' });
    await screen.findByRole('alert');

    const results = await axe.run(card(), { resultTypes: ['violations'] });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe('signing up', () => {
  it('creates the workspace and lands on /sites, signed in and named', async () => {
    const platform = await servePlatform();
    const { router } = mountSignUp();

    await fillIn();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.sites);
    });
    expect(platform.workspaces()).toEqual([NEW_WORKSPACE.workspaceName]);
    expect(platform.signedIn()).toBe(true);
    expect(platform.attempts).toEqual([
      {
        email: NEW_WORKSPACE.email,
        workspaceName: NEW_WORKSPACE.workspaceName,
        sentPassword: true,
      },
    ]);
    // The form is gone: no second sign-in in between.
    expect(document.querySelector('.signin-card')).toBeNull();
  });

  it('names the workspace it just created in the chrome of the screen it lands on', async () => {
    await servePlatform();
    mountSignUp();

    await fillIn();

    // Read from the server's own answer rather than from the sign-up's: `useSession` is the
    // one place this app asks who is signed in, and a reload reads the same thing.
    await waitFor(() => {
      const name = document.querySelector<HTMLElement>('[data-shell="workspace-name"]');
      expect(name?.textContent).toContain(NEW_WORKSPACE.workspaceName);
    });
  });

  it('says it is creating the workspace while it is, and takes no second submission', async () => {
    // Held unanswered, so the in-flight state is observable rather than raced past.
    const platform = await servePlatform({ holdSignup: true });
    mountSignUp();
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Create workspace' });
    await user.type(field(LABELS.email), NEW_WORKSPACE.email);
    await user.type(field(LABELS.password), NEW_WORKSPACE.password);
    await user.type(field(LABELS.workspace), NEW_WORKSPACE.workspaceName);

    const button = screen.getByRole('button', { name: 'Create workspace' });
    const before = card().children.length;
    await user.click(button);

    // The layout does not move: the same one button, in the same card, saying what it is doing.
    const busy = await screen.findByRole('button', { name: 'Creating your workspace…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(card().children.length).toBe(before);
    expect(card().getAttribute('aria-busy')).toBe('true');
    // A second press while it is in flight creates no second workspace.
    await user.click(busy);

    platform.release();
    await waitFor(() => {
      expect(platform.workspaces()).toEqual([NEW_WORKSPACE.workspaceName]);
    });
    expect(platform.attempts).toHaveLength(1);
  });

  it('sends the password in the body of a POST, never in the document and never to a log', async () => {
    const platform = await servePlatform();
    const logs: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
    }

    const { router } = mountSignUp();
    await fillIn();
    await waitFor(() => {
      expect(platform.attempts).toHaveLength(1);
    });

    // Nothing anybody can read it off: not an attribute, not the URL, not the console.
    expect(document.body.innerHTML).not.toContain(NEW_WORKSPACE.password);
    expect(router.state.location.search).not.toContain(NEW_WORKSPACE.password);
    expect(JSON.stringify(logs)).not.toContain(NEW_WORKSPACE.password);
  });

  it('is a POST, so a browser with no JavaScript does not put the password in a query string', async () => {
    await servePlatform();
    mountSignUp();
    await screen.findByRole('button', { name: 'Create workspace' });

    const form = card() as HTMLFormElement;
    expect(form.tagName).toBe('FORM');
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    // React sets a field's value as a property; the document itself carries none.
    expect(field(LABELS.password).getAttribute('value')).toBeNull();
  });
});

describe('a refusal', () => {
  /** The refusal is against this field, announced, and against no other. */
  const marks = async (label: string, sentence: string): Promise<void> => {
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(sentence);
    expect(field(label).getAttribute('aria-invalid')).toBe('true');
    expect(field(label).getAttribute('aria-describedby')).toContain(alert.id);
    for (const other of Object.values(LABELS).filter((value) => value !== label)) {
      expect(field(other).getAttribute('aria-invalid'), other).toBeNull();
    }
  };

  it('refuses a password under twelve characters against the password field', async () => {
    const platform = await servePlatform();
    mountSignUp();

    await fillIn({ ...NEW_WORKSPACE, password: 'eleven-char' });

    await marks(LABELS.password, SIGNUP_REFUSALS.passwordTooShort);
    expect(platform.workspaces()).toEqual([]);
  });

  it.each([
    [
      { password: NEW_WORKSPACE.password, workspaceName: NEW_WORKSPACE.workspaceName },
      LABELS.email,
      SIGNUP_REFUSALS.emailMissing,
    ],
    [
      { email: NEW_WORKSPACE.email, workspaceName: NEW_WORKSPACE.workspaceName },
      LABELS.password,
      SIGNUP_REFUSALS.passwordMissing,
    ],
    [
      { email: NEW_WORKSPACE.email, password: NEW_WORKSPACE.password },
      LABELS.workspace,
      SIGNUP_REFUSALS.workspaceMissing,
    ],
    [
      { ...NEW_WORKSPACE, workspaceName: '   ' },
      LABELS.workspace,
      SIGNUP_REFUSALS.workspaceMissing,
    ],
    [{ ...NEW_WORKSPACE, email: 'not-an-email' }, LABELS.email, SIGNUP_REFUSALS.emailMalformed],
    [
      { ...NEW_WORKSPACE, workspaceName: 'C'.repeat(61) },
      LABELS.workspace,
      SIGNUP_REFUSALS.workspaceTooLong,
    ],
  ])('names the field of %o', async (fields, label, sentence) => {
    const platform = await servePlatform();
    mountSignUp();

    await fillIn(fields);

    await marks(label, sentence);
    expect(platform.workspaces()).toEqual([]);
  });

  it('leaves the form standing with what was typed still in it', async () => {
    await servePlatform();
    mountSignUp();

    await fillIn({ ...NEW_WORKSPACE, password: 'short' });
    await screen.findByRole('alert');

    // One correction rather than a form filled in again — and the password is held nowhere
    // this app can read it back from.
    expect(field(LABELS.email).value).toBe(NEW_WORKSPACE.email);
    expect(field(LABELS.workspace).value).toBe(NEW_WORKSPACE.workspaceName);
    expect(screen.getByRole('button', { name: 'Create workspace' })).toBeTruthy();
  });

  it('tells an email that already has a workspace so, and offers the way on', async () => {
    const platform = await servePlatform({ taken: NEW_WORKSPACE.email });
    mountSignUp();

    await fillIn();

    await marks(LABELS.email, SIGNUP_REFUSALS.emailTaken);
    // A sign-up that pretended to succeed, or blamed the password, would leave this person
    // stuck forever: the link is the way out of it.
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(paths.signIn);
    expect(platform.workspaces()).toEqual([]);
  });

  it('takes a correction and then creates the workspace', async () => {
    const platform = await servePlatform();
    mountSignUp();
    const user = await fillIn({ ...NEW_WORKSPACE, password: 'short' });
    await screen.findByRole('alert');

    await user.clear(field(LABELS.password));
    await user.type(field(LABELS.password), NEW_WORKSPACE.password);
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => {
      expect(platform.workspaces()).toEqual([NEW_WORKSPACE.workspaceName]);
    });
  });
});

describe('an answer this app could not read', () => {
  it('does not claim a workspace was created by a 200 that names no session', async () => {
    // A dev proxy, or an SPA fallback serving the page itself with a 200. Landing on
    // `/sites` would be bounced to `/signin` by the guard, leaving the reader believing
    // they have an account.
    await servePlatform({ signupAnswers: { status: 200, body: { signedIn: false } } });
    const { router } = mountSignUp();

    await fillIn();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not read/i);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(router.state.location.pathname).toBe(paths.signUp);
  });

  it('offers to try again when the body itself could not be read, and marks no field', async () => {
    await servePlatform({
      signupAnswers: { status: 400, body: { signedIn: false, error: SIGNUP_REFUSALS.unreadable } },
    });
    mountSignUp();

    await fillIn();

    // The one refusal where nothing the reader typed is at fault: no field is named, so
    // the same form is what to send again.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(SIGNUP_REFUSALS.unreadable);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    for (const label of Object.values(LABELS)) {
      expect(field(label).getAttribute('aria-invalid'), label).toBeNull();
      // And every field points at it, so tabbing back into one reads the sentence.
      expect(field(label).getAttribute('aria-describedby'), label).toContain(alert.id);
    }
  });
});

describe('a platform that cannot be reached', () => {
  it('renders one sentence above the form and offers to try again, clearing nothing', async () => {
    await servePlatform({ unreachable: true });
    mountSignUp();

    await fillIn();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not be reached/i);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();

    // Above the fields, and no field is marked: nothing was tested and nothing was created.
    const rows = [...card().children];
    expect(rows.indexOf(alert)).toBeGreaterThanOrEqual(0);
    expect(rows.indexOf(alert)).toBeLessThan(
      rows.findIndex((row) => row.contains(field(LABELS.email))),
    );
    for (const label of Object.values(LABELS)) {
      expect(field(label).getAttribute('aria-invalid'), label).toBeNull();
    }
    expect(field(LABELS.email).value).toBe(NEW_WORKSPACE.email);
  });

  it('does not blame a field when the server itself had the problem', async () => {
    await servePlatform({ signupAnswers: { status: 502, body: { signedIn: false } } });
    mountSignUp();

    await fillIn();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    for (const label of Object.values(LABELS)) {
      expect(field(label).getAttribute('aria-invalid'), label).toBeNull();
    }
  });
});

describe('somebody who already has a workspace', () => {
  it('is sent on rather than offered a second one', async () => {
    await servePlatform({ signedIn: true });
    const { router } = mountSignUp();

    await waitFor(() => {
      expect(router.state.location.pathname).not.toBe(paths.signUp);
    });
    // `/` is the product's own front door: the workspace's latest test, or the screen that
    // offers the first one. Never a second sign-up form.
    expect(screen.queryByLabelText(LABELS.workspace)).toBeNull();
  });

  it('flashes neither screen while the session is unresolved', async () => {
    const platform = await servePlatform({ signedIn: true, holdSession: true });
    mountSignUp();

    // A quiet card of the card's own height, with no form to fill in and nothing of the
    // screen the visitor is about to be sent to.
    expect(card().getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Create workspace' })).toBeNull();
    expect(screen.queryByLabelText(LABELS.email)).toBeNull();

    platform.release();
    await waitFor(() => {
      expect(document.querySelector('.signin-card')).toBeNull();
    });
  });
});
