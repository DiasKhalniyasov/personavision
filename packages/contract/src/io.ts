import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { z } from 'zod';
import { runPaths, sessionIdFromFileName } from './paths.js';
import type { Findings, Run, Session } from './schemas.js';
import { findingsSchema, runSchema, sessionSchema } from './schemas.js';

/**
 * Reading, writing and validating a whole run directory. A round trip through disk is
 * type-checked at both ends: the writer parses what it is given before it writes, and the
 * reader parses what it finds before it returns it.
 */

/** One thing wrong with a run directory, at the place it is wrong. */
export interface Violation {
  /** The file, run-directory-relative — `run.json`, `sessions/S-01.json`, `findings.json`. */
  file: string;
  /** An RFC 6901 JSON Pointer to the offending value; `''` is the whole document. */
  path: string;
  message: string;
}

/** Every artifact file of one run, parsed. Sessions come in `run.sessionIds` order. */
export interface RunArtifact {
  run: Run;
  sessions: Session[];
  findings: Findings;
}

/** The layout again, addressed relatively, for the `file` of a violation. */
const relative = runPaths('');

const pointer = (path: ReadonlyArray<PropertyKey>): string =>
  path.map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

const at = (file: string, path: ReadonlyArray<PropertyKey>, message: string): Violation => ({
  file,
  path: pointer(path),
  message,
});

const readJsonFile = async (
  file: string,
  label: string,
  violations: Violation[],
): Promise<unknown> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const message =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'missing from the run directory'
        : `could not be read: ${(error as Error).message}`;
    violations.push({ file: label, path: '', message });
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    violations.push({
      file: label,
      path: '',
      message: `not valid JSON: ${(error as Error).message}`,
    });
    return undefined;
  }
};

const parse = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  label: string,
  violations: Violation[],
): z.infer<Schema> | undefined => {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    violations.push({ file: label, path: pointer(issue.path), message: issue.message });
  }
  return undefined;
};

/**
 * The checks that span more than one value: every reference out of one artifact file names
 * something the run declares, and `run.sessionIds` agrees with the sessions that exist.
 *
 * Step ids are deliberately not checked: `run.steps` enumerates the task's own steps, and
 * a session may legitimately end somewhere the run never planned to go.
 */
const checkReferences = (
  run: Run,
  sessions: ReadonlyArray<Session>,
  findings: Findings | undefined,
  violations: Violation[],
): void => {
  const declaredAois = new Set(run.aois.map((aoi) => aoi.id));
  const declaredVariants = new Set(run.variants.map((variant) => variant.id));
  const danglingAoi = (aoiId: string): string =>
    `"${aoiId}" names no area of interest declared in this run's aois`;
  const danglingVariant = (variant: string): string =>
    `"${variant}" names no variant declared in this run's variants`;

  run.aoiMetrics.forEach((metric, index) => {
    if (!declaredAois.has(metric.aoiId)) {
      violations.push(at(relative.run, ['aoiMetrics', index, 'aoiId'], danglingAoi(metric.aoiId)));
    }
  });
  const runVariantReferences: ReadonlyArray<[string, ReadonlyArray<{ variant: string }>]> = [
    ['aois', run.aois],
    ['screenshots', run.screenshots],
    ['scores', run.scores],
  ];
  for (const [list, entries] of runVariantReferences) {
    entries.forEach((entry, index) => {
      if (!declaredVariants.has(entry.variant)) {
        violations.push(at(relative.run, [list, index, 'variant'], danglingVariant(entry.variant)));
      }
    });
  }
  if (!declaredVariants.has(run.verdict.harderVariant)) {
    violations.push(
      at(relative.run, ['verdict', 'harderVariant'], danglingVariant(run.verdict.harderVariant)),
    );
  }

  for (const session of sessions) {
    const file = relative.session(session.sessionId);
    const check = (list: 'fixations' | 'actions'): void => {
      session[list].forEach((entry, index) => {
        if (entry.aoiId !== null && !declaredAois.has(entry.aoiId)) {
          violations.push(at(file, [list, index, 'aoiId'], danglingAoi(entry.aoiId)));
        }
      });
    };
    check('fixations');
    check('actions');
    if (!declaredVariants.has(session.variant)) {
      violations.push(at(file, ['variant'], danglingVariant(session.variant)));
    }
  }

  const present = new Set(sessions.map((session) => session.sessionId));
  const seen = new Set<string>();
  run.sessionIds.forEach((sessionId, index) => {
    if (seen.has(sessionId)) {
      violations.push(
        at(relative.run, ['sessionIds', index], `session "${sessionId}" is listed more than once`),
      );
    }
    seen.add(sessionId);
    if (!present.has(sessionId)) {
      violations.push(
        at(
          relative.run,
          ['sessionIds', index],
          `run.json lists session "${sessionId}", but there is no ${relative.session(sessionId)}`,
        ),
      );
    }
  });
  for (const session of sessions) {
    if (!seen.has(session.sessionId)) {
      violations.push(
        at(
          relative.session(session.sessionId),
          ['sessionId'],
          `session "${session.sessionId}" is present but is not listed in run.json sessionIds`,
        ),
      );
    }
  }

  findings?.findings.forEach((finding, index) => {
    if (finding.aoiId !== null && !declaredAois.has(finding.aoiId)) {
      violations.push(
        at(relative.findings, ['findings', index, 'aoiId'], danglingAoi(finding.aoiId)),
      );
    }
    if (!declaredVariants.has(finding.variant)) {
      violations.push(
        at(relative.findings, ['findings', index, 'variant'], danglingVariant(finding.variant)),
      );
    }
    finding.sessionIds.forEach((sessionId, position) => {
      if (!seen.has(sessionId)) {
        violations.push(
          at(
            relative.findings,
            ['findings', index, 'sessionIds', position],
            `"${sessionId}" names no session listed in run.json sessionIds`,
          ),
        );
      }
    });
  });
};

const readSessionIds = async (sessionsDir: string): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [];
  }
  return entries
    .map(sessionIdFromFileName)
    .filter((sessionId): sessionId is string => sessionId !== null)
    .sort();
};

const collect = async (
  runDir: string,
): Promise<{ artifact: RunArtifact | undefined; violations: Violation[] }> => {
  const paths = runPaths(runDir);
  const violations: Violation[] = [];

  const runJson = await readJsonFile(paths.run, relative.run, violations);
  const run =
    runJson === undefined ? undefined : parse(runSchema, runJson, relative.run, violations);

  const findingsJson = await readJsonFile(paths.findings, relative.findings, violations);
  const findings =
    findingsJson === undefined
      ? undefined
      : parse(findingsSchema, findingsJson, relative.findings, violations);

  const byId = new Map<string, Session>();
  for (const sessionId of await readSessionIds(paths.sessionsDir)) {
    const label = relative.session(sessionId);
    const json = await readJsonFile(paths.session(sessionId), label, violations);
    const session = json === undefined ? undefined : parse(sessionSchema, json, label, violations);
    if (session === undefined) continue;
    // The file is addressed by its name, so a file carrying a different id would shadow
    // the session it is named after rather than being a session of its own.
    if (session.sessionId !== sessionId) {
      violations.push(
        at(
          label,
          ['sessionId'],
          `the file is named for session "${sessionId}" but carries "${session.sessionId}"`,
        ),
      );
      continue;
    }
    byId.set(session.sessionId, session);
  }

  if (run === undefined) return { artifact: undefined, violations };
  checkReferences(run, [...byId.values()], findings, violations);
  if (findings === undefined || violations.length > 0) return { artifact: undefined, violations };

  // `run.sessionIds` is the authoritative order, and it agreed with disk above.
  const sessions = run.sessionIds.map((sessionId) => byId.get(sessionId) as Session);
  return { artifact: { run, sessions, findings }, violations };
};

const report = (runDir: string, violations: ReadonlyArray<Violation>): string =>
  [
    `${runDir} is not a valid run directory (${violations.length} violation${violations.length === 1 ? '' : 's'}):`,
    ...violations.map((violation) => `  ${violation.file}${violation.path} — ${violation.message}`),
  ].join('\n');

/**
 * Every violation in a run directory, each at the JSON path of the offending value. It
 * does not stop at the first one, and an empty array means the directory is valid.
 *
 * The one thing it cannot report is a reference into a `run.json` it could not parse: with
 * no list of areas of interest to check against, the violation it reports is that file.
 */
export const validate = async (runDir: string): Promise<Violation[]> =>
  (await collect(runDir)).violations;

/** A whole run directory, parsed. Throws with every violation if it is not valid. */
export const readRun = async (runDir: string): Promise<RunArtifact> => {
  const { artifact, violations } = await collect(runDir);
  if (artifact === undefined) throw new Error(report(runDir, violations));
  return artifact;
};

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A whole run directory, written. What it writes is what the schemas parsed, so reading it
 * back yields the same value. Throws with every violation rather than writing an artifact
 * that would not read back.
 */
export const writeRun = async (runDir: string, artifact: RunArtifact): Promise<void> => {
  const violations: Violation[] = [];
  const run = parse(runSchema, artifact.run, relative.run, violations);
  const findings = parse(findingsSchema, artifact.findings, relative.findings, violations);
  const sessions: Session[] = [];
  for (const candidate of artifact.sessions) {
    const label = relative.session(candidate.sessionId);
    const session = parse(sessionSchema, candidate, label, violations);
    if (session !== undefined) sessions.push(session);
  }
  if (run !== undefined) checkReferences(run, sessions, findings, violations);
  if (violations.length > 0) throw new Error(report(runDir, violations));

  const paths = runPaths(runDir);
  await mkdir(paths.sessionsDir, { recursive: true });
  await writeFile(paths.run, serialize(run));
  await writeFile(paths.findings, serialize(findings));
  await Promise.all(
    sessions.map((session) => writeFile(paths.session(session.sessionId), serialize(session))),
  );
  // The writer owns the sessions directory: a run written over an older one must not
  // inherit its sessions, because a session file the new run.json does not list makes the
  // directory invalid the moment it is read. Sweeping last leaves nothing half-written.
  const stale = (await readSessionIds(paths.sessionsDir)).filter(
    (sessionId) => !sessions.some((session) => session.sessionId === sessionId),
  );
  await Promise.all(stale.map((sessionId) => rm(paths.session(sessionId), { force: true })));
};
