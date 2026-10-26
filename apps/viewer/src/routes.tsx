import type { RouteObject } from 'react-router';
import { AttentionPage } from './screens/attention/AttentionPage';
import { AudienceSetupPage } from './screens/audience/AudienceSetupPage';
import { AudiencesPage } from './screens/audience/AudiencesPage';
import { BreakdownPage } from './screens/breakdown/BreakdownPage';
import { DemoPage } from './screens/demo/DemoPage';
import { NewTestPage } from './screens/newtest/NewTestPage';
import { SessionReplayPage } from './screens/sessions/SessionReplayPage';
import { SessionsPage } from './screens/sessions/SessionsPage';
import { SignInPage } from './screens/signin/SignInPage';
import { AppLayout, RequireAudience, RequireSession } from './shell/AppLayout';
import { HomeRoute } from './shell/HomeRoute';
import { NotFoundRoute } from './shell/NotFoundRoute';
import { patterns } from './shell/paths';
import { RunRoute } from './shell/RunRoute';

/**
 * The route table, exactly as `docs/FLOW.md` section 3 lists it.
 *
 * Three of these routes are **public**: `/` (the Landing page when nobody is signed in),
 * `/signin` and `/demo`. Everything else is behind `RequireSession`, which sends a
 * signed-out visitor to `/signin` carrying the path they asked for, and renders inside the
 * product chrome.
 *
 * A screen ticket fills the component its route already points at. The paths themselves
 * live in `shell/paths.ts`, so a link is never written out and this table is the only place
 * a pattern is mounted.
 */
export const routes: RouteObject[] = [
  { path: patterns.home, element: <HomeRoute /> },
  { path: patterns.signIn, element: <SignInPage /> },
  { path: patterns.demo, element: <DemoPage /> },
  {
    element: <RequireSession />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: patterns.audiences, element: <AudiencesPage /> },
          { path: patterns.newAudience, element: <AudienceSetupPage /> },
          { path: patterns.audience, element: <AudienceSetupPage /> },
          {
            element: <RequireAudience />,
            children: [{ path: patterns.newTest, element: <NewTestPage /> }],
          },
          { path: patterns.run, element: <RunRoute /> },
          { path: patterns.breakdown, element: <BreakdownPage /> },
          { path: patterns.attention, element: <AttentionPage /> },
          { path: patterns.sessions, element: <SessionsPage /> },
          { path: patterns.session, element: <SessionReplayPage /> },
          { path: '*', element: <NotFoundRoute /> },
        ],
      },
    ],
  },
];
