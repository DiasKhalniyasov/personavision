/**
 * The acceptance check for the six fixes of step #222: **every example template produces
 * results** (#423).
 *
 * The owner's first multi-site runs on `main` (de5f409) produced results on one site of five —
 * four of the five were six automation failures out of six. Six fixes followed (#418, #419,
 * #420, #421, #441, #442), and the check that they were the right six is the owner's own
 * experiment run again: the example templates of `apps/viewer/src/screens/newtest/templates.ts`,
 * six people each, one repeat, on the model engine, against the real public sites — each of
 * them producing **at least one session whose outcome is not an automation failure**.
 *
 * **It reads the one list.** The templates are not copied here: this script takes
 * `EXAMPLE_TESTS` from the file the two screens read, so a seventh template is checked the day
 * it is added and a template that changes its criterion is checked as it now stands.
 *
 * **It is run by hand, and never by CI** (the auto-decision of 2026-11-04 on #423). It drives
 * five third-party websites and spends the owner's model key; a red CI from somebody else's
 * site redesign would be a false alarm on every pull request. `docs/template-acceptance.md`
 * is what it costs, what it needs and where its result goes.
 *
 * **It writes nothing into the repository.** The runs root defaults to
 * `~/.personavision/template-acceptance`, outside the checkout: `runs/` holds the committed
 * example run, and nothing here regenerates it. The directories are kept rather than swept,
 * because #429 bakes the front page's carousel out of them and would otherwise pay for the
 * same runs twice.
 *
 * **What it asks for is fixed.** One seed ({@link TEMPLATE_ACCEPTANCE_SEED}) and the
 * templates' own audience sentences, so two checks a month apart compare like with like. What
 * comes *back* is a live website and a model, and is not reproducible — which is the point of
 * printing the table rather than asserting on it.
 *
 * Run it:
 *
 * ```sh
 * pnpm acceptance:templates                            # into ~/.personavision/template-acceptance
 * pnpm acceptance:templates /tmp/acceptance            # into a runs root of your own
 * pnpm acceptance:templates /tmp/acceptance ikea-furniture-take-back   # one template again
 * ```
 */

import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPaths, runRequestSchema, sessionSchema } from '@personavision/contract';
import { GENERATOR_VERSION, parseAudience } from '@personavision/personas';
import {
  createMetaWonderProvider,
  MODEL_API_KEY_ENV,
  modelCredentialPresent,
  selectWonderProvider,
  WONDER_MODEL_ID,
  writeAudience,
} from '@personavision/provider';
import { criterionToObserve } from '@personavision/swarm';
// Two modules reached by path rather than by package name, because neither package is a
// dependency of the repository root — `tests/acceptance/helpers/platform.ts` and
// `tests/viewer-calls-have-routes.test.ts` reach the same two the same way.
//
// `startRun` is also deliberately absent from `@personavision/cli`'s barrel — it reaches the
// swarm and so Playwright, which has no business in a Vite dev server — and that barrel names
// this module as "where the swarm itself lives for anything that wants to drive a run from
// code".
import { variantForSite } from '../packages/platform/src/run/start.js';
import { RunNotStartedError, RunStoppedError, startRun } from '../packages/cli/src/run/start.js';
import { EXAMPLE_TESTS } from '../apps/viewer/src/screens/newtest/templates.js';
import type { Audience, RunRequest, Session } from '@personavision/contract';
import type { CriterionKind, WonderProvider } from '@personavision/provider';
import type { ExampleTest } from '../apps/viewer/src/screens/newtest/templates.js';

/** The command this script is reached by, named in its own output and in the docs. */
export const COMMAND = 'pnpm acceptance:templates';

/**
 * How many people walk each template. The owner's own figure, and #423's: six is enough for a
 * site to produce a spread of outcomes and few enough that six sites cost a few dollars.
 */
export const PEOPLE_PER_TEMPLATE = 6;

/** One walk each. A repeat is the same person again at another seed, and proves nothing here. */
export const REPEATS = 1;

/**
 * The one seed every template runs at, on every check.
 *
 * It is a constant rather than the launch day (`seedForLaunchDay`) because this script's job
 * is to be re-run after the next change and compared with the last table: the same seed draws
 * the same six people from the same audience sentence, so a row that moved moved because the
 * fix moved it or because the site did. The ticket number, so the figure says where it is from.
 */
export const TEMPLATE_ACCEPTANCE_SEED = 423;

/**
 * Where the runs go when nothing names a root: **outside the repository**, and the same place
 * every time.
 *
 * Outside, because `runs/` holds the committed example run and this script must not be able to
 * touch it. The same place every time, because #429 reads these directories to bake the front
 * page's carousel, and a temporary directory the system sweeps would make it pay for five live
 * runs a second time.
 */
export const DEFAULT_RUNS_ROOT = join(homedir(), '.personavision', 'template-acceptance');

/**
 * The sentence `decideOutcome` writes for the one session that **observed** the criterion and
 * is still not a success: it was already true when the agent arrived, so nothing was tested
 * (`packages/swarm/src/outcome.ts`).
 *
 * The sighting itself lives on the session's *trace* and is not written to disk — a session
 * file records the outcome and not what each screen showed — so the outcome's own words are
 * the only record of it. That is why this is one fragment and not a parser: everything else
 * the "observed" column counts is a success.
 */
const ALREADY_TRUE = 'was already true when the agent arrived';

/** The four outcomes, as `run.json` spells them in a score's own counts. */
export interface OutcomeCounts {
  readonly success: number;
  readonly failed: number;
  readonly abandoned: number;
  readonly automationFailure: number;
}

/**
 * A finished session, in the three fields this table reads off one.
 *
 * Narrower than `Session` on purpose: a `Session` satisfies it, and the suite can hand it two
 * fields instead of a whole schema-valid session for a row of counts.
 */
export interface ReadSession {
  readonly outcome: { readonly status: Session['outcome']['status']; readonly reason: string };
  readonly persona: { readonly device: { readonly viewport: { readonly width: number } } } | null;
}

/** One template's row: what it asked for, what came back, what it took and what it cost. */
export interface TemplateOutcome {
  /** The template's own id, from the one list. */
  readonly id: string;
  readonly siteUrl: string;
  /** The run that was written, or `null` where none ever started. */
  readonly runId: string | null;
  readonly runDir: string | null;
  /** The criterion the sessions were decided by, in the template's own words. */
  readonly criterion: string;
  /** What that criterion is: an address, an element or a piece of text. */
  readonly criterionKind: CriterionKind | null;
  readonly sessions: readonly ReadSession[];
  /** From the first ask to the last session: the audience call is inside it. */
  readonly wallClockMs: number;
  /** The run's own estimated cost plus the audience call's. */
  readonly costUsd: number;
  /** Why no run started, in the words the artifact recorded; `null` where one did. */
  readonly notStarted: string | null;
}

/** The four counts, read off the sessions on disk. */
export const countOutcomes = (sessions: readonly ReadSession[]): OutcomeCounts => ({
  success: sessions.filter((session) => session.outcome.status === 'success').length,
  failed: sessions.filter((session) => session.outcome.status === 'failed').length,
  abandoned: sessions.filter((session) => session.outcome.status === 'abandoned').length,
  automationFailure: sessions.filter((session) => session.outcome.status === 'automation_failure')
    .length,
});

/**
 * How many of these sessions **observed** the criterion.
 *
 * A success is an observed criterion and nothing else is (#400), with one exception that is
 * not a success: a criterion that was already true when the agent arrived is `failed` because
 * nothing was tested — and that agent did see the thing. A column that counted successes
 * alone would report that nobody ever reached it.
 */
export const observedCount = (sessions: readonly ReadSession[]): number =>
  sessions.filter(
    (session) =>
      session.outcome.status === 'success' || session.outcome.reason.includes(ALREADY_TRUE),
  ).length;

/** How many sessions were scored at all: the three product outcomes, never an automation failure. */
const scoredCount = (counts: OutcomeCounts): number =>
  counts.success + counts.failed + counts.abandoned;

/**
 * **The bar.** A template passes when at least one of its sessions ended in an outcome that is
 * not an automation failure: a success, a failure or an abandonment is a result a reader can
 * read, and six automation failures out of six is the thing the six fixes were for.
 */
export const producedAResult = (outcome: TemplateOutcome): boolean =>
  scoredCount(countOutcomes(outcome.sessions)) > 0;

/** Non-zero when any one template produced nothing, and when there was nothing to check. */
export const verdictExitCode = (outcomes: readonly TemplateOutcome[]): number =>
  outcomes.length > 0 && outcomes.every(producedAResult) ? 0 : 1;

/**
 * What kind of criterion a template is decided by, read the way the run loop reads it
 * (`criterionToObserve`), or `null` for a sentence no session could evaluate.
 *
 * It is a column of the table because the two kinds are answered by different halves of a
 * screen: a URL criterion by the address the screen was captured at, an element or a piece of
 * text by what the page drew (#441). A template decided by an address has to be visible as
 * such in the result.
 */
export const criterionKindOf = (criterion: string): CriterionKind | null =>
  criterionToObserve(criterion)?.kind ?? null;

/**
 * The request one template starts, built the way the platform builds a one-URL launch
 * (`draftForSite`): the goal's own task **is** the task, the site becomes the single variant,
 * and the goal is the template's own.
 *
 * The goal is **not** written by Muse Wonder here, although `writeGoal` is the seam that would
 * do it: a template carries the task and the criterion the owner wrote, and asking a model to
 * invent another would measure a goal nobody approved. `lastWrittenBy: 'user'` is what
 * `personavision run --site` records for the same reason.
 */
export const requestFor = (template: ExampleTest, audienceId: string): RunRequest =>
  // Through the schema and not as a literal: a template that stopped being startable — a
  // two-sentence task, an address the contract refuses — should stop this script at the
  // template rather than halfway into a live run.
  runRequestSchema.parse({
    task: { prompt: template.task },
    variants: [variantForSite(template.siteUrl)],
    feature: template.feature,
    goal: {
      task: template.task,
      successCriterion: template.successCriterion,
      lastWrittenBy: 'user',
    },
    audienceId,
    repeats: REPEATS,
    seed: TEMPLATE_ACCEPTANCE_SEED,
    engineMode: 'model',
    // The internal tier, which is what every command of ours runs on: naming the standard
    // model is naming a paying customer's test. `personavision run` defaults to the same.
    modelMode: 'contributor',
  });

/* ===== the table ============================================================ */

/** `1m 32s`, or `8.0s` under a minute: a wall clock a reader compares across runs. */
const duration = (ms: number): string => {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(Math.round(seconds % 60))}s`;
};

/** US dollars to four places: a six-session run on the cheap tier is cents. */
const money = (usd: number): string => `$${usd.toFixed(4)}`;

/** The viewports the scored sessions were read on, ascending and without repeats. */
const viewportsOf = (outcome: TemplateOutcome): readonly number[] =>
  [
    ...new Set(
      outcome.sessions
        .filter((session) => session.outcome.status !== 'automation_failure')
        .map((session) => session.persona?.device.viewport.width)
        .filter((width): width is number => width !== undefined),
    ),
  ].sort((a, b) => a - b);

/** The first automation failure's reason, which is the one worth printing. */
const firstAutomationFailure = (outcome: TemplateOutcome): string | null =>
  outcome.sessions.find((session) => session.outcome.status === 'automation_failure')?.outcome
    .reason ?? null;

const row = (outcome: TemplateOutcome): string => {
  const counts = countOutcomes(outcome.sessions);
  return `| ${outcome.siteUrl} | ${outcome.criterionKind ?? 'unreadable'} | ${String(outcome.sessions.length)} | ${String(counts.success)} | ${String(counts.failed)} | ${String(counts.abandoned)} | ${String(counts.automationFailure)} | ${String(observedCount(outcome.sessions))} | ${duration(outcome.wallClockMs)} | ${money(outcome.costUsd)} |`;
};

/**
 * What #429 reads first: per template, whether it produced **both** a session that reached the
 * thing and a session that did not, and on which viewports.
 *
 * A slide set needs the contrast — one person who got there and one who did not — so a
 * single-outcome template is named as such rather than left for #429 to discover. A template
 * that produced no outcome at all gets no slide set, which is #423's finding and not something
 * to paper over with an invented slide.
 */
const contrast = (outcome: TemplateOutcome): string => {
  const counts = countOutcomes(outcome.sessions);
  const scored = scoredCount(counts);
  if (scored === 0) return `- ${outcome.siteUrl} — no outcome to build a slide set from`;
  const reached = observedCount(outcome.sessions);
  const missed = scored - reached;
  const widths = viewportsOf(outcome)
    .map((width) => String(width))
    .join(', ');
  const shape =
    reached > 0 && missed > 0
      ? 'both outcomes'
      : `single-outcome (${reached > 0 ? 'every scored session reached it' : 'no scored session reached it'})`;
  return `- ${outcome.siteUrl} — ${shape} (${String(reached)} reached, ${String(missed)} did not), viewports ${widths}`;
};

export interface RenderReportInput {
  readonly runsRoot: string;
  readonly outcomes: readonly TemplateOutcome[];
}

/**
 * The whole result, as Markdown — because where it belongs is a comment on #423, and a table
 * a reader has to re-type is a table nobody posts.
 */
export const renderReport = ({ runsRoot, outcomes }: RenderReportInput): string => {
  const nothing = outcomes.filter((outcome) => !producedAResult(outcome));
  const failures = outcomes
    .map((outcome) => ({ outcome, reason: firstAutomationFailure(outcome) }))
    .filter(
      (entry): entry is { outcome: TemplateOutcome; reason: string } => entry.reason !== null,
    );
  const notStarted = outcomes.filter((outcome) => outcome.notStarted !== null);
  // **Two different failures, never one sentence.** A template that ran and produced only
  // automation failures is a finding about the site, which is what #423's bar is about. A
  // template whose run never started — no credential, no network, an address the contract
  // refused — is a finding about this check's own circumstances, and blaming the site for it
  // would send whoever reads the table to the wrong place.
  const droveNothing = nothing.filter((outcome) => outcome.notStarted === null);
  const neverRan = nothing.filter((outcome) => outcome.notStarted !== null);
  const sites = (some: readonly TemplateOutcome[]): string =>
    some.map((outcome) => outcome.siteUrl).join(', ');
  const of = (some: readonly TemplateOutcome[]): string =>
    `${String(some.length)} of ${String(outcomes.length)}`;

  return [
    `| Site | Criterion | Sessions | success | failed | abandoned | automation_failure | observed | Wall clock | Cost |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...outcomes.map(row),
    `| **total** | | ${String(outcomes.reduce((all, outcome) => all + outcome.sessions.length, 0))} | | | | | | ${duration(outcomes.reduce((all, outcome) => all + outcome.wallClockMs, 0))} | ${money(outcomes.reduce((all, outcome) => all + outcome.costUsd, 0))} |`,
    '',
    ...(nothing.length === 0
      ? [`**Every template produced results: ${of(outcomes)}.**`]
      : [
          ...(droveNothing.length === 0
            ? []
            : [
                `**${of(droveNothing)} templates ran and produced no outcome that is not an automation failure: ${sites(droveNothing)}.** That is a finding and a sibling ticket on #222, never a relaxed bar here.`,
              ]),
          ...(neverRan.length === 0
            ? []
            : [
                `**${of(neverRan)} templates never started a run: ${sites(neverRan)}.** The reasons are under the table. A credential or a network this check could not use is a finding about the check and not about the site.`,
              ]),
        ]),
    '',
    ...(failures.length === 0
      ? []
      : [
          '**The first automation failure of each template that had one**',
          ...failures.map((entry) => `- ${entry.outcome.siteUrl} — ${entry.reason}`),
          '',
        ]),
    ...(notStarted.length === 0
      ? []
      : [
          '**Runs that never started**',
          ...notStarted.map((outcome) => `- ${outcome.siteUrl} — ${String(outcome.notStarted)}`),
          '',
        ]),
    '**A contrast per template, for #429**',
    ...outcomes.map(contrast),
    '',
    `**The runs are kept, outside the repository:** \`${runsRoot}\``,
    ...outcomes.map(
      (outcome) => `- ${outcome.id} — ${outcome.runId ?? 'no run directory was written'}`,
    ),
  ].join('\n');
};

/* ===== driving it =========================================================== */

/** Every line the check reports, as it happens: six live runs is minutes, not seconds. */
type Report = (line: string) => void;

/**
 * The structured audience, written from the template's own sentence — the very call
 * `POST /audiences/from-sentence` makes, through the same ask, with the same stamped id and
 * generator version.
 *
 * The **size is this script's**, not the sentence's: a sentence may imply a city and the model
 * is free to say so, and this check runs {@link PEOPLE_PER_TEMPLATE} people whatever it says.
 * The audience is put back through `parseAudience` afterwards, because a size is not a free
 * field — the device quota has to account for every one of the six people — and an audience
 * nobody can be generated from should stop this script at the template rather than inside the
 * swarm.
 *
 * Everything else — the roles, the regions, the age groups, the device mix — is the model's
 * reading of the owner's sentence, which is what the audience step would have put in front of
 * the user.
 *
 * The provider is a **parameter**, the way `writeAudience` takes one: the live check hands it
 * Muse Wonder, and the suite hands it the offline implementation, so the shaping above is held
 * still for all six sentences with no key and no network.
 */
export const audienceFrom = async (
  provider: WonderProvider,
  template: ExampleTest,
): Promise<{ audience: Audience; costUsd: number }> => {
  const reply = await writeAudience(provider, {
    sentence: template.audienceSentence,
    id: template.id,
    seed: TEMPLATE_ACCEPTANCE_SEED,
    generatorVersion: GENERATOR_VERSION,
  });
  return {
    audience: parseAudience({ ...reply.value, size: PEOPLE_PER_TEMPLATE }),
    costUsd: reply.usage.estimatedCostUsd,
  };
};

/**
 * Muse Wonder on the one model this project runs one-shot, built from the key in the
 * environment and **refused** where there is none — `wonderFromEnv`'s own selection, which is
 * what the platform's audience route is built on.
 *
 * There is no offline fall-back here and there must not be: a deterministic stand-in would
 * answer the owner's sentence with an audience this repository invented, and a check that
 * reported results for six people nobody asked for is worse than a check that refused to run.
 */
const wonderFromEnv = (env: Readonly<Record<string, string | undefined>>): WonderProvider =>
  selectWonderProvider({
    env,
    requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
    createModelProvider: ({ apiKey, modelId }) => createMetaWonderProvider({ apiKey, modelId }),
  }).provider;

/** The sessions a finished run wrote, read back off disk as a screen would read them. */
const sessionsOf = async (runDir: string, sessionIds: readonly string[]): Promise<Session[]> => {
  const paths = runPaths(runDir);
  return Promise.all(
    sessionIds.map(async (sessionId) =>
      sessionSchema.parse(JSON.parse(await readFile(paths.session(sessionId), 'utf8'))),
    ),
  );
};

/** One template, end to end: the audience, the run, and the row the table prints. */
const check = async (
  template: ExampleTest,
  runsRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  report: Report,
): Promise<TemplateOutcome> => {
  const startedAt = Date.now();
  const criterion = template.successCriterion;
  const shared = {
    id: template.id,
    siteUrl: template.siteUrl,
    criterion,
    criterionKind: criterionKindOf(criterion),
  };

  report(`\n── ${template.id} — ${template.siteUrl}`);
  report(`   feature: ${template.feature}`);
  report(`   task: ${template.task}`);
  report(`   criterion (${shared.criterionKind ?? 'unreadable'}): ${criterion}`);

  // Outside the try so the cost of an audience call is still in the table when the run after
  // it never happened: a call that was billed and then thrown away is still a call.
  let costUsd = 0;

  try {
    const written = await audienceFrom(wonderFromEnv(env), template);
    const { audience } = written;
    costUsd = written.costUsd;
    report(
      `   audience: ${audience.name} — ${String(audience.size)} people, ${audience.devices.map((device) => device.name).join('/')}`,
    );

    const started = await startRun({
      runsRoot,
      request: requestFor(template, audience.id),
      audience,
      // The artifact says which site it ran against, as a launch through the platform does.
      site: { url: template.siteUrl },
      env,
      report: (line) => {
        report(`   ${line}`);
      },
    });
    const sessions = await sessionsOf(started.runDir, started.run.sessionIds);
    return {
      ...shared,
      runId: started.runId,
      runDir: started.runDir,
      sessions,
      wallClockMs: Date.now() - startedAt,
      costUsd: costUsd + (started.run.usage?.estimatedCostUsd ?? 0),
      notStarted: null,
    };
  } catch (error) {
    // **One template's failure is one row**, never the end of the check. The other five still
    // have to be measured and the table still has to print: a site that cannot be opened at
    // all is exactly the finding this script exists to report, and a check that threw on the
    // third template would report nothing about the first two either.
    //
    // That covers the audience call as well as the run. A Wonder call that came back 503 for
    // one sentence is one row; a credential the API refuses is six rows all saying so, which
    // is accurate and is what a reader needs — not an exception where the table should be.
    if (error instanceof RunNotStartedError || error instanceof RunStoppedError) {
      const reason = error.run.failure?.reason ?? error.message;
      report(`   no run: ${reason}`);
      return {
        ...shared,
        runId: error.runId,
        runDir: error.runDir,
        sessions:
          error instanceof RunStoppedError
            ? await sessionsOf(error.runDir, error.run.sessionIds)
            : [],
        wallClockMs: Date.now() - startedAt,
        costUsd: costUsd + (error.run.usage?.estimatedCostUsd ?? 0),
        notStarted: reason,
      };
    }
    // Named rather than summarised: `WonderCallError: the API answered 401 to the audience
    // ask` says both what failed and what to do about it, and a reader of the table should
    // not have to guess whether it was the site, the model or this script.
    const named = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    report(`   no run: ${named}`);
    return {
      ...shared,
      runId: null,
      runDir: null,
      sessions: [],
      wallClockMs: Date.now() - startedAt,
      costUsd,
      notStarted: named,
    };
  }
};

export interface TemplateAcceptanceOptions {
  readonly runsRoot: string;
  readonly templates?: readonly ExampleTest[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly report?: Report;
}

/**
 * The whole check: every template in turn, then the table.
 *
 * **One at a time.** Six people on one site is already the per-site concurrency the swarm
 * runs under, and two sites at once would make every wall clock in the table a measurement of
 * this machine rather than of the site.
 */
export const templateAcceptance = async ({
  runsRoot,
  templates = EXAMPLE_TESTS,
  env = process.env,
  report = (line) => process.stdout.write(`${line}\n`),
}: TemplateAcceptanceOptions): Promise<{ report: string; exitCode: number }> => {
  // Asked rather than read: `modelCredentialPresent` is `packages/provider/src/select.ts`'s
  // own, so the one file the project sanctions to read the credential stays the one file that
  // names it, and this script never holds the value in order to ask the question
  // (`tests/workspace.test.ts`).
  if (!modelCredentialPresent(env)) {
    // Refused rather than run: with no key a model run is recorded and run as **offline**,
    // and an offline walk of a live site proves nothing about the six fixes.
    throw new Error(
      `${COMMAND} needs ${MODEL_API_KEY_ENV} in the environment: it is the check that the fixes work on the model engine, and a model run with no key is recorded and run as offline instead. See docs/template-acceptance.md.`,
    );
  }
  await mkdir(runsRoot, { recursive: true });
  report(
    `${COMMAND}: ${String(templates.length)} templates × ${String(PEOPLE_PER_TEMPLATE)} people × ${String(REPEATS)} repeat, on the model engine, into ${runsRoot}`,
  );

  const outcomes: TemplateOutcome[] = [];
  for (const template of templates) {
    outcomes.push(await check(template, runsRoot, env, report));
  }

  return {
    report: renderReport({ runsRoot, outcomes }),
    exitCode: verdictExitCode(outcomes),
  };
};

/**
 * The templates named on the command line, or all of them.
 *
 * Naming one is how a site that came back mostly automation failures is looked at again
 * without paying for the other five, and it is what a reader does after somebody else's site
 * redesign. A name no template carries is refused with the names there are, rather than
 * checking nothing and exiting 1 as though a site had failed.
 */
export const templatesNamed = (ids: readonly string[]): readonly ExampleTest[] => {
  if (ids.length === 0) return EXAMPLE_TESTS;
  return ids.map((id) => {
    const template = EXAMPLE_TESTS.find((candidate) => candidate.id === id);
    if (template === undefined) {
      throw new Error(
        `${COMMAND}: there is no template "${id}". The templates are: ${EXAMPLE_TESTS.map((candidate) => candidate.id).join(', ')}.`,
      );
    }
    return template;
  });
};

const main = async (): Promise<void> => {
  const [root, ...ids] = process.argv.slice(2);
  const runsRoot = resolve(root ?? DEFAULT_RUNS_ROOT);
  const result = await templateAcceptance({ runsRoot, templates: templatesNamed(ids) });
  process.stdout.write(`\n${result.report}\n`);
  // The table is the deliverable and it has just been printed, so a template that produced
  // nothing is a non-zero exit and not a thrown error: the reader needs the whole table.
  process.exitCode = result.exitCode;
};

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) await main();
