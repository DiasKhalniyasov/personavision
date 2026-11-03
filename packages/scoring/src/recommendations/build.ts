import type { Recommendations, Run, Session } from '@personavision/contract';
import type { Finding } from '../findings/index.js';

/**
 * The recommendations builder: the **caller** of Muse Wonder, not the writer of its words.
 *
 * It assembles the document Wonder reads — the aggregate of every session, plus the twenty
 * whole sessions `sampleSessions` draws — calls the one-shot seam, checks the reply,
 * attaches the findings each recommendation rests on and the citations behind them, ranks
 * them and stores the rank. The prompt and the sentences belong to the Muse Wonder step
 * (#219, by the handoff on #224); nothing in this package writes either, and the model
 * call is passed in rather than made here.
 */

/**
 * What the builder is given.
 *
 * #258 settles the rest of this shape in this file — the Wonder seam of #219 and the
 * aggregate of #287 are both fields it adds, and neither type exists yet, so neither is
 * guessed at here. Because `recommendations/index.ts` re-exports this interface **by
 * name**, adding to it costs that file no edit and #260 no conflict.
 */
export interface RecommendationsInput {
  /** The run the recommendations are about: its id, its steps and its personas. */
  readonly run: Run;
  /** Every session the run produced, automation failures among them. */
  readonly sessions: readonly Session[];
  /** The findings a recommendation names in `findingIds`: what happened, to its what-to-do. */
  readonly findings: readonly Finding[];
  /** What the sample is drawn with — the run's own seed, so the same run reads the same twenty. */
  readonly seed: number;
}

/** The signature #258 implements. Asynchronous: the body of it is one model call. */
export type RecommendationsBuilder = (input: RecommendationsInput) => Promise<Recommendations>;

/**
 * Not built yet: **#258** fills this in. It is declared here, with its agreed shape, so
 * that #258 and #260 can be worked at the same time rather than queueing behind one barrel
 * file — each replaces one body in its own file and neither edits
 * `recommendations/index.ts` or `../index.ts`.
 */
export const buildRecommendations: RecommendationsBuilder = () => {
  throw new Error(
    'buildRecommendations() is not implemented yet: the builder through the Muse Wonder seam is ticket #258',
  );
};
