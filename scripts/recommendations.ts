/**
 * The recommendations stage of a run: sample, build, write up, **validate**, and only then
 * hand the document to the contract's own writer (`docs/FLOW.md` sections 14 and 16).
 *
 * It is the last mile of the step. The builder (#258) calls Muse Wonder and ranks what comes
 * back, the generator (#260) turns those recommendations into the write-up the Analysis
 * screen renders, and the citation validator (#254) resolves every citation against the run
 * it is about. This module is the one place that runs the three in order, so a run that
 * finishes carries `recommendations.json` and a run whose citations do not resolve carries
 * nothing at all.
 *
 * It lives beside the two generators rather than inside a package because it is **pipeline
 * order and not a rule**: every rule it applies belongs to `@personavision/scoring` or
 * `@personavision/contract`, and what is written down here is which of them runs first.
 * Both generators call it — `generate-demo-run.ts` over the demo shop and
 * `seed-example-run.ts` over the hand-authored fixture — so the committed artifact and the
 * fixture the viewer's suites read cannot drift apart on the order they were produced in.
 *
 * **Nothing half valid lands in a run directory.** The document is validated here, before
 * `writeRun` is called, and a violation throws with the JSON path of the value that is
 * wrong. `writeRun` checks the same citations again on its way past — it is the contract's
 * own refusal and this module does not replace it — but a pipeline that discovered a dead
 * citation only inside the writer would have reported it as a broken run directory rather
 * than as the stage that produced it.
 *
 * **A run with nothing to recommend still gets the file**, carrying the one stored sentence
 * saying why: the Summary states it in words rather than showing an empty section, and an
 * absent file is indistinguishable from a pipeline that never ran the stage.
 *
 * Offline and deterministic: the Wonder implementation is the project's offline default, so
 * the same sessions give the same file, byte for byte, with no key and no network.
 *
 * **It is also a command**, `pnpm recommend:run <run directory>`, which runs the stage over a
 * directory that already exists and writes the run back out. A run produced before this stage
 * did has everything the stage needs on disk — its sessions, its findings and its aggregate —
 * so its recommendations are regenerated from it rather than back-filled by hand, and the
 * committed example run's own `recommendations.json` is what that command wrote.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readRun,
  recommendationsSchema,
  SCHEMA_VERSION,
  validateRecommendations,
  writeRun,
} from '@personavision/contract';
import { createOfflineWonderProvider, writeAnalysis } from '@personavision/provider';
import { buildRecommendations, sampleSessions, writeUp } from '@personavision/scoring';
import type {
  Aggregate,
  Findings,
  Recommendations,
  Run,
  Session,
  Violation,
} from '@personavision/contract';
import type { WonderProvider } from '@personavision/provider';

/** What the stage is given: the run as the scoring step left it, and its figures. */
export interface RecommendationsStageInput {
  /** The finished run: every name a citation may use is declared in here. */
  readonly run: Run;
  /**
   * Every session the run produced, automation failures among them. The sampler clears them
   * out of what Wonder reads; the builder needs the whole run to notice one being cited.
   */
  readonly sessions: readonly Session[];
  /** `findings.json` as this run states it — what a recommendation rests on, and the document the validator holds its `findingIds` to. */
  readonly findings: Findings;
  /** `aggregate.json`: where the ranking keys and every figure of the write-up are read from. */
  readonly aggregate: Aggregate;
  /**
   * The Wonder implementation, the offline deterministic one by default — which is what both
   * committed runs are produced with, so a fresh clone with no key reproduces them.
   */
  readonly wonder?: WonderProvider;
  /** Every line the stage reports: what it dropped, and why, one line each. */
  readonly report?: (line: string) => void;
}

/**
 * Why a run that read nothing recommends nothing, in the one sentence
 * `recommendationsSchema` stores.
 *
 * It is the one case the ask itself refuses — an analysis is written from the sessions a run
 * produced, and a run whose every session our own automation broke has none to read — so the
 * sentence is written here rather than being Wonder's. The file is still written: *"no
 * recommendations, and here is why"* is a fact about the run, and an absent file says only
 * that nobody looked.
 */
export const NOTHING_READ =
  'Muse Wonder read no session of this run, because our own automation broke every one of them, so there is nothing it could recommend about the site.';

/**
 * The seed the sample is drawn with and the ask is answered from: the run's own first seed
 * group, which is a number the artifact records rather than one this stage invents. A run
 * declaring none is seeded 0, which is still the same answer every time.
 */
const seedOf = (run: Run): number => run.seedGroups[0] ?? 0;

/** The violations of a document, as a refusal naming each one's file and JSON path. */
const refusal = (runId: string, violations: ReadonlyArray<Violation>): Error =>
  new Error(
    [
      `the recommendations of ${runId} do not resolve against the run (${String(violations.length)} violation${violations.length === 1 ? '' : 's'}), so no file is written:`,
      ...violations.map(
        (violation) => `  ${violation.file}${violation.path} — ${violation.message}`,
      ),
    ].join('\n'),
  );

/**
 * One run's `recommendations.json`, validated against that run and ready for `writeRun`.
 *
 * The four steps, in the order they have to happen: the **sample** of whole sessions Wonder
 * reads beside the aggregate of every one; the **builder**, which calls Wonder and ranks
 * what it may publish; the **write-up**, generated from those recommendations and never
 * from prose; and the **validation**, which resolves every citation in the finished document
 * against the run and throws rather than hand the writer something with a dead link in it.
 */
export const recommendationsOf = async (
  input: RecommendationsStageInput,
): Promise<Recommendations> => {
  const { run, sessions, findings, aggregate } = input;
  const report = input.report ?? ((): void => undefined);
  const seed = seedOf(run);
  const sample = sampleSessions(sessions, run.personas, seed);

  const document = await (async (): Promise<Recommendations> => {
    // An analysis is written from sessions, and `analysisAsk` refuses an ask carrying none
    // rather than answering about a run nobody walked. So the stage answers for it, in the
    // same shape: no recommendation, and the stored reason there is none.
    if (sample.sessions.length === 0) {
      report(`recommendations: no session of ${run.runId} is readable as product evidence.`);
      return recommendationsSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        runId: run.runId,
        sample: sample.sample,
        recommendations: [],
        nothingToRecommend: NOTHING_READ,
      });
    }

    const provider = input.wonder ?? createOfflineWonderProvider();
    const built = await buildRecommendations({
      run,
      sessions,
      findings: findings.findings,
      seed,
      aggregate,
      sample,
      wonder: (request) => writeAnalysis(provider, request).then((reply) => reply.value),
      report,
    });

    // The write-up is generated from the recommendations the builder published, so it is
    // written after them and from nothing else. An open run and a run whose every claim lost
    // its citations generate none, and a document carrying an empty write-up is a document
    // the schema refuses: the block is left out instead.
    const claims = writeUp({
      run,
      aggregate,
      recommendations: built.recommendations,
      findings: findings.findings,
      sample: built.sample,
      report,
    });

    return recommendationsSchema.parse({ ...built, ...(claims.length > 0 && { writeUp: claims }) });
  })();

  const violations = validateRecommendations({
    run,
    sessions,
    findings,
    aggregate,
    recommendations: document,
  });
  if (violations.length > 0) throw refusal(run.runId, violations);

  report(
    `recommendations: ${String(document.recommendations.length)} published, ${String(document.writeUp?.length ?? 0)} write-up claim${document.writeUp?.length === 1 ? '' : 's'}, read ${String(document.sample.read)} of ${String(document.sample.of)} sessions.`,
  );
  return document;
};

/* ===== as a command ======================================================== */

/** The command this stage is reached by on its own, recorded here as the way back to it. */
export const RECOMMEND_COMMAND = 'pnpm recommend:run';

/**
 * The stage over a run directory that already exists: read it, recommend, write it back.
 *
 * It is how a run produced before this stage existed gets its `recommendations.json` —
 * everything the stage reads is in the directory, so the file is generated from that run and
 * not written by hand. Nothing else in the directory changes: `writeRun` is handed the
 * artifact it just read, with the recommendations added, and the contract's serializer writes
 * the same bytes for the same documents.
 *
 * A run whose aggregate is missing is refused rather than recommended over: the ranking keys
 * and every figure of the write-up are read off `aggregate.json`, and a run without one has
 * nothing to rank by. `personavision aggregate <run directory>` composes it first.
 */
export const recommendOverRun = async (
  runDir: string,
  report?: (line: string) => void,
): Promise<Recommendations> => {
  const artifact = await readRun(runDir);
  if (artifact.aggregate === undefined) {
    throw new Error(
      `${runDir} carries no aggregate.json, and the ranking keys of a recommendation are read off it: run \`personavision aggregate ${runDir}\` first`,
    );
  }
  const recommendations = await recommendationsOf({
    run: artifact.run,
    sessions: artifact.sessions,
    findings: artifact.findings,
    aggregate: artifact.aggregate,
    report,
  });
  await writeRun(runDir, { ...artifact, recommendations });
  return recommendations;
};

const main = async (): Promise<void> => {
  const runDir = process.argv[2];
  if (runDir === undefined) {
    throw new Error(`${RECOMMEND_COMMAND} <run directory>: which run to recommend over`);
  }
  const report = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  await recommendOverRun(resolve(runDir), report);
  report(`recommendations: wrote ${resolve(runDir)}`);
};

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) await main();
