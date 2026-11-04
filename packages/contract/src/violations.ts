/**
 * What is wrong with a run artifact, and where.
 *
 * One shape, declared once: `validate` reports these, `readRun` and `writeRun` throw with
 * them, and every checker in this package — the reader in `io.ts`, the citation validator
 * in `recommendations.ts` — builds them the same way. It is a type and two pure functions
 * and reaches no file system, so a checker can live in its own module without the reader
 * pulling it, and this module pulling `node:fs`, back the other way.
 */

/** One thing wrong with a run directory, at the place it is wrong. */
export interface Violation {
  /** The file, run-directory-relative — `run.json`, `sessions/S-01.json`, `findings.json`. */
  file: string;
  /** An RFC 6901 JSON Pointer to the offending value; `''` is the whole document. */
  path: string;
  message: string;
}

/** An RFC 6901 JSON Pointer out of the path segments zod and the checkers address a value by. */
export const pointer = (path: ReadonlyArray<PropertyKey>): string =>
  path.map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

/** One violation, at a path spelt as segments rather than as a pointer by hand. */
export const at = (file: string, path: ReadonlyArray<PropertyKey>, message: string): Violation => ({
  file,
  path: pointer(path),
  message,
});
