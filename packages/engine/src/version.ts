/**
 * Which engine this is.
 *
 * The run artifact names it — `run.engine.version` (#92) — so a run can be matched against
 * the committed calibration report (#89), whose every row carries the same string, and
 * against `config/calibrated.json`'s own `engine.version`, which says which engine the
 * fitted values were measured on. Read from the package's own manifest, so it is not a
 * string anybody types.
 *
 * `packages/calibration/src/score/score.ts` derives the same fact its own way — by resolving
 * the declared dependency and reading the manifest it finds — because it has to report the
 * version of the engine it actually imported, which is a stronger claim than this module
 * makes. Those two agree in this workspace and are free to be collapsed into one; this is
 * the one a run artifact reads.
 *
 * A **build-time import**, as the calibrated configuration is: the engine reads no file and
 * opens no socket at run time, which `tests/config.test.ts`'s purity suite asserts over
 * these sources. The specifier resolves the same from `src/` and from `dist/`, because both
 * published entry points sit one directory inside the package.
 */

import manifest from '../package.json' with { type: 'json' };

export const ENGINE_VERSION: string = manifest.version;
