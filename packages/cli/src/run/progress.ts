import type { Run, SessionProgress } from '@personavision/contract';

/**
 * How far a run has got, in words — the Running screen's log, printed to a terminal.
 *
 * `personavision run` and `/runs/:runId` are two faces of one run, and the one thing they
 * must not do is word the same event differently (#54's screen contract). So every sentence
 * here is a **format of something the run artifact already records**: the counts are
 * `run.progress`'s own, the stamps are the offset between two stored timestamps, the
 * duration is the stored `durationMs`, the engine phrase reads `engine.mode` and
 * `engine.modelMode`, and the cost comes out of `run.usage`. Nothing is composed from a
 * second tally this command keeps of its own, and the artifact stores no display text.
 *
 * The vocabulary is `docs/FLOW.md` section 8's: *abandoned*, *failed* and *automation
 * failure* are three different things and are never merged, and the model's name is the
 * product's copy rather than a model id parsed for a name.
 *
 * **Why this is not imported from the screen.** `apps/viewer/src/screens/runstatus/`
 * (#18) renders the same two screens from the same fields, and an app is not something a
 * package may import — so the sentences are built here from the same artifact fields, with
 * the same words, and `test/run-progress.test.ts` holds them to the prototype's own log
 * lines. A shared home for this wording would be a new package and belongs to whichever
 * ticket next needs a third face.
 */

const MINUTE = 60_000;

/**
 * The four outcomes, as `docs/FLOW.md` section 8 words them. Lower case, because a log line
 * reads them mid-sentence; the screens capitalise their own tags from the same four words.
 */
const OUTCOME_WORD: Readonly<Record<SessionProgress['status'], string>> = {
  success: 'success',
  abandoned: 'abandoned',
  failed: 'failed',
  automation_failure: 'automation failure',
};

/** Who a non-success outcome is attributed to: the product under test, or our own browsing. */
const ATTRIBUTION_WORD: Readonly<Record<SessionProgress['attribution'], string>> = {
  product: 'product',
  automation: 'automation',
};

/**
 * The product's own name for the model a test runs on. It is copy, not data: the artifact
 * records the *mode*, and the model ids behind it live in `packages/provider`, where the
 * prices are. A line that read a name out of an id would start guessing the day a new id
 * arrives.
 */
const MODEL_NAME = 'Muse Spark 1.3';

const MODE_WORD: Readonly<Record<NonNullable<Run['engine']['modelMode']>, string>> = {
  contributor: 'contributor mode',
  standard: 'standard mode',
};

/** What a test that called no model reads, unchanged from the prototype. */
export const OFFLINE_ENGINE = 'offline deterministic engine';

/**
 * `17 of 24 sessions finished` — the claim every other line of the report is a detail of.
 *
 * It counts **sessions** rather than people: four people on three seeds against two
 * variants are twenty-four sessions and four people, and this command's reader is the one
 * watching the twenty-four land.
 */
export const finishedPhrase = (finished: number, total: number): string =>
  `${finished} of ${total} session${total === 1 ? '' : 's'} finished`;

/**
 * `Muse Spark 1.3 · contributor mode`, `· standard mode`, or the offline engine.
 *
 * A run that called a model always records which mode — the contract refuses one that does
 * not — so a missing mode means an artifact written before that field existed, and such a
 * run is named without a mode rather than with a guessed one.
 */
export const enginePhrase = (engine: Run['engine']): string => {
  if (engine.mode === 'offline') return OFFLINE_ENGINE;
  const mode = engine.modelMode === undefined ? null : MODE_WORD[engine.modelMode];
  return mode === null ? MODEL_NAME : `${MODEL_NAME} · ${mode}`;
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const whole = new Intl.NumberFormat('en-US');

/**
 * `312 calls · $0.42 so far`, at the prices of the model that was actually called, and
 * `null` when there is no model bill to report: an offline run reads the engine phrase and
 * nothing else, as the prototype has it.
 */
export const usagePhrase = (run: Run): string | null => {
  const { usage } = run;
  if (usage === undefined || run.engine.mode !== 'model') return null;

  const spent = usage.estimatedCostUsd;
  const calls = `${whole.format(usage.calls)} ${usage.calls === 1 ? 'call' : 'calls'}`;
  const cost =
    spent > 0 && spent < 0.01
      ? `under ${money.format(0.01)} so far`
      : `${money.format(spent)} so far`;
  return `${calls} · ${cost}`;
};

/** When the swarm started, in milliseconds, or `null` when the run does not record it. */
const startedAt = (run: Run): number | null => {
  if (run.startedAt === undefined) return null;
  const at = Date.parse(run.startedAt);
  return Number.isFinite(at) ? at : null;
};

/**
 * `00:03:11`: how far into the run this session landed, which is what the prototype's log
 * stamps each line with. `null` when the run records no start, because then the offset is
 * from nothing.
 */
export const logStamp = (run: Run, entry: SessionProgress): string | null => {
  const since = startedAt(run);
  if (since === null) return null;
  const landed = Date.parse(entry.finishedAt);
  if (!Number.isFinite(landed)) return null;

  const seconds = Math.floor(Math.max(landed - since, 0) / 1000);
  const parts = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return parts.map((part) => String(part).padStart(2, '0')).join(':');
};

/**
 * What was captured, on one line.
 *
 * The screen renders the same string into a block that wraps it; a terminal has no block, so
 * a captured detail carrying a stack trace would turn one session's line into twenty and the
 * report would stop being one line per finished session. The words are untouched — only the
 * runs of whitespace between them close up.
 */
const oneLine = (reason: string): string => reason.replace(/\s+/g, ' ').trim();

/** The step as this run labels it, which is what a reader of the log recognises. */
const stepLabel = (run: Run, step: string): string =>
  run.steps.find((candidate) => candidate.id === step)?.label ?? step;

/**
 * What happened to one person, as the prototype's log words it — `success in 58.4 s`,
 * `abandoned at the Review step (product: service fee revealed late)`.
 *
 * The artifact carries structured fields and no pre-composed sentence, so the sentence is
 * rendered here: the outcome's own word, the step the session ended on as the run labels
 * it, and — on anything but a success — who it is attributed to, beside what was captured.
 * A success is timed instead, because what is worth knowing about a success is how long it
 * took.
 */
export const outcomeSentence = (run: Run, entry: SessionProgress): string => {
  const word = OUTCOME_WORD[entry.status];
  const captured = oneLine(entry.reason);

  if (entry.status === 'success') {
    const seconds = (entry.durationMs / 1000).toFixed(1);
    return captured === '' ? `success in ${seconds} s` : `success in ${seconds} s (${captured})`;
  }

  const where = `${word} at the ${stepLabel(run, entry.step)} step`;
  const who = ATTRIBUTION_WORD[entry.attribution];
  return captured === '' ? `${where} (${who})` : `${where} (${who}: ${captured})`;
};

/**
 * One log line, as the prototype writes it: `S-24 Price-sensitive scanner · B · seed 3 —
 * abandoned at the Review step (product: service fee revealed late)`.
 *
 * A real session carries a participant and no seed, and such a line names no seed rather
 * than naming nothing.
 */
export const logLine = (run: Run, entry: SessionProgress): string => {
  const who = [
    `${entry.sessionId} ${entry.personaName}`,
    entry.variant,
    ...(entry.seed === null ? [] : [`seed ${String(entry.seed)}`]),
  ];
  return `${who.join(' · ')} — ${outcomeSentence(run, entry)}`;
};

/** One log line with the stamp the prototype sets apart down the left of its log. */
export const stampedLogLine = (run: Run, entry: SessionProgress): string => {
  const stamp = logStamp(run, entry);
  return stamp === null ? logLine(run, entry) : `${stamp}  ${logLine(run, entry)}`;
};

/**
 * One line of the running report: the stamped log line, and on a model run what it has
 * spent so far.
 *
 * The spend travels on the session's own line rather than on a line of its own, so the
 * report stays one line per finished session however long a run is — and an offline run
 * reads the log line and nothing else, as the prototype has it, because there is no bill.
 */
export const reportLine = (run: Run, entry: SessionProgress): string => {
  const spent = usagePhrase(run);
  const line = stampedLogLine(run, entry);
  return spent === null ? line : `${line} · ${spent}`;
};

/**
 * `3 min elapsed`, or `null` for a run that records no start — which is a run whose elapsed
 * time is unknown, not one that started a moment ago.
 */
export const elapsedPhrase = (run: Run, now: number): string | null => {
  const since = startedAt(run);
  if (since === null) return null;
  const elapsed = Math.max(now - since, 0);
  return elapsed < MINUTE
    ? 'under a minute elapsed'
    : `${Math.floor(elapsed / MINUTE)} min elapsed`;
};

/**
 * What the command says before anybody has finished: the counts at nought, the task, the
 * versions under test and the engine that is about to run them.
 *
 * The Running screen's empty state says the same — `0 of N`, the task in the heading, the
 * variants in the segment bars and the engine in the lede — because printing nothing until
 * the first session lands would leave a reader unable to tell a slow run from a stuck one.
 */
export const openingLines = (run: Run): string[] => {
  const planned = run.progress?.totalSessions ?? 0;
  const engine = [enginePhrase(run.engine), usagePhrase(run)].filter(
    (part): part is string => part !== null,
  );
  return [
    `Running · ${run.task.prompt}`,
    `${finishedPhrase(run.progress?.finishedSessions ?? 0, planned)} · ${engine.join(' · ')}`,
    ...run.variants.map((variant) => {
      const sessions = perVariantTotal(run, variant.id);
      return `  ${variant.id} ${variant.name} · ${String(sessions)} ${sessions === 1 ? 'session' : 'sessions'} · ${variant.url}`;
    }),
    `  ${run.audience.name} · ${String(run.personas.length)} ${run.personas.length === 1 ? 'person' : 'people'} · seeds ${run.seedGroups.join(', ')}`,
  ];
};

const perVariantTotal = (run: Run, variant: string): number =>
  run.progress?.perVariant.find((row) => row.variant === variant)?.totalSessions ?? 0;

/**
 * The last word on a run: the counts, the split per variant, and what the model cost.
 *
 * It is read out of the artifact as it now stands, so a run that was interrupted reports the
 * sessions it kept rather than the sessions it planned.
 */
export const closingLines = (run: Run, now: number): string[] => {
  const { progress } = run;
  const engine = [enginePhrase(run.engine), usagePhrase(run)].filter(
    (part): part is string => part !== null,
  );
  const elapsed = elapsedPhrase(run, now);
  return [
    [
      finishedPhrase(progress?.finishedSessions ?? 0, progress?.totalSessions ?? 0),
      ...(elapsed === null ? [] : [elapsed]),
      ...engine,
    ].join(' · '),
    ...(progress?.perVariant ?? []).map(
      (row) =>
        `  ${row.variant} ${String(row.finishedSessions)} / ${String(row.totalSessions)} ${row.totalSessions === 1 ? 'session' : 'sessions'}`,
    ),
  ];
};

/**
 * What a run that failed to start says about the engine: which engine it was to run on, and
 * that nothing stood in for it.
 *
 * Both sentences are in the **past conditional**, because nothing ran: the screen's own
 * notice for an offline test — "no model key is configured, so the offline deterministic
 * engine was used" — is true of a test that *finished* offline and would be two falsehoods
 * here, claiming an engine was used when none was and a key is absent without having looked.
 *
 * A test that asked for a model and failed never reports another engine's result in its
 * place (#144), so that sentence names the model and states the absence rather than
 * mentioning any other engine at all.
 */
export const engineFailureNotice = (engine: Run['engine']): string =>
  engine.mode === 'offline'
    ? `This test was to run on the ${OFFLINE_ENGINE}. Nothing was simulated, so there is nothing to read: no session ran and no engine stood in for it.`
    : `This test was to run on ${enginePhrase(engine)}. That model could not be used, so nobody was simulated and no other engine’s result was saved in its place.`;

/**
 * What to check, in the prototype's own words — the three things a reader of a failed test
 * can do something about. They are the screen's copy rather than the artifact's: the
 * captured detail above them is what the attempt reported.
 */
export const FAILURE_CHECKS: readonly string[] = [
  'Is the page for the second version actually reachable at that address?',
  'If it needs a login, add a sign-in step to the test.',
  'Both versions have to be reachable: a comparison is only valid from one test.',
];
