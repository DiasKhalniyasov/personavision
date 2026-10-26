import type { Persona } from '@personavision/contract';

/**
 * The four corners of an audience's behaviour, and the names the product calls them by.
 *
 * An audience states a centre — how tech-confident its people are, how much price matters,
 * how old they are — and the centre alone would generate one person `size` times. What makes
 * a swarm worth running is the spread around it, so generation places each person at a named
 * corner of the trait space and samples around that. The corner is what the product shows: a
 * row on the Sessions screen reads *Rushed buyer* and a segment reads `mobile · in a hurry`,
 * because the user asked about their customers rather than about a vector of six numbers.
 *
 * **These four are the design contract's, not this file's invention.**
 * `docs/design/prototype.html` names them in its `PERSONAS` constant and draws them in the
 * Audience screen's `.personagrid` with the behaviour each one stands for — *desktop · low
 * familiarity · patient*, *mobile · scanning · impatient*, *desktop · reading ·
 * detail-oriented*, *mobile · scanning · price-led*. The committed example run records the
 * same four. The offsets below are those descriptions written as numbers, and the order is
 * the prototype's.
 *
 * Two properties hold the table honest, and `tests/archetypes.test.ts` asserts both:
 *
 * 1. **Every column sums to zero.** The corners displace people around the audience's centre
 *    without moving it, so the median of a generated set tracks the audience and the mapping
 *    from an audience field to a trait stays monotonic. A column that did not sum to zero
 *    would make "raising `priceSensitivity` raises `detailOrientation`" depend on how many
 *    people happened to be generated.
 * 2. **No offset leaves 0..1 reachable.** An offset is added to the centre and clamped, so a
 *    corner is a direction and a distance, never an absolute value: an audience at the end of
 *    a scale keeps its spread in the direction it still has room in.
 */
export interface Archetype {
  /** The persona id the first person at this corner carries: the prototype's own ids. */
  readonly id: string;
  /** The name the product prints. */
  readonly name: string;
  /** The second clause of `segment`, after the device: `mobile · in a hurry`. */
  readonly segmentClause: string;
  /**
   * Whether this behaviour belongs on a touch device. The audience's shares decide **how
   * many** people are on each device; this decides **who** has first claim on them, so the
   * phone-shaped behaviours fill the phone share before a desk-shaped one spills onto it.
   */
  readonly prefersTouch: boolean;
  /** Added to the audience's centre for each trait, before the seeded jitter and the clamp. */
  readonly offsets: Readonly<Persona['traits']>;
}

export const ARCHETYPES: readonly Archetype[] = [
  {
    id: 'rushed',
    name: 'Rushed buyer',
    segmentClause: 'in a hurry',
    prefersTouch: true,
    offsets: {
      persistence: -0.3,
      scanningVsReading: 0.3,
      detailOrientation: -0.3,
      interfaceFamiliarity: 0.25,
      patience: -0.3,
      riskTolerance: 0.35,
    },
  },
  {
    id: 'careful',
    name: 'Careful comparer',
    segmentClause: 'compares carefully',
    prefersTouch: false,
    offsets: {
      persistence: 0.25,
      scanningVsReading: -0.35,
      detailOrientation: 0.3,
      interfaceFamiliarity: 0.1,
      patience: 0.35,
      riskTolerance: -0.2,
    },
  },
  {
    id: 'firsttime',
    name: 'First-time visitor',
    segmentClause: 'first visit',
    prefersTouch: false,
    offsets: {
      persistence: 0,
      scanningVsReading: -0.2,
      detailOrientation: -0.15,
      interfaceFamiliarity: -0.4,
      patience: 0.15,
      riskTolerance: -0.1,
    },
  },
  {
    id: 'price',
    name: 'Price-sensitive scanner',
    segmentClause: 'price-sensitive',
    prefersTouch: true,
    offsets: {
      persistence: 0.05,
      scanningVsReading: 0.25,
      detailOrientation: 0.15,
      interfaceFamiliarity: 0.05,
      patience: -0.2,
      riskTolerance: -0.05,
    },
  },
];

/** The traits, in the order the contract declares them, so a draw order is stated once. */
export const TRAIT_NAMES = [
  'persistence',
  'scanningVsReading',
  'detailOrientation',
  'interfaceFamiliarity',
  'patience',
  'riskTolerance',
] as const satisfies readonly (keyof Persona['traits'])[];
