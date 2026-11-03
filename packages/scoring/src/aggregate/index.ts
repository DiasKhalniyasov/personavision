/**
 * The aggregate surface of `@personavision/scoring`: every figure the two filtered screens
 * of the results page read, computed once when a run is aggregated (`docs/FLOW.md` section
 * 14, against `#screen-funnel` and `#screen-heatmaps` of `docs/design/prototype.html`).
 *
 * `sessions.ts` is the **shared reading** this step is built on, and the only one of these
 * files that is built: who counts, when each step started, which slices exist, and what a
 * quantile is. Everything else here is the surface the figures fill — `funnel.ts` and
 * `paths.ts` (#289), `timing.ts` (#290), `screens.ts` (#291) and `compose.ts` (#292) each
 * carry their agreed signature and a body that throws and names the ticket that fills it.
 *
 * That is deliberate scaffolding, the way the scoring barrel beside it was declared for
 * #27, #28 and #29 and the recommendations barrel for #258 and #260: **each later ticket
 * replaces one body in its own file, and none of them has to edit this file or
 * `../index.ts`**, so the figures can be worked at the same time rather than queueing
 * behind one barrel. A caller that arrives before a figure exists fails loudly, with the
 * ticket number in the message, rather than reading a shape of zeroes.
 *
 * Pure, like the rest of the package: contract-typed data in, plain objects out, no disk,
 * no network and no browser.
 */

export {
  BIN_COUNT,
  distributionOf,
  funnelSliceSpecs,
  quantileMs,
  SCORED_OUTCOMES,
  scoredSessions,
  screenIndexAt,
  screenSliceSpecs,
  segmentOf,
  stepWalk,
} from './sessions.js';
export type {
  FunnelSliceSpec,
  ScoredOutcome,
  ScoredSessions,
  ScreenSliceSpec,
  StepSpan,
} from './sessions.js';

export { funnelOfSlice } from './funnel.js';
export type { FunnelBuilder, FunnelInput } from './funnel.js';

export { pathsOfSlice } from './paths.js';
export type { PathsBuilder, PathsInput } from './paths.js';

export { timingOfSlice } from './timing.js';
export type { TimingBuilder, TimingInput } from './timing.js';

export { screenFiguresOfSlice } from './screens.js';
export type { ScreenFiguresBuilder, ScreenFiguresInput } from './screens.js';

export { composeAggregate } from './compose.js';
export type { AggregateComposer, AggregateInput } from './compose.js';
