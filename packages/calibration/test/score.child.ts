/**
 * The second process of the cross-process determinism check in `score.test.ts` (#88).
 *
 * It scores the engine over the committed corpus at the seed it is given and writes the
 * figures — everything but the wall-clock timings — to standard output. The test runs the
 * same call in its own process and compares the text: a figure that depended on a clock, on
 * an unseeded draw or on the order a map was iterated in would differ here, which is what
 * lets #90 replay a fit and #89 gate on a number.
 *
 * Shaped after `packages/engine/tests/session.child.ts`, which does the same for a session.
 */

import { committedCorpus, comparableFigures, enginePredictor, score } from '../src/index.js';

const seed = Number(process.argv[2]);

const result = await score({ predictor: enginePredictor(), corpus: committedCorpus(), seed });

process.stdout.write(comparableFigures(result));
