import { Navigate } from 'react-router';
import { LandingPage } from '@/screens/landing/LandingPage';
import { NoTestsScreen } from '@/screens/empty/NoTestsScreen';
import { ChromeShell } from './AppLayout';
import { paths } from './paths';
import { RunNotFound } from './RunNotFound';
import { useLatestRun } from './useRun';
import { useSession } from './useSession';

/**
 * `/` — the one route that is public *and* protected.
 *
 * A visitor with no session gets the Landing page: the product's own page, which says what
 * PersonaVision is (#123). Somebody signed in gets the answer, with no clicks — `/`
 * redirects to the Verdict of the workspace's most recent test, which on a fresh install is
 * the committed example run of the seeded demo workspace (`docs/FLOW.md` section 2, beat 2).
 *
 * A workspace with no test yet lands on the No tests screen instead, which offers the
 * example test and a new one.
 */
export function HomeRoute() {
  const session = useSession();
  const latest = useLatestRun();

  if (session.status === 'signed-out') return <LandingPage />;
  // `/` is the one route that is public *and* protected, so until the session resolves we
  // do not know whether the chrome belongs over it at all. A quiet full-height placeholder
  // holds the page instead of the signed-in bar, which a visitor who turns out to be
  // signed out must never be shown (#103).
  if (session.status === 'loading') return <div className="boot" aria-busy="true" />;

  switch (latest.status) {
    case 'ready':
      return <Navigate to={paths.run(latest.runId)} replace />;
    case 'loading':
      return <ChromeShell run={{ status: 'loading' }} />;
    case 'none':
      return (
        <ChromeShell run={null}>
          <NoTestsScreen />
        </ChromeShell>
      );
    case 'unreadable':
      return (
        <ChromeShell run={null}>
          <RunNotFound runId="the most recent test" url={latest.url} problem={latest.problem} />
        </ChromeShell>
      );
  }
}
