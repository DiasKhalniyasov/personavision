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
 * The checks that span more than one value: every area-of-interest reference names an area
 * declared in the same run, and `run.sessionIds` agrees with the sessions that exist.
 */
const checkReferences = (
  run: Run,
  sessions: ReadonlyArray<Session>,
  violations: Violation[],
): void => {
  const declared = new Set(run.aois.map((aoi) => aoi.id));
  const dangling = (aoiId: string): string =>
    `"${aoiId}" names no area of interest declared in this run's aois`;

  run.aoiMetrics.forEach((metric, index) => {
    if (!declared.has(metric.aoiId)) {
      violations.push({
        file: relative.run,
        path: pointer(['aoiMetrics', index, 'aoiId']),
        message: dangling(metric.aoiId),
      });
    }
  });

  for (const session of sessions) {
    const file = relative.session(session.sessionId);
    const check = (list: 'fixations' | 'actions'): void => {
      session[list].forEach((entry, index) => {
        if (entry.aoiId !== null && !declared.has(entry.aoiId)) {
          violations.push({
            file,
            path: pointer([list, index, 'aoiId']),
            message: dangling(entry.aoiId),
          });
        }
      });
    };
    check('fixations');
    check('actions');
  }

  const present = new Set(sessions.map((session) => session.sessionId));
  run.sessionIds.forEach((sessionId, index) => {
    if (!present.has(sessionId)) {
      violations.push({
        file: relative.run,
        path: pointer(['sessionIds', index]),
        message: `run.json lists session "${sessionId}", but there is no ${relative.session(sessionId)}`,
      });
    }
  });
  const listed = new Set(run.sessionIds);
  for (const session of sessions) {
    if (!listed.has(session.sessionId)) {
      violations.push({
        file: relative.session(session.sessionId),
        path: pointer(['sessionId']),
        message: `session "${session.sessionId}" is present but is not listed in run.json sessionIds`,
      });
    }
  }
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
    if (session !== undefined) byId.set(session.sessionId, session);
  }

  if (run === undefined) return { artifact: undefined, violations };
  checkReferences(run, [...byId.values()], violations);
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
  if (run !== undefined) checkReferences(run, sessions, violations);
  if (violations.length > 0) throw new Error(report(runDir, violations));

  const paths = runPaths(runDir);
  await mkdir(paths.sessionsDir, { recursive: true });
  // A run written over an older one must not inherit its sessions: a session file the
  // new run.json does not list would make the directory invalid the moment it is read.
  const stale = (await readSessionIds(paths.sessionsDir)).filter(
    (sessionId) => !sessions.some((session) => session.sessionId === sessionId),
  );
  await Promise.all(stale.map((sessionId) => rm(paths.session(sessionId))));
  await writeFile(paths.run, serialize(run));
  await writeFile(paths.findings, serialize(findings));
  await Promise.all(
    sessions.map((session) => writeFile(paths.session(session.sessionId), serialize(session))),
  );
};
