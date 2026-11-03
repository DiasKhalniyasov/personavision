/**
 * The route table's paths, in one place.
 *
 * `docs/FLOW.md` sections 3 and 13 fix them. `routes.tsx` mounts these patterns and every link
 * in the product is built from the helpers below, so no screen writes a URL of its own and
 * renaming a route is one edit here.
 */

/** The query parameter a protected route carries the intended path to `/signin` in. */
export const NEXT_PARAM = 'next';

/** The patterns `routes.tsx` mounts, as react-router spells them. */
export const patterns = {
  home: '/',
  signIn: '/signin',
  signUp: '/signup',
  demo: '/demo',
  audiences: '/audiences',
  newAudience: '/audiences/new',
  audience: '/audiences/:audienceId',
  sites: '/sites',
  newSite: '/sites/new',
  site: '/sites/:siteId',
  newTest: '/new',
  run: '/runs/:runId',
  breakdown: '/runs/:runId/breakdown',
  attention: '/runs/:runId/attention/:variant/:step',
  sessions: '/runs/:runId/sessions',
  session: '/runs/:runId/sessions/:sessionId',
  githubSettings: '/settings/github',
} as const;

/**
 * The `useMatch` patterns for a route and everything under it — the star is react-router's.
 * The chrome asks which tab is the current one with these, so no component composes a
 * pattern of its own either.
 */
export const matches = {
  /** Any screen of one test, whichever of its tabs is open. */
  runScreens: `${patterns.run}/*`,
  attention: `${patterns.run}/attention/*`,
  sessions: `${patterns.sessions}/*`,
  audiences: `${patterns.audiences}/*`,
  /** The sites of the workspace, and the one being added or proved. */
  sites: `${patterns.sites}/*`,
} as const;

const segment = (value: string): string => encodeURIComponent(value);

/** The paths themselves. A screen links through these and never assembles a URL. */
export const paths = {
  home: patterns.home,
  signIn: patterns.signIn,
  signUp: patterns.signUp,
  demo: patterns.demo,
  audiences: patterns.audiences,
  newAudience: patterns.newAudience,
  audience: (audienceId: string) => `/audiences/${segment(audienceId)}`,
  sites: patterns.sites,
  newSite: patterns.newSite,
  site: (siteId: string) => `/sites/${segment(siteId)}`,
  newTest: patterns.newTest,
  run: (runId: string) => `/runs/${segment(runId)}`,
  breakdown: (runId: string) => `/runs/${segment(runId)}/breakdown`,
  attention: (runId: string, variant: string, step: string) =>
    `/runs/${segment(runId)}/attention/${segment(variant)}/${segment(step)}`,
  sessions: (runId: string) => `/runs/${segment(runId)}/sessions`,
  session: (runId: string, sessionId: string) =>
    `/runs/${segment(runId)}/sessions/${segment(sessionId)}`,
  githubSettings: patterns.githubSettings,
} as const;

/**
 * `/runs/<id>/sessions?outcome=…`: the Sessions list, narrowed to one outcome.
 *
 * The filter is URL state (`docs/FLOW.md` section 3) and `outcome` is one of the parameters
 * the contract lets an evidence link carry, so a screen that links to a filtered list goes
 * through here rather than writing the query itself.
 */
export const sessionsWithOutcome = (runId: string, outcome: string): string =>
  `${paths.sessions(runId)}?${new URLSearchParams({ outcome }).toString()}`;

/**
 * `/runs/<id>/sessions?variant=…`: the Sessions list, narrowed to one version.
 *
 * The Attention screen offers it where a step nobody reached would otherwise be an empty
 * frame — "see where they ended" — so the link is built here with the rest of them rather
 * than assembled on that screen.
 */
export const sessionsWithVariant = (runId: string, variant: string): string =>
  `${paths.sessions(runId)}?${new URLSearchParams({ variant }).toString()}`;

/**
 * `/runs/<id>/sessions?variant=…&aoi=…`: the people who looked at one area of interest.
 *
 * Every row of the Attention screen's areas table offers it, and clicking an area anywhere
 * in the product means this list (`docs/FLOW.md` section 4). The version travels with the
 * area because an area belongs to exactly one of them, and a list filtered by an area of
 * the other version is a pair no session can satisfy.
 */
export const sessionsWithArea = (runId: string, variant: string, aoi: string): string =>
  `${paths.sessions(runId)}?${new URLSearchParams({ variant, aoi }).toString()}`;

/** `/signin?next=…`: where sign-in sends a visitor back to once they are in. */
export const signInWithNext = (intended: string): string =>
  `${paths.signIn}?${new URLSearchParams({ [NEXT_PARAM]: intended }).toString()}`;

/**
 * The query parameter `/new` carries its step in.
 *
 * The wizard is **one route with a step in the query** (`docs/FLOW.md` section 13), not a
 * route per step, so back, reload and a shared link all land where the user was. The step
 * vocabulary itself — which values are known, which is the default and which is an alias —
 * is the wizard's, in `screens/newtest/wizard/steps.ts`; what lives here is the shape of
 * the URL, with the rest of the product's URL state.
 */
export const STEP_PARAM = 'step';

/** `/new?step=…`: one step of the New test wizard, which is where a link to one goes. */
export const newTestStep = (step: string): string =>
  `${paths.newTest}?${new URLSearchParams({ [STEP_PARAM]: step }).toString()}`;
