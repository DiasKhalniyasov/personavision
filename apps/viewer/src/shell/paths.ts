/**
 * The route table's paths, in one place.
 *
 * `docs/FLOW.md` sections 3, 13 and 14 fix them. `routes.tsx` mounts these patterns and every
 * link in the product is built from the helpers below, so no screen writes a URL of its own
 * and renaming a route is one edit here.
 *
 * The builders at the foot are the other half of that promise: a citation names a screen and
 * a handful of parameters (`docs/FLOW.md` section 16), and this is where those become a URL.
 * Their parameter names are the contract's own closed list rather than strings spelled again
 * here, so a link can only ask for something a screen honours.
 */

import type { EvidenceLinkParam } from '@personavision/contract';

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
  funnel: '/runs/:runId/funnel',
  analysis: '/runs/:runId/analysis',
  improve: '/runs/:runId/improve',
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
  /** Where the hundred of them went (`docs/FLOW.md` section 14.5). */
  funnel: (runId: string) => `/runs/${segment(runId)}/funnel`,
  /** The model's full write-up, every claim cited (`docs/FLOW.md` section 14.6). */
  analysis: (runId: string) => `/runs/${segment(runId)}/analysis`,
  /** The change written for this run, or the lock (`docs/FLOW.md` sections 11 and 15). */
  improve: (runId: string) => `/runs/${segment(runId)}/improve`,
  githubSettings: patterns.githubSettings,
} as const;

/**
 * The parameters each evidence screen takes, **named from the contract's closed list**.
 *
 * `satisfies` is what holds them to it: a name this list carries that
 * `EVIDENCE_LINK_PARAMS` does not is a type error here rather than a link that quietly
 * leads nowhere. Between them the four lists cover the whole list, which is the point of
 * closing it — a citation can only name a parameter some screen honours.
 *
 * The order inside each list is the order `docs/FLOW.md` sections 3 and 14 write the query,
 * so two links to the same place are the same string.
 */
const FUNNEL_PARAMS = ['segment', 'step'] as const satisfies readonly EvidenceLinkParam[];
const HEATMAP_PARAMS = [
  'aoi',
  'overlay',
  'segment',
  'outcome',
] as const satisfies readonly EvidenceLinkParam[];
const SESSIONS_PARAMS = [
  'variant',
  'step',
  'aoi',
  'outcome',
  'segment',
] as const satisfies readonly EvidenceLinkParam[];
const REPLAY_PARAMS = ['t'] as const satisfies readonly EvidenceLinkParam[];

/**
 * Which parameters each builder below writes. Exported so that a test can hold the four
 * lists to the contract's own list rather than to a copy of it.
 */
export const RESULT_LINK_PARAMS = {
  funnel: FUNNEL_PARAMS,
  heatmap: HEATMAP_PARAMS,
  sessions: SESSIONS_PARAMS,
  session: REPLAY_PARAMS,
} as const;

/**
 * What a caller may narrow a screen to: the screen's own subset of the contract's
 * parameters, each optional, because every one of them is a filter nobody has to ask for.
 *
 * A number is accepted beside a string for `t`, which a citation writes as seconds. What a
 * *value* may be is the contract's rule and is checked there, when the citation is read off
 * disk (`EVIDENCE_LINK_PARAM_RULES`); what the key may be is this file's, above.
 */
type Narrowing<Key extends EvidenceLinkParam> = Readonly<Partial<Record<Key, string | number>>>;

export type FunnelNarrowing = Narrowing<(typeof FUNNEL_PARAMS)[number]>;
export type HeatmapNarrowing = Narrowing<(typeof HEATMAP_PARAMS)[number]>;
export type SessionsNarrowing = Narrowing<(typeof SESSIONS_PARAMS)[number]>;

/**
 * The query, written in the list's order and percent-encoded by `URLSearchParams` — so a
 * segment called `first time` or an area called `a&b` survives the round trip through the
 * browser's own parsing. A parameter nobody asked for is left out rather than written
 * empty: `?segment=` is a filter on nothing, which is not what an absent filter means.
 */
const query = (
  keys: readonly EvidenceLinkParam[],
  narrowing: Readonly<Partial<Record<EvidenceLinkParam, string | number>>>,
): string => {
  const search = new URLSearchParams();
  for (const key of keys) {
    const value = narrowing[key];
    if (value !== undefined && value !== '') search.append(key, String(value));
  }
  const written = search.toString();
  return written === '' ? '' : `?${written}`;
};

/**
 * `/runs/<id>/funnel?segment=…&step=…`: where they dropped out, for one segment or for all.
 *
 * `step` is how a recommendation's funnel citation addresses the row it rests on — *funnel ·
 * waiting* — so the Funnel and timing screen opens on that step rather than at the top of
 * its funnel. It is URL state like the segment beside it, not a fragment, because the screen
 * reads its own state from the query (`docs/FLOW.md` section 3).
 */
export const funnelLink = (runId: string, narrowing: FunnelNarrowing = {}): string =>
  `${paths.funnel(runId)}${query(FUNNEL_PARAMS, narrowing)}`;

/**
 * `/runs/<id>/attention/<variant>/<step>?aoi=&overlay=&segment=&outcome=`: one heatmap.
 *
 * The version and the step are path segments because a heatmap is of one of them
 * (`docs/FLOW.md` section 14.4); the overlay a link opens on and the two filters are query.
 */
export const heatmapLink = (
  runId: string,
  variant: string,
  step: string,
  narrowing: HeatmapNarrowing = {},
): string => `${paths.attention(runId, variant, step)}${query(HEATMAP_PARAMS, narrowing)}`;

/**
 * `/runs/<id>/sessions?variant=&step=&aoi=&outcome=&segment=`: the list, narrowed by any
 * composition of the five things a citation can name.
 */
export const sessionsLink = (runId: string, narrowing: SessionsNarrowing = {}): string =>
  `${paths.sessions(runId)}${query(SESSIONS_PARAMS, narrowing)}`;

/**
 * `/runs/<id>/sessions/<session>?t=…`: the replay, paused on the second a citation reads.
 *
 * Seconds from the start of the recording, as the contract's `t` means them and as the
 * citation prints them (*S-07 · 0:48*) — never milliseconds.
 */
export const sessionAtSecond = (runId: string, sessionId: string, seconds: number): string =>
  `${paths.session(runId, sessionId)}${query(REPLAY_PARAMS, { t: seconds })}`;

/**
 * `/runs/<id>/sessions?outcome=…`: the Sessions list, narrowed to one outcome.
 *
 * The filter is URL state (`docs/FLOW.md` section 3) and `outcome` is one of the parameters
 * the contract lets an evidence link carry, so a screen that links to a filtered list goes
 * through here rather than writing the query itself.
 */
export const sessionsWithOutcome = (runId: string, outcome: string): string =>
  sessionsLink(runId, { outcome });

/**
 * `/runs/<id>/sessions?variant=…`: the Sessions list, narrowed to one version.
 *
 * The Attention screen offers it where a step nobody reached would otherwise be an empty
 * frame — "see where they ended" — so the link is built here with the rest of them rather
 * than assembled on that screen.
 */
export const sessionsWithVariant = (runId: string, variant: string): string =>
  sessionsLink(runId, { variant });

/**
 * `/runs/<id>/sessions?variant=…&aoi=…`: the people who looked at one area of interest.
 *
 * Every row of the Attention screen's areas table offers it, and clicking an area anywhere
 * in the product means this list (`docs/FLOW.md` section 4). The version travels with the
 * area because an area belongs to exactly one of them, and a list filtered by an area of
 * the other version is a pair no session can satisfy.
 */
export const sessionsWithArea = (runId: string, variant: string, aoi: string): string =>
  sessionsLink(runId, { variant, aoi });

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
