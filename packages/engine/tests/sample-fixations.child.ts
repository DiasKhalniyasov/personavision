/**
 * One sampling, in a process of its own: the other half of the cross-process determinism
 * test in `sample-fixations.test.ts`.
 *
 * The input arrives as JSON on the command line and the scanpath goes out on stdout, so
 * the two sides share one declaration of the input rather than two copies that could
 * drift. Run it as `node --conditions development --import tsx <this file> '<input json>'`.
 */

import { sampleFixations } from '../src/sampling/index.js';
import type { SampleFixationsInput } from '../src/sampling/index.js';

const input = JSON.parse(process.argv[2] ?? '') as SampleFixationsInput;
process.stdout.write(JSON.stringify(sampleFixations(input)));
