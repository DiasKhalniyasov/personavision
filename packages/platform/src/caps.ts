/**
 * The caps, in **one** place: how many agents one run may drive, how many browsers a site
 * may have on it at once, and how many runs a site may take in an hour.
 *
 * They exist so that a hundred stealth browsers cannot be pointed at a URL nobody has
 * proved they control, and so that a person exploring cannot accidentally hammer their own
 * site. `docs/FLOW.md` section 13 is the design contract they come from, and the owner's
 * answer of **2026-11-03** (decision 71, settled as _no gate on testing_) is the shape they
 * are in here.
 *
 * **Verification gates none of them.** There is no smaller cap for an unverified site and no
 * verification check on the launch path: the caps protect the site being driven, not the
 * person who asked, and what verification unlocks is **Improve my site** (#227). That is why
 * `CAPS` below is a frozen object of three numbers rather than a function of a site — it
 * structurally cannot read a verification state, because it is handed nothing to read.
 *
 * **Nothing else in the repository writes these numbers.** A screen states them by asking
 * the API for them, and `packages/platform/test/caps.test.ts` greps the repository to prove
 * there is no second literal — because a screen that prints a different number is a screen
 * that is wrong rather than a cap that moved.
 */

import type { SiteLaunch } from './store/types.js';

/**
 * The three numbers. Frozen, so the module cannot be edited at runtime by whatever imports
 * it, and plain data, so no caller can pass it a site, a workspace or a verification state.
 *
 * - **`agentsPerRun`** — the audience's `size`, at most this. Above it nothing is promised,
 *   which is the owner's own figure.
 * - **`concurrentSessionsPerSite`** — a hundred browsers at once on one small site is a load
 *   test nobody asked for. Enforced by the swarm's limiter (#241); stated here because this
 *   is where the number is decided, and served by the API so the estimate (#283) and
 *   `#screen-sites` read it rather than spelling it again.
 * - **`runsPerSitePerHour`** — a person exploring cannot accidentally hammer a site.
 */
export const CAPS = Object.freeze({
  agentsPerRun: 100,
  concurrentSessionsPerSite: 10,
  runsPerSitePerHour: 4,
});

/** Which cap refused a launch, as `CapRefusedError` names it and the API answers it. */
export type CapName = keyof typeof CAPS;

/** How long the per-site launch ledger is kept, so the trailing hour can be counted off it. */
export const LAUNCH_LEDGER_HOURS = 24;

const AN_HOUR_IN_MS = 60 * 60 * 1000;

/**
 * The clock time a sentence names, as `docs/FLOW.md`'s own example prints it — _"the next may
 * start at 10:12"_.
 *
 * **UTC**, which is the clock every instant in this product is written in (`run.createdAt`,
 * `verifiedAt`, `checkedAt`), so the sentence and the stored instant never disagree by a
 * time zone. A screen that wants the reader's own clock has `retryAt` as an instant beside
 * the sentence and renders the countdown from that — which is what the screen contract asks
 * for, and why the sentence is not the only thing a refusal carries.
 */
const atClockTime = (at: Date): string =>
  `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;

/**
 * A launch a cap refused, in the user's words and in full.
 *
 * The message is written **here** and nowhere else, so the screen, the API response and the
 * CLI print one sentence rather than three. It carries the cap that refused it, that cap's
 * limit, the value observed, and when it next passes — `retryAt` as an instant, or `null`
 * where waiting does not help, because telling somebody to come back later when no later
 * will do is its own kind of lying.
 *
 * In the same spirit as `TestRefusedError`: a typed refusal with the figures beside the
 * sentence, so a route answers 429 with fields rather than a screen parsing prose.
 */
export class CapRefusedError extends Error {
  /** The cap that refused it, by the name the API answers it under. */
  readonly cap: CapName;
  /** That cap's value, as `CAPS` states it. */
  readonly limit: number;
  /** What was asked for, or what the site has already had. */
  readonly observed: number;
  /** When a launch like this one next passes, or `null` where waiting does not help. */
  readonly retryAt: string | null;

  constructor({
    cap,
    observed,
    retryAt,
    message,
  }: {
    cap: CapName;
    observed: number;
    retryAt: Date | null;
    message: string;
  }) {
    super(message);
    this.name = 'CapRefusedError';
    this.cap = cap;
    this.limit = CAPS[cap];
    this.observed = observed;
    this.retryAt = retryAt?.toISOString() ?? null;
  }
}

/**
 * The agents-per-run cap: the audience's `size`, at most `CAPS.agentsPerRun`.
 *
 * `retryAt` is `null` — an audience of a hundred and forty people is a hundred and forty
 * people in an hour as much as now, so the sentence says what to do about it instead of when
 * to come back.
 *
 * Nothing here takes a site: this cap is about the run that was asked for.
 */
export const refuseTooManyAgents = (size: number): CapRefusedError | null =>
  size <= CAPS.agentsPerRun
    ? null
    : new CapRefusedError({
        cap: 'agentsPerRun',
        observed: size,
        retryAt: null,
        message: `A test may run ${CAPS.agentsPerRun} agents; this audience asks for ${size}. Lower the participant count, or split it across two tests.`,
      });

/**
 * How many sessions a run on a site may have in flight, and what a caller that asked for
 * more is told.
 *
 * The number itself is `CAPS.concurrentSessionsPerSite` and is enforced where a session is
 * handed a browser: the swarm's pool holds whatever bound it is given (#275), so the cap is
 * a cap because of **who computes the number** rather than because of a check at the pool.
 * The platform hands it over for every run it starts; `personavision run` has a
 * `--concurrency` of its own and is bounded by it here, so a developer driving a run locally
 * cannot exceed what the product allows either.
 *
 * Three cases and they are not the same:
 *
 * - **Nobody asked.** The cap, which is what a platform-started run gets.
 * - **Less than the cap.** Honoured. A developer who asks for two browsers on a laptop is
 *   asking for less load, not more, and a cap that raised a number would be a strange cap.
 * - **More than the cap.** The cap, and a sentence saying so — written **here**, like every
 *   other sentence in this module, so that whatever prints it prints the same words. A
 *   number silently obeyed where it was not is the thing this sentence exists to prevent.
 *
 * It is not a `CapRefusedError`: nothing is refused. A run asking for fifty still runs, and
 * runs every session it planned, ten at a time.
 */
export interface ConcurrencyForSite {
  /** The bound to hand the swarm. */
  readonly concurrency: number;
  /** What to tell a caller whose own number was lowered, or `null` when it was not. */
  readonly lowered: string | null;
}

export const concurrencyForSite = (asked?: number): ConcurrencyForSite =>
  asked === undefined
    ? { concurrency: CAPS.concurrentSessionsPerSite, lowered: null }
    : asked <= CAPS.concurrentSessionsPerSite
      ? { concurrency: asked, lowered: null }
      : {
          concurrency: CAPS.concurrentSessionsPerSite,
          lowered: `A site takes ${String(CAPS.concurrentSessionsPerSite)} browsers at a time, so this run is bounded to ${String(CAPS.concurrentSessionsPerSite)} rather than the ${String(asked)} it asked for.`,
        };

/**
 * The launches of the trailing hour, oldest first.
 *
 * The window is **strictly** the last hour: a launch exactly an hour old has fallen out of
 * it, which is what makes "a run started 61 minutes after the first is allowed" true without
 * depending on where a millisecond lands.
 */
const inTheTrailingHour = (launches: readonly SiteLaunch[], now: Date): SiteLaunch[] => {
  const from = now.getTime() - AN_HOUR_IN_MS;
  return launches
    .filter((launch) => Date.parse(launch.at) > from)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
};

/**
 * The runs-per-site-per-hour cap, read off the site's own ledger.
 *
 * `retryAt` is the moment the **oldest** launch in the window falls out of it, because that
 * is the first moment the count is back under the limit. It is an instant rather than "in a
 * while", so the screen can draw a countdown beside the Launch button.
 *
 * Verified or not: this is the fifth run on a site, and the site does not care who asked.
 */
export const refuseTooManyRunsThisHour = (
  launches: readonly SiteLaunch[],
  now: Date,
): CapRefusedError | null => {
  const recent = inTheTrailingHour(launches, now);
  if (recent.length < CAPS.runsPerSitePerHour) return null;
  // **Not the oldest in the window** — the oldest one that still has to fall out of it for
  // the count to be back under the limit. With exactly four launches that is the oldest;
  // with five it is the second oldest, because the first falling out still leaves four. The
  // difference matters because `retryAt` is what the screen counts down to: naming an
  // instant that is itself still refused would send the user back to another 429.
  const blocking = recent[recent.length - CAPS.runsPerSitePerHour];
  // `recent` is at least `runsPerSitePerHour` long here, and that is positive, so the index
  // is in range: this is the type system being reminded of it rather than a case that happens.
  const retryAt = new Date(
    (blocking === undefined ? now.getTime() : Date.parse(blocking.at)) + AN_HOUR_IN_MS,
  );
  return new CapRefusedError({
    cap: 'runsPerSitePerHour',
    observed: recent.length,
    retryAt,
    message: `This site has had its ${CAPS.runsPerSitePerHour} runs this hour; the next may start at ${atClockTime(retryAt)}.`,
  });
};

/**
 * The ledger as it is written back: this launch recorded, and everything older than
 * `LAUNCH_LEDGER_HOURS` dropped.
 *
 * An **upsert on `id`**, not an append, because one launch is written twice: once when it is
 * reserved, before any browser opens, and once when the pipeline reports the run directory
 * it opened. Appending would count a single launch as two and refuse the third run of the
 * hour as though it were the fifth.
 *
 * Trimmed on write rather than swept on a timer, so the record stays bounded without
 * anything having to run. The caller serialises these writes per site; a second *process*
 * writing the same data directory is the ceiling the file store already has, and would need
 * the same answer the store itself does.
 */
export const withLaunchRecorded = (
  launches: readonly SiteLaunch[],
  launch: SiteLaunch,
  now: Date,
): SiteLaunch[] => {
  const from = now.getTime() - LAUNCH_LEDGER_HOURS * AN_HOUR_IN_MS;
  return [...launches.filter((recorded) => recorded.id !== launch.id), launch].filter(
    (recorded) => Date.parse(recorded.at) > from,
  );
};
