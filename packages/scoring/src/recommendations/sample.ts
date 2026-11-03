import {
  createSeededRandom,
  type Persona,
  type SampleProvenance,
  type Session,
} from '@personavision/contract';

/**
 * The sample Muse Wonder reads: twenty whole sessions, beside the aggregate of every one.
 *
 * A hundred session files do not fit in a prompt, and a mean does not say why anybody
 * left. So the recommendations rest on two things — the aggregate, which covers the whole
 * run, and a sample of whole sessions chosen the way an analyst picks what to watch: by
 * covering each outcome and each part of the audience rather than by taking the first
 * twenty off the disk (the decision on #224).
 *
 * **Stratified by outcome, then by segment.** Every outcome the run produced gets a place,
 * and the rest of the places are shared in proportion to the run; inside an outcome the
 * same is done over the `segment` label the personas were generated with, so a
 * recommendation about the people on phones has phones behind it. The draw inside a
 * stratum is `createSeededRandom` from the run's own seed, so the same run always reads
 * the same twenty, in the same order, on any platform.
 *
 * **An automation failure is never sampled, and never counted.** It is our own failure,
 * not the product's, so it is out of the sample and out of `of`: the provenance line reads
 * *"Read 20 of 93 sessions"* about the ninety-three the run is about, not about the
 * hundred that landed on the disk. The flag is read off the session's
 * `excludedFromScores`, exactly as `score.ts` and the aggregate read it and never
 * re-derived — and a session whose `status` says `automation_failure` is skipped whatever
 * the flag says, so the two spellings cannot disagree their way into the sample.
 *
 * Pure: sessions and personas in, a sample and its provenance out. No disk, no clock and
 * no `Math.random`.
 */

/**
 * How many whole sessions Wonder reads. Twenty — the number the prototype's Analysis
 * screen already prints, and the one place it is written down: raising it later is an edit
 * to this constant and not a redesign.
 */
export const SAMPLE_SIZE = 20;

/**
 * What the Analysis screen prints beside *"Read 20 of 93 sessions"*. The contract takes
 * the strategy as the sampler's own words and never parses it, so this phrase is display
 * text that belongs to this module (the decision on #249).
 */
export const SAMPLE_STRATEGY = 'stratified by outcome, then segment';

/**
 * What a run small enough to be read whole says instead. Nothing was chosen, so claiming a
 * stratification would be a sentence about a draw that never happened.
 */
export const WHOLE_RUN_STRATEGY = 'every session of the run';

/**
 * The three product outcomes, in the order the sample is stratified by and comes back in.
 * An automation failure is not one of them; `docs/FLOW.md` section 8 never merges it with
 * the other three.
 */
const OUTCOMES: ReadonlyArray<Exclude<Session['outcome']['status'], 'automation_failure'>> = [
  'success',
  'abandoned',
  'failed',
];

/**
 * The stratum a session with nobody behind it falls in: a real recorded session, which
 * carries a participant and no persona, and a simulated one whose persona the run does not
 * name. It is a stratum rather than a reason to drop the session, so such a run is still
 * read.
 */
const NO_SEGMENT = 'no segment';

/** The sample, and the provenance block `recommendations.json` carries it under. */
export interface SessionSample {
  /** The whole sessions that were read, stratum by stratum. */
  readonly sessions: readonly Session[];
  /** `read`, `of`, `strategy` and `seed`, as the contract's `sample` block spells them. */
  readonly sample: SampleProvenance;
}

/**
 * The sampler's signature. The personas are a second argument because a session records
 * only whose it was — the `segment` label lives on the run's `personas`, and this package
 * resolves it rather than asking every caller to flatten it in first.
 */
export type SessionSampler = (
  sessions: readonly Session[],
  personas: readonly Persona[],
  seed: number,
  size?: number,
) => SessionSample;

/**
 * Whether a session is out of the run the recommendations are about.
 *
 * `excludedFromScores` is the stored answer and is read, never re-derived. The status is
 * checked beside it rather than instead of it: `score.ts` throws on a session that says
 * `automation_failure` with the flag unset, and a sampler that merely trusted the flag
 * would put our own breakage in front of Wonder as product evidence and count it in `of`.
 */
const isExcluded = (session: Session): boolean =>
  session.outcome.excludedFromScores || session.outcome.status === 'automation_failure';

/** A total order on strings that is the same in every engine: code units, never a locale. */
const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * How the places of a sample are shared between strata.
 *
 * One place to every stratum the run produced, so an outcome the run has is never rounded
 * away; then the rest in proportion to the run, with the places the rounding leaves over
 * going to the largest remainders, so the places add up to the sample size exactly rather
 * than to the sum of twenty roundings. A stratum offered more places than it has sessions
 * keeps what it can hold and the rest pass on to the next stratum with room, so a stratum
 * too small to fill shortens nobody's sample but its own — the first stratum in order with
 * room takes the place, rather than the place being lost.
 *
 * Every tie is broken on the stratum's size and then on its position, both of which the
 * caller fixes, so the same counts always share the places the same way.
 */
const allocate = (places: number, counts: readonly number[]): number[] => {
  const quotas = counts.map(() => 0);
  const occupied = counts
    .map((count, index) => ({ count, index }))
    .filter((stratum) => stratum.count > 0);
  const population = occupied.reduce((total, stratum) => total + stratum.count, 0);
  if (places <= 0 || population === 0) return quotas;

  // Biggest first, so that when there are more strata than places the places go to the
  // strata most of the run is in rather than to whichever happened to come first.
  let left = places;
  for (const stratum of [...occupied].sort((a, b) => b.count - a.count || a.index - b.index)) {
    if (left === 0) break;
    quotas[stratum.index] = 1;
    left -= 1;
  }

  const shares = occupied.map((stratum) => {
    const exact = (left * stratum.count) / population;
    const whole = Math.floor(exact);
    return { ...stratum, whole, remainder: exact - whole };
  });
  for (const share of shares) quotas[share.index] += share.whole;

  let rounded = left - shares.reduce((total, share) => total + share.whole, 0);
  for (const share of [...shares].sort(
    (a, b) => b.remainder - a.remainder || b.count - a.count || a.index - b.index,
  )) {
    if (rounded === 0) break;
    quotas[share.index] += 1;
    rounded -= 1;
  }

  let spare = 0;
  for (const stratum of occupied) {
    if (quotas[stratum.index] <= stratum.count) continue;
    spare += quotas[stratum.index] - stratum.count;
    quotas[stratum.index] = stratum.count;
  }
  while (spare > 0) {
    const taker = occupied.find((stratum) => quotas[stratum.index] < stratum.count);
    if (taker === undefined) break;
    quotas[taker.index] += 1;
    spare -= 1;
  }

  return quotas;
};

/**
 * `howMany` of `pool`, drawn without replacement from the run's seeded random.
 *
 * Fisher–Yates over a copy, stopped once enough have been taken: one draw per session
 * returned, so the sequence a stratum consumes depends on its quota and not on how many
 * sessions it happened to hold.
 */
const draw = (pool: readonly Session[], howMany: number, random: () => number): Session[] => {
  const left = [...pool];
  const drawn: Session[] = [];
  while (drawn.length < howMany && left.length > 0) {
    const [taken] = left.splice(Math.floor(random() * left.length), 1);
    drawn.push(taken);
  }
  return drawn;
};

/**
 * The strata of a set of sessions: what each one's stratum is called, grouped, and put in
 * the order the caller's comparison fixes. Both levels of the stratification are divided
 * by this, so an outcome and a segment are grouped by the same code.
 */
const stratify = (
  sessions: readonly Session[],
  keyOf: (session: Session) => string,
  before: (left: string, right: string) => number,
): ReadonlyArray<readonly Session[]> => {
  const strata = new Map<string, Session[]>();
  for (const session of sessions) {
    const key = keyOf(session);
    const held = strata.get(key);
    if (held === undefined) strata.set(key, [session]);
    else held.push(session);
  }
  return [...strata.entries()]
    .sort(([left], [right]) => before(left, right))
    .map(([, held]) => held);
};

/** Where an outcome sorts, and `OUTCOMES.length` for one this module does not name. */
const rankOf = (status: string): number => {
  const at = (OUTCOMES as readonly string[]).indexOf(status);
  return at === -1 ? OUTCOMES.length : at;
};

/**
 * The outcomes in the agreed order. An outcome the contract gains later and `OUTCOMES`
 * does not name sorts last rather than being dropped: it is still something that happened
 * to somebody, and a session missing from the sample while still counted in `of` would be
 * a sample that does not cover the run it says it does.
 */
const byOutcome = (left: string, right: string): number =>
  rankOf(left) - rankOf(right) || byCodeUnit(left, right);

/**
 * Twenty whole sessions of this run, and how they were chosen.
 *
 * The sample comes back stratum by stratum — the outcomes in the order `OUTCOMES` fixes,
 * each outcome's segments in order, and inside a segment the order they were drawn in — so
 * the document the builder assembles reads as a covering of the run rather than as a list.
 * The sessions are sorted by id before anything is drawn, so the sample depends on the set
 * of sessions and the seed and **not** on the order the caller passed them in.
 */
export const sampleSessions: SessionSampler = (sessions, personas, seed, size = SAMPLE_SIZE) => {
  const segmentByPersona = new Map(personas.map((persona) => [persona.id, persona.segment]));
  const segmentOf = (session: Session): string => {
    const personaId = session.persona?.id;
    return (personaId === undefined ? undefined : segmentByPersona.get(personaId)) ?? NO_SEGMENT;
  };

  const run = [...sessions]
    .filter((session) => !isExcluded(session))
    .sort((left, right) => byCodeUnit(left.sessionId, right.sessionId));

  const of = run.length;
  if (of <= size) {
    return { sessions: run, sample: { read: of, of, strategy: WHOLE_RUN_STRATEGY, seed } };
  }

  const outcomes = stratify(run, (session) => session.outcome.status, byOutcome);
  const outcomePlaces = allocate(
    size,
    outcomes.map((held) => held.length),
  );

  const random = createSeededRandom(seed);
  const drawn: Session[] = [];
  outcomes.forEach((held, outcome) => {
    const segments = stratify(held, segmentOf, byCodeUnit);
    const segmentPlaces = allocate(
      outcomePlaces[outcome],
      segments.map((stratum) => stratum.length),
    );
    segments.forEach((stratum, segment) => {
      drawn.push(...draw(stratum, segmentPlaces[segment], random));
    });
  });

  return { sessions: drawn, sample: { read: drawn.length, of, strategy: SAMPLE_STRATEGY, seed } };
};
