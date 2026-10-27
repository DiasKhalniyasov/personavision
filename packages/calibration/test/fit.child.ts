/**
 * The second process of the cross-process determinism check in `fit.test.ts` (#90).
 *
 * It fits the engine at the seed and candidate count it is given and writes the fit —
 * everything but the wall-clock timings — to standard output. The test runs the same call in
 * its own process and compares the text: a candidate drawn from an unseeded source, or a
 * figure that depended on a clock, would differ here, and a fit a reviewer cannot replay is
 * not a fit.
 *
 * Shaped after `score.child.ts`, which does the same for a scoring run (#88).
 */

import { comparableFit, fit } from '../src/index.js';

const seed = Number(process.argv[2]);
const candidates = Number(process.argv[3]);

process.stdout.write(comparableFit(await fit({ seed, candidates })));
