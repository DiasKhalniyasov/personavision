// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp } from '../app';
import { paths } from '../../src/shell/paths';
import { forgetSession } from '../../src/shell/useSession';
import { DEMO_ACCOUNT, servePlatform } from './platform';

/**
 * The two slots #12's chrome leaves this ticket: the workspace name beside the product
 * name, and the account corner.
 *
 * They are what says whose data the reader is looking at, so these tests assert that the
 * workspace is named, that the menu names the account and offers the one action there is,
 * and that signing out ends the session — returning to `/signin` and not letting a reload
 * back in.
 */

/** The chrome, with the session read from the server rather than handed to it. */
const mountSignedIn = async () => {
  const platform = await servePlatform({ signedIn: true });
  const mounted = mountApp(paths.run(platform.runIds[0] as string), { session: null });
  await screen.findByRole('button', { name: /Signed in as/ });
  return { platform, ...mounted };
};

const openMenu = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Signed in as/ }));
  return { user, menu: within(await screen.findByRole('menu')) };
};

beforeEach(loadDesignTokens);
afterEach(() => {
  // The tree comes down before the shared session store is reset; see the note in
  // `signin.test.tsx`.
  cleanup();
  forgetRuns();
  forgetSession();
});

describe('the chrome of a signed-in reader', () => {
  it('names the workspace beside the product name', async () => {
    await mountSignedIn();

    const name = document.querySelector<HTMLElement>('[data-shell="workspace-name"]');
    expect(name?.textContent).toContain(DEMO_ACCOUNT.workspace.name);
    expect(name?.textContent).toContain('workspace');
  });

  it('offers the account menu, with the signed-in email in it', async () => {
    await mountSignedIn();
    const { menu } = await openMenu();

    expect(menu.getByText(DEMO_ACCOUNT.email)).toBeTruthy();
    expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
  });

  it('names who is signed in to a screen reader, from the corner itself', async () => {
    await mountSignedIn();

    expect(
      screen.getByRole('button', {
        name: `Signed in as ${DEMO_ACCOUNT.displayName} of ${DEMO_ACCOUNT.workspace.name} — account and sign out`,
      }),
    ).toBeTruthy();
  });

  it('opens the menu from the keyboard', async () => {
    await mountSignedIn();
    const user = userEvent.setup();

    screen.getByRole('button', { name: /Signed in as/ }).focus();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('menu')).toBeTruthy();
  });

  it('is clean under axe', async () => {
    await mountSignedIn();
    // Held before the menu opens: the dropdown is modal, so Radix hides the rest of the
    // document from the accessibility tree while it is open.
    const corner = screen.getByRole('button', { name: /Signed in as/ });
    await openMenu();

    // The corner and the menu it opens. The bar around them is #12's and is covered by
    // `tests/chrome.test.tsx`.
    for (const region of [corner, screen.getByRole('menu')]) {
      const results = await axe.run(region, { resultTypes: ['violations'] });
      expect(results.violations.map((violation) => violation.id)).toEqual([]);
    }
  });
});

describe('signing out', () => {
  it('ends the session on the server and returns to /signin', async () => {
    const { platform, router } = await mountSignedIn();
    const { menu } = await openMenu();

    await userEvent.setup().click(menu.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.signIn);
    });
    expect(platform.requests).toContain('/auth/signout');
    // The session the server held is gone, which is what a reload would ask about.
    expect(platform.signedIn()).toBe(false);
  });

  it('does not get back in on a reload', async () => {
    const { platform } = await mountSignedIn();
    const { menu } = await openMenu();
    await userEvent.setup().click(menu.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => {
      expect(platform.signedIn()).toBe(false);
    });

    // A reload: nothing of the app's own answer is remembered, and the server is asked
    // again with whatever cookie the browser still has.
    forgetSession();
    const { router } = mountApp(paths.run(platform.runIds[0] as string), { session: null });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.signIn);
    });
    expect(document.querySelector('[data-shell="account-menu"]')).toBeNull();
  });

  it('says so when the server never answered, rather than implying the session is closed', async () => {
    const platform = await servePlatform({ signedIn: true, signoutFails: true });
    mountApp(paths.run(platform.runIds[0] as string), { session: null });
    await screen.findByRole('button', { name: /Signed in as/ });
    const { menu } = await openMenu();

    await userEvent.setup().click(menu.getByRole('menuitem', { name: 'Sign out' }));

    // Signed out here, and told plainly that the server did not confirm it: the cookie is
    // still alive, which matters on a machine that is not theirs.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/may still be open/i);
    expect(screen.queryByRole('button', { name: /Signed in as/ })).toBeNull();
    expect(platform.signedIn()).toBe(true);
  });

  it('takes the chrome with it: no workspace name once nobody is signed in', async () => {
    const { platform } = await mountSignedIn();
    const { menu } = await openMenu();

    await userEvent.setup().click(menu.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => {
      expect(platform.signedIn()).toBe(false);
    });
    expect(document.querySelector('[data-shell="workspace-name"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Signed in as/ })).toBeNull();
  });
});
