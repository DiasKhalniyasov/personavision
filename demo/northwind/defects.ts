/**
 * The northwind shop's planted-defect ground truth, read and validated in one place.
 *
 * `defects.json` beside this file is the declared answer: the three defects variant B was
 * built with. This module is how anything reads it. The point of having a loader at all
 * rather than an `import` of the JSON is that a ground truth rots in two directions, and
 * both of them are caught here instead of showing up as a score nobody can explain:
 *
 * - **A rule gets renamed.** Every `ruleId` is checked against `FINDING_RULE_IDS`, so a
 *   renamed rule throws on load rather than quietly dropping recall to zero — the
 *   evaluation matches on rule id, and an id no rule carries can never be matched.
 * - **The shop changes and the file does not.** `shopRegionOf` turns a declared `aoiId`
 *   back into the `data-aoi` value the shop's markup carries, which is what lets
 *   `test/defects.test.ts` ask the shop's own server whether each declared region is still
 *   on the page. A ground truth describing a defect the shop no longer has is worse than
 *   none.
 *
 * **Two things the next tickets have to reconcile, and this file cannot.** Both make recall
 * read 0.0 today, for reasons no screen explains, and both are recorded on #76.
 *
 * 1. **The area ids.** `aoiId` is written in the run artifact's scheme,
 *    `<variant>-<step>-<data-aoi>`, because that is what the committed example run carries
 *    in its `aois` and its findings and what `evaluateAgainstPlantedDefects` compares
 *    against. The live pipeline does not mint ids that way:
 *    `packages/browser/src/extract/stable-id.ts` hashes role, name and box on purpose and
 *    deliberately never reads `data-aoi`, and `packages/engine/src/aois/aoi-id.ts` composes
 *    the box into the id. So the first real run (#78) will produce area ids that are not
 *    equal to the ones declared here, and the acceptance harness (#79) has to close the gap
 *    — by projecting the shop's `data-aoi` into the artifact's area ids, or by matching on
 *    something stabler than an id. Declaring the hashed ids instead is not an option: they
 *    are not knowable before the run, and a ground truth written from the run it scores is
 *    not a ground truth.
 * 2. **The finding ids.** `findingRuleIdOf` reads the rule off the finding's own id, which
 *    `findings()` spells `<ruleId>@<variant>`. The committed example run is a hand-authored
 *    seed whose findings are `F-1` … `F-6`, so every one of them derives `ruleId: null` and
 *    can be credited to nothing. #78 replaces that seed with a generated run, which fixes
 *    it; until then, a sanity check of this file has to score `findings()` output rather
 *    than the committed `findings.json`.
 */

import { readFileSync } from 'node:fs';
import { FINDING_RULE_IDS, type FindingRuleId, type PlantedDefect } from '@personavision/scoring';

/** Where the committed ground truth lives. */
const DEFECTS_FILE = new URL('./defects.json', import.meta.url);

/**
 * How many defects variant B carries. Fixed by #10's user story 4 and `docs/FLOW.md` §7
 * beat 3, which both say three; a file with a fourth entry is a changed claim and not a
 * changed fixture, so it throws here.
 */
const DECLARED_COUNT = 3;

/** A real defect in the shop that is deliberately **not** one of the declared three. */
export interface UndeclaredDefect extends DefectLocation {
  /** What it is, in one sentence. */
  readonly what: string;
  /** Why it is left out, and what leaving it out costs. */
  readonly why: readonly string[];
}

/**
 * The whole committed file: the three defects, and the prose that keeps them honest.
 *
 * The documentation is loaded and validated beside the data rather than left as comments,
 * which JSON cannot carry anyway, so that it cannot go missing without a test noticing.
 */
export interface DeclaredDefects {
  /** What the file is, and how it is matched. */
  readonly about: readonly string[];
  /** The three, in declared order — which is the order `matched` comes back in. */
  readonly defects: readonly PlantedDefect[];
  readonly notDeclared: readonly UndeclaredDefect[];
  /** Why precision is bounded below 1.0 by construction. */
  readonly precision: readonly string[];
}

/** A file that does not conform, and the JSON Pointer to the part that does not. */
export class DeclaredDefectsError extends Error {
  /** JSON Pointer into the file, e.g. `/defects/1/ruleId`. */
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`defects.json: ${path === '' ? 'the document' : path} ${problem}`);
    this.name = 'DeclaredDefectsError';
    this.path = path;
  }
}

const fail = (path: string, problem: string): never => {
  throw new DeclaredDefectsError(path, problem);
};

const asRecord = (value: unknown, path: string): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(path, 'is not an object');

const asString = (value: unknown, path: string): string =>
  typeof value === 'string' && value.trim() !== ''
    ? value
    : fail(path, 'is not a non-empty string');

const asArray = (value: unknown, path: string): readonly unknown[] =>
  Array.isArray(value) ? value : fail(path, 'is not an array');

/** Exactly these fields, no fewer and no more, so a typo is a failure and not a default. */
const exactFields = (
  record: Record<string, unknown>,
  path: string,
  fields: readonly string[],
): void => {
  for (const field of fields) {
    if (!(field in record)) fail(`${path}/${field}`, 'is missing');
  }
  for (const field of Object.keys(record)) {
    if (!fields.includes(field)) fail(`${path}/${field}`, 'is not a field of this shape');
  }
};

/** A committed paragraph or three. Empty prose is a failure: the prose is part of the file. */
const asProse = (value: unknown, path: string): readonly string[] => {
  const lines = asArray(value, path);
  if (lines.length === 0) fail(path, 'is empty, and this file documents itself');
  return lines.map((line, index) => asString(line, `${path}/${index}`));
};

const DEFECT_FIELDS = ['id', 'ruleId', 'variant', 'step', 'aoiId', 'description'] as const;

const toPlantedDefect = (value: unknown, path: string): PlantedDefect => {
  const record = asRecord(value, path);
  exactFields(record, path, DEFECT_FIELDS);

  const ruleId = asString(record.ruleId, `${path}/ruleId`);
  if (!(FINDING_RULE_IDS as readonly string[]).includes(ruleId)) {
    fail(`${path}/ruleId`, `is not one of FINDING_RULE_IDS (${FINDING_RULE_IDS.join(', ')})`);
  }

  return {
    id: asString(record.id, `${path}/id`),
    ruleId: ruleId as FindingRuleId,
    variant: asString(record.variant, `${path}/variant`),
    step: asString(record.step, `${path}/step`),
    // `null` is the shape's way of saying the whole step is the defect, so it is a value
    // here and not a missing field.
    aoiId: record.aoiId === null ? null : asString(record.aoiId, `${path}/aoiId`),
    description: asString(record.description, `${path}/description`),
  };
};

const UNDECLARED_FIELDS = ['what', 'variant', 'step', 'aoiId', 'why'] as const;

const toUndeclaredDefect = (value: unknown, path: string): UndeclaredDefect => {
  const record = asRecord(value, path);
  exactFields(record, path, UNDECLARED_FIELDS);
  return {
    what: asString(record.what, `${path}/what`),
    variant: asString(record.variant, `${path}/variant`),
    step: asString(record.step, `${path}/step`),
    aoiId: record.aoiId === null ? null : asString(record.aoiId, `${path}/aoiId`),
    why: asProse(record.why, `${path}/why`),
  };
};

const DOCUMENT_FIELDS = ['about', 'defects', 'notDeclared', 'precision'] as const;

/**
 * Validate an already-parsed document. Separate from reading the file so that every way of
 * being wrong can be tested on an object, without a fixture file per failure.
 */
export const parseDeclaredDefects = (value: unknown): DeclaredDefects => {
  const document = asRecord(value, '');
  exactFields(document, '', DOCUMENT_FIELDS);

  const entries = asArray(document.defects, '/defects');
  if (entries.length !== DECLARED_COUNT) {
    fail('/defects', `holds ${entries.length} entries and the planted set is ${DECLARED_COUNT}`);
  }

  const defects = entries.map((entry, index) => toPlantedDefect(entry, `/defects/${index}`));
  defects.forEach((defect, index) => {
    const first = defects.findIndex((candidate) => candidate.id === defect.id);
    // A repeated id makes `matched` ambiguous: two entries would answer to one name.
    if (first !== index)
      fail(`/defects/${index}/id`, `repeats "${defect.id}" from /defects/${first}`);
  });

  const notDeclared = asArray(document.notDeclared, '/notDeclared');
  if (notDeclared.length === 0) {
    fail('/notDeclared', 'is empty: the payment-step mislabel belongs in it');
  }

  return {
    about: asProse(document.about, '/about'),
    defects,
    notDeclared: notDeclared.map((entry, index) =>
      toUndeclaredDefect(entry, `/notDeclared/${index}`),
    ),
    precision: asProse(document.precision, '/precision'),
  };
};

/** Read and validate the file. Throws `DeclaredDefectsError` naming the offending path. */
export const loadDeclaredDefects = (file: URL | string = DEFECTS_FILE): DeclaredDefects => {
  const text = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new DeclaredDefectsError('', `is not JSON: ${(cause as Error).message}`);
  }
  return parseDeclaredDefects(parsed);
};

let loaded: DeclaredDefects | undefined;

/**
 * The committed ground truth, read once. This is the one place to get it: a consumer that
 * parsed `defects.json` itself would be a second copy of the shape and of the validation.
 */
export const declaredDefects = (): DeclaredDefects => (loaded ??= loadDeclaredDefects());

/**
 * The three fields that locate a defect, declared or not, so one function serves both. They
 * travel together everywhere: an area of interest takes all three to identify, because a
 * rule about a whole step reports `aoiId: null` and two steps of two variants would then
 * look alike.
 */
export interface DefectLocation {
  readonly variant: string;
  readonly step: string;
  readonly aoiId: string | null;
}

/**
 * The shop's own `data-aoi` value for a located defect, or `null` when the whole step is the
 * defect rather than one area of it.
 *
 * A declared `aoiId` is `<variant>-<step>-<data-aoi>`, so the region is what is left once
 * its own variant and step are taken off the front. An id that does not start that way is a
 * scheme change rather than a typo, and throws: without the region there is no way to ask
 * the shop whether the defect is still there.
 */
export const shopRegionOf = (located: DefectLocation): string | null => {
  if (located.aoiId === null) return null;
  const prefix = `${located.variant}-${located.step}-`;
  if (!located.aoiId.startsWith(prefix)) {
    throw new DeclaredDefectsError(
      `(${located.aoiId})`,
      `is not in the artifact's scheme "${prefix}<data-aoi>"`,
    );
  }
  return located.aoiId.slice(prefix.length);
};
