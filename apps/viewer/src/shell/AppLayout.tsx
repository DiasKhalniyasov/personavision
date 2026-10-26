import { Navigate, Outlet, useLocation } from 'react-router';
import type { ReactNode } from 'react';
import { AppChrome } from './AppChrome';
import { paths, signInWithNext } from './paths';
import { useAudiences } from './useAudiences';
import type { RunState } from './useRun';
import { useCurrentRun } from './useRun';
import { useSession } from './useSession';

/**
 * The shape of every screen behind sign-in: the product chrome, then the screen.
 *
 * Three layout routes, each with one job, so `routes.tsx` reads as the route table of
 * `docs/FLOW.md` section 3 and nothing else:
 *
 * - `RequireSession` — a signed-out visitor to a protected route lands on `/signin`
 *   carrying the path they asked for, so signing in finishes the journey they started.
 *   `/`, `/signin` and `/demo` are public and are not under it.
 * - `AppLayout` — the chrome, naming the test the route is about, or the workspace's most
 *   recent one on a route that is about no test.
 * - `RequireAudience` — a test cannot be run without an audience, so `/new` asks for one
 *   first rather than rendering a form that cannot be submitted.
 */

export function ChromeShell({ run, children }: { run: RunState | null; children?: ReactNode }) {
  return (
    <>
      <AppChrome run={run} />
      <main>{children}</main>
    </>
  );
}

export function RequireSession() {
  const state = useSession();
  const { pathname, search, hash } = useLocation();

  // The chrome, quietly, while we find out: the layout must not jump once we know.
  if (state.status === 'loading') return <ChromeShell run={{ status: 'loading' }} />;
  if (state.status === 'signed-out') {
    return <Navigate to={signInWithNext(`${pathname}${search}${hash}`)} replace />;
  }
  return <Outlet />;
}

export function AppLayout() {
  const run = useCurrentRun();

  return (
    <ChromeShell run={run}>
      <Outlet />
    </ChromeShell>
  );
}

export function RequireAudience() {
  const audiences = useAudiences();

  if (audiences.status === 'loading') return null;
  if (audiences.audiences.length === 0) return <Navigate to={paths.newAudience} replace />;
  return <Outlet />;
}
