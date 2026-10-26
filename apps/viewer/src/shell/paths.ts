/**
 * The route table's paths, in one place.
 *
 * `docs/FLOW.md` section 3 fixes them. `routes.tsx` mounts these patterns and every link
 * in the product is built from the helpers below, so no screen writes a URL of its own and
 * renaming a route is one edit here.
 */

/** The query parameter a protected route carries the intended path to `/signin` in. */
export const NEXT_PARAM = 'next';

/** The patterns `routes.tsx` mounts, as react-router spells them. */
export const patterns = {
  home: '/',
  signIn: '/signin',
  demo: '/demo',
  audiences: '/audiences',
  newAudience: '/audiences/new',
  audience: '/audiences/:audienceId',
  newTest: '/new',
  run: '/runs/:runId',
  breakdown: '/runs/:runId/breakdown',
  attention: '/runs/:runId/attention/:variant/:step',
  sessions: '/runs/:runId/sessions',
  session: '/runs/:runId/sessions/:sessionId',
} as const;

const segment = (value: string): string => encodeURIComponent(value);

/** The paths themselves. A screen links through these and never assembles a URL. */
export const paths = {
  home: patterns.home,
  signIn: patterns.signIn,
  demo: patterns.demo,
  audiences: patterns.audiences,
  newAudience: patterns.newAudience,
  audience: (audienceId: string) => `/audiences/${segment(audienceId)}`,
  newTest: patterns.newTest,
  run: (runId: string) => `/runs/${segment(runId)}`,
  breakdown: (runId: string) => `/runs/${segment(runId)}/breakdown`,
  attention: (runId: string, variant: string, step: string) =>
    `/runs/${segment(runId)}/attention/${segment(variant)}/${segment(step)}`,
  sessions: (runId: string) => `/runs/${segment(runId)}/sessions`,
  session: (runId: string, sessionId: string) =>
    `/runs/${segment(runId)}/sessions/${segment(sessionId)}`,
} as const;

/** `/signin?next=…`: where sign-in sends a visitor back to once they are in. */
export const signInWithNext = (intended: string): string =>
  `${paths.signIn}?${new URLSearchParams({ [NEXT_PARAM]: intended }).toString()}`;
