import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { z } from 'zod';
import { runPaths, sessionIdFromFileName } from './paths.js';
import type { Findings, Run, RunProgress, RunUsage, Session, SessionProgress } from './schemas.js';
import { findingsSchema, runSchema, sessionSchema, ZERO_USAGE } from './schemas.js';

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
    // A field the contract does not declare is reported where it sits, one violation per
    // field, rather than as a single issue against the object that carries them.
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        violations.push({
          file: label,
          path: pointer([...issue.path, key]),
          message: `the contract declares no "${key}" here: an artifact file carries no field the schemas do not name, which is what keeps a run directory portable`,
        });
      }
      continue;
    }
    violations.push({ file: label, path: pointer(issue.path), message: issue.message });
  }
  return undefined;
};

/**
 * The checks that span more than one value: every reference out of one artifact file names
 * something the run declares, and `run.sessionIds` agrees with the sessions that exist.
 *
 * A session's step ids are deliberately not checked: `run.steps` enumerates the task's own
 * steps, and a session may legitimately end somewhere the run never planned to go. A step
 * caption is different — the pipeline writes it against a step it just measured, and a
 * caption no screen can find is a silently blank panel — so that one is checked.
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
  const declaredSteps = new Set(run.steps.map((step) => step.id));
  const danglingStep = (step: string): string =>
    `"${step}" names no step declared in this run's steps`;

  run.aoiMetrics.forEach((metric, index) => {
    if (!declaredAois.has(metric.aoiId)) {
      violations.push(at(relative.run, ['aoiMetrics', index, 'aoiId'], danglingAoi(metric.aoiId)));
    }
  });
  const runVariantReferences: ReadonlyArray<[string, ReadonlyArray<{ variant: string }>]> = [
    ['aois', run.aois],
    ['screenshots', run.screenshots],
    ['scores', run.scores],
    ['stepCaptions', run.stepCaptions],
  ];
  for (const [list, entries] of runVariantReferences) {
    entries.forEach((entry, index) => {
      if (!declaredVariants.has(entry.variant)) {
        violations.push(at(relative.run, [list, index, 'variant'], danglingVariant(entry.variant)));
      }
    });
  }
  // The progress block names variants in two places, and the Running screen draws a bar
  // and a log line from each: a variant the run never declared is a bar with no label.
  run.progress?.perVariant.forEach((entry, index) => {
    if (!declaredVariants.has(entry.variant)) {
      violations.push(
        at(
          relative.run,
          ['progress', 'perVariant', index, 'variant'],
          danglingVariant(entry.variant),
        ),
      );
    }
  });
  run.progress?.sessions.forEach((entry, index) => {
    if (!declaredVariants.has(entry.variant)) {
      violations.push(
        at(
          relative.run,
          ['progress', 'sessions', index, 'variant'],
          danglingVariant(entry.variant),
        ),
      );
    }
  });
  run.stepCaptions.forEach((caption, index) => {
    if (!declaredSteps.has(caption.step)) {
      violations.push(
        at(relative.run, ['stepCaptions', index, 'step'], danglingStep(caption.step)),
      );
    }
  });
  if (!declaredVariants.has(run.verdict.harderVariant)) {
    violations.push(
      at(relative.run, ['verdict', 'harderVariant'], danglingVariant(run.verdict.harderVariant)),
    );
  }
  // The verdict names what the product leads with, so everything it points at has to be
  // there: the variant to ship, and the one heatmap the Verdict screen embeds as evidence.
  if (!declaredVariants.has(run.verdict.preferredVariant)) {
    violations.push(
      at(
        relative.run,
        ['verdict', 'preferredVariant'],
        danglingVariant(run.verdict.preferredVariant),
      ),
    );
  }
  const hero = run.verdict.heroEvidence;
  const heroPath = ['verdict', 'heroEvidence'] as const;
  if (!declaredVariants.has(hero.variant)) {
    violations.push(at(relative.run, [...heroPath, 'variant'], danglingVariant(hero.variant)));
  }
  // A session's step is deliberately unchecked, because a session may end somewhere the run
  // never planned to go. The hero evidence is the run's own choice of step, so it is held to
  // the steps the run declares: it is a heatmap the screen has to be able to render.
  if (!run.steps.some((step) => step.id === hero.step)) {
    violations.push(
      at(
        relative.run,
        [...heroPath, 'step'],
        `"${hero.step}" names no step declared in this run's steps`,
      ),
    );
  }
  // The evidence is a heatmap drawn over a page, so the page has to have been captured.
  // This is the only thing holding the `aoiId: null` case — "the whole step is the
  // evidence" — to something the Verdict screen can actually render.
  if (
    !run.screenshots.some(
      (screenshot) => screenshot.variant === hero.variant && screenshot.step === hero.step,
    )
  ) {
    violations.push(
      at(
        relative.run,
        [...heroPath, 'step'],
        `no screenshot was captured of ${hero.variant} ${hero.step}, so there is no page for the verdict's heatmap to be drawn on`,
      ),
    );
  }
  if (hero.aoiId !== null) {
    const heroAoi = run.aois.find((aoi) => aoi.id === hero.aoiId);
    if (heroAoi === undefined) {
      violations.push(at(relative.run, [...heroPath, 'aoiId'], danglingAoi(hero.aoiId)));
    } else if (heroAoi.variant !== hero.variant || heroAoi.step !== hero.step) {
      violations.push(
        at(
          relative.run,
          [...heroPath, 'aoiId'],
          `area of interest "${hero.aoiId}" is on ${heroAoi.variant} ${heroAoi.step}, but the hero evidence is of ${hero.variant} ${hero.step}`,
        ),
      );
    }
  }
  // Across two files: the Verdict screen shows the findings the run names, so a name that
  // findings.json does not carry would leave the screen with a place and nothing in it.
  if (findings !== undefined) {
    const declaredFindings = new Set(findings.findings.map((finding) => finding.id));
    run.verdict.headlineFindingIds.forEach((findingId, index) => {
      if (!declaredFindings.has(findingId)) {
        violations.push(
          at(
            relative.run,
            ['verdict', 'headlineFindingIds', index],
            `"${findingId}" names no finding in ${relative.findings}`,
          ),
        );
      }
    });
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
  // A finished session in the log is a session of this run: the log line links to it.
  run.progress?.sessions.forEach((entry, index) => {
    if (!seen.has(entry.sessionId)) {
      violations.push(
        at(
          relative.run,
          ['progress', 'sessions', index, 'sessionId'],
          `progress records session "${entry.sessionId}" as finished, but run.json lists no such session`,
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
    if (finding.variant !== null && !declaredVariants.has(finding.variant)) {
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

/** A run's progress before it has recorded any: nobody finished, and nothing is claimed. */
const NO_PROGRESS: RunProgress = {
  totalSessions: 0,
  finishedSessions: 0,
  perVariant: [],
  sessions: [],
};

const addUsage = (total: RunUsage, spent: RunUsage): RunUsage => ({
  calls: total.calls + spent.calls,
  inputTokens: total.inputTokens + spent.inputTokens,
  cachedInputTokens: total.cachedInputTokens + spent.cachedInputTokens,
  outputTokens: total.outputTokens + spent.outputTokens,
  reasoningTokens: total.reasoningTokens + spent.reasoningTokens,
  estimatedCostUsd: total.estimatedCostUsd + spent.estimatedCostUsd,
});

/**
 * The progress block with one more finished session in it.
 *
 * The planner owns the totals and this owns the finished counts: a run that declared its
 * per-variant plan keeps it, and a session the plan did not allow for is a violation rather
 * than a total quietly raised. A run that declared no per-variant plan shows one bar, and
 * this does not invent two — its overall total grows with the sessions that land.
 */
const withFinishedSession = (
  progress: RunProgress,
  entry: SessionProgress,
  fail: (path: ReadonlyArray<PropertyKey>, message: string) => void,
): RunProgress => {
  const sessions = [...progress.sessions, entry];
  if (progress.perVariant.length === 0) {
    return {
      ...progress,
      totalSessions: Math.max(progress.totalSessions, sessions.length),
      finishedSessions: sessions.length,
      sessions,
    };
  }
  const planned = progress.perVariant.find((row) => row.variant === entry.variant);
  if (planned === undefined) {
    fail(
      ['progress', 'perVariant'],
      `this run plans no sessions on variant "${entry.variant}", so ${entry.sessionId} has nowhere to be counted`,
    );
  } else if (planned.finishedSessions >= planned.totalSessions) {
    fail(
      ['progress', 'perVariant'],
      `variant "${entry.variant}" planned ${planned.totalSessions} ${planned.totalSessions === 1 ? 'session' : 'sessions'} and that many have finished, so ${entry.sessionId} is one more than the run planned`,
    );
  }
  return {
    ...progress,
    finishedSessions: sessions.length,
    perVariant: progress.perVariant.map((row) =>
      row.variant === entry.variant ? { ...row, finishedSessions: row.finishedSessions + 1 } : row,
    ),
    sessions,
  };
};

/**
 * One finished session, appended to an open run: its file written, its id listed, the
 * progress block and the per-variant counts updated, and what it spent added to the run's
 * totals. The swarm calls this as each session lands, so that the Running screen reads a
 * run that is still open and the run directory validates before, during and after.
 *
 * The log entry is derived from the session and the run — the persona's name comes from
 * the run's `personas` unless it is passed, for a real session that has no persona — so
 * that nothing is stated twice and the artifact stores no display text. Returns the run as
 * it now stands, and throws with every violation rather than writing one.
 */
export const appendFinishedSession = async (
  runDir: string,
  session: Session,
  { personaName, usage }: { personaName?: string; usage?: RunUsage } = {},
): Promise<Run> => {
  const paths = runPaths(runDir);
  const violations: Violation[] = [];
  const runJson = await readJsonFile(paths.run, relative.run, violations);
  const current =
    runJson === undefined ? undefined : parse(runSchema, runJson, relative.run, violations);
  const label = relative.session(session.sessionId);
  const finished = parse(sessionSchema, session, label, violations);
  if (current === undefined || finished === undefined) throw new Error(report(runDir, violations));

  const named =
    personaName ??
    (finished.persona === null
      ? undefined
      : current.personas.find((persona) => persona.id === finished.persona?.id)?.name);
  if (named === undefined) {
    violations.push(
      at(
        label,
        ['persona'],
        `this run declares no persona "${finished.persona?.id ?? ''}", so the name for its log entry has to be passed in`,
      ),
    );
    throw new Error(report(runDir, violations));
  }

  const entry: SessionProgress = {
    sessionId: finished.sessionId,
    personaName: named,
    variant: finished.variant,
    seed: finished.seed,
    finishedAt: new Date(Date.parse(finished.startedAt) + finished.durationMs).toISOString(),
    durationMs: finished.durationMs,
    status: finished.outcome.status,
    step: finished.outcome.step,
    reason: finished.outcome.reason,
    attribution: finished.outcome.attribution,
  };
  const fail = (path: ReadonlyArray<PropertyKey>, message: string): void => {
    violations.push(at(relative.run, path, message));
  };
  const next = parse(
    runSchema,
    {
      ...current,
      sessionIds: [...current.sessionIds, finished.sessionId],
      progress: withFinishedSession(current.progress ?? NO_PROGRESS, entry, fail),
      usage: usage === undefined ? current.usage : addUsage(current.usage ?? ZERO_USAGE, usage),
    },
    relative.run,
    violations,
  );
  if (next === undefined || violations.length > 0) throw new Error(report(runDir, violations));

  // The session file first and the index second: between the two writes the directory holds
  // a session run.json does not list yet, which is the shorter-lived of the two half-states
  // and the one a reader can tell apart from a lost session.
  await mkdir(paths.sessionsDir, { recursive: true });
  await writeFile(paths.session(finished.sessionId), serialize(finished));
  await writeFile(paths.run, serialize(next));
  return next;
};

/** `2026-10-24-1402-northwind-demo` — the name of a run directory, and the run's id. */
const RUN_DIR_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The run directories under a runs root, newest first. The names sort as dates do, so the
 * order is the names reversed; a directory that is not named like a run is left out, and a
 * missing runs root is no runs rather than an error.
 *
 * It sits here rather than with the layout in `paths.ts` because it reads a directory, and
 * the layout is addressed from a browser too.
 */
export const listRunDirs = async (runsRoot: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && RUN_DIR_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
};
