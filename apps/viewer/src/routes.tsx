import type { RouteObject } from 'react-router';
import { AnalysisPage } from './screens/analysis/AnalysisPage';
import { AttentionPage } from './screens/attention/AttentionPage';
import { AudienceSetupPage } from './screens/audience/AudienceSetupPage';
import { AudiencesPage } from './screens/audience/AudiencesPage';
import { BreakdownPage } from './screens/breakdown/BreakdownPage';
import { DemoPage } from './screens/demo/DemoPage';
import { FunnelPage } from './screens/funnel/FunnelPage';
import { NewTestWizard } from './screens/newtest/wizard/NewTestWizard';
import { SessionReplayPage } from './screens/sessions/SessionReplayPage';
import { SessionsPage } from './screens/sessions/SessionsPage';
import { GithubPage } from './screens/settings/GithubPage';
import { SignInPage } from './screens/signin/SignInPage';
import { SignUpPage } from './screens/signup/SignUpPage';
import { AddSitePage } from './screens/site/AddSitePage';
import { SitePage } from './screens/site/SitePage';
import { SitesPage } from './screens/sites/SitesPage';
import { AppLayout, RequireSession } from './shell/AppLayout';
import { HomeRoute } from './shell/HomeRoute';
import { NotFoundRoute } from './shell/NotFoundRoute';
import { patterns } from './shell/paths';
import { RunRoute } from './shell/RunRoute';

/**
 * The route table, exactly as `docs/FLOW.md` sections 3 and 13 list it.
 *
 * Four of these routes are **public**: `/` (the Landing page when nobody is signed in),
 * `/signin`, `/signup` and `/demo`. Everything else is behind `RequireSession`, which sends
 * a signed-out visitor to `/signin` carrying the path they asked for, and renders inside the
 * product chrome.
 *
 * A screen ticket fills the component its route already points at. The paths themselves
 * live in `shell/paths.ts`, so a link is never written out and this table is the only place
 * a pattern is mounted — `/new` included, which is **one route with a step in the query**
 * (section 13) rather than a route per step of the wizard.
 */
export const routes: RouteObject[] = [
  { path: patterns.home, element: <HomeRoute /> },
  { path: patterns.signIn, element: <SignInPage /> },
  { path: patterns.signUp, element: <SignUpPage /> },
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
          { path: patterns.sites, element: <SitesPage /> },
          { path: patterns.newSite, element: <AddSitePage /> },
          { path: patterns.site, element: <SitePage /> },
          { path: patterns.newTest, element: <NewTestWizard /> },
          { path: patterns.run, element: <RunRoute /> },
          { path: patterns.breakdown, element: <BreakdownPage /> },
          { path: patterns.attention, element: <AttentionPage /> },
          { path: patterns.sessions, element: <SessionsPage /> },
          { path: patterns.session, element: <SessionReplayPage /> },
          { path: patterns.funnel, element: <FunnelPage /> },
          { path: patterns.analysis, element: <AnalysisPage /> },
          { path: patterns.githubSettings, element: <GithubPage /> },
          { path: '*', element: <NotFoundRoute /> },
        ],
      },
    ],
  },
];
