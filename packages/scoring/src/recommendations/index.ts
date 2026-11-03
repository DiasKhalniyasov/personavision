/**
 * The recommendations surface of `@personavision/scoring`: what to change, ranked, each
 * one citing its evidence (`docs/FLOW.md` sections 14 and 16).
 *
 * Three things, in the order the pipeline uses them. The **sample** of whole sessions Muse
 * Wonder reads beside the aggregate of every one. The **builder**, which assembles that
 * document, calls the Wonder seam, attaches the findings and the citations, and stores the
 * rank. And the **write-up**, generated from the recommendations the builder produced, as
 * the block the Analysis screen renders.
 *
 * The whole surface is declared here before two of the three are built, the way the
 * scoring barrel beside it was declared for #27, #28 and #29: `build.ts` and `writeUp.ts`
 * carry their agreed signatures and bodies that throw and name the ticket that fills them.
 * That is deliberate scaffolding, not an oversight — **#258 and #260 each replace one body
 * in its own file, and neither has to edit this file or `../index.ts`**, so the two can be
 * worked at the same time rather than queueing behind one barrel.
 *
 * Pure, like the rest of the package: contract-typed data in, plain objects out, no disk,
 * no network and no browser. The model call the builder makes is handed to it.
 */

export { SAMPLE_SIZE, SAMPLE_STRATEGY, sampleSessions, WHOLE_RUN_STRATEGY } from './sample.js';
export type { SessionSample, SessionSampler } from './sample.js';

export { buildRecommendations } from './build.js';
export type { RecommendationsBuilder, RecommendationsInput } from './build.js';

export { writeUp } from './writeUp.js';
export type { WriteUpGenerator, WriteUpInput } from './writeUp.js';
