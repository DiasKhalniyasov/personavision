/**
 * Whether the browser these suites drive is on this machine.
 *
 * The rule is this package's and is nine suites old (`packages/browser/README.md`): a
 * developer without the binary is skipped with the reason in the suite's name, and CI is
 * not. It is stated here so that a suite outside this package which drives a real session —
 * `packages/swarm`'s video suite — can follow the same rule without taking a dependency on
 * `playwright` of its own, which is what resolving it from there would mean.
 */

import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

export const CHROMIUM_INSTALLED = existsSync(chromium.executablePath());
