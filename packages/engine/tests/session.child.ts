/**
 * One session, in a process of its own: the other half of the end-to-end determinism test
 * in `behaviour.test.ts`.
 *
 * The request arrives as JSON on the command line and the session goes out on stdout, so
 * the two sides share one declaration of the request rather than two copies that could
 * drift. Run it as `node --conditions development --import tsx <this file> '<request json>'`.
 */

import { runSession } from './harness.js';
import type { SessionRequest } from './harness.js';

const request = JSON.parse(process.argv[2] ?? '') as SessionRequest;
const { session } = await runSession(request);
process.stdout.write(JSON.stringify(session));
