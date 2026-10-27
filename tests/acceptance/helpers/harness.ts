/**
 * The mechanics the acceptance gate runs on: a regeneration into a throwaway directory, a
 * fingerprint of a directory's contents, a copy of the demo shop with one planted defect
 * taken out, and the prose a missed defect is reported with.
 *
 * Nothing here decides a number. The pipeline is `scripts/generate-demo-run.ts` — the
 * generation ticket's own script (#78), not a second copy of it — and every figure the gate
 * asserts comes back from that script or off the artifact it wrote. What lives here is only
 * the plumbing that would otherwise crowd out the assertions in `../pipeline.test.ts`.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPaths } from '@personavision/contract';
import { findingRuleIdOf } from '@personavision/scoring';
import { generateDemoRun, RUN_ID } from '../../../scripts/generate-demo-run.js';
import type { Findings, Run } from '@personavision/contract';
import type { Finding, PlantedDefect, PlantedDefectEvaluation } from '@personavision/scoring';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** The committed artifact the gate must not touch. */
export const committedRunDir = join(repoRoot, 'runs', RUN_ID);

/** The demo shop as it is served to a real run. */
const shopRoot = join(repoRoot, 'demo', 'northwind');

/** The only directories `serveDemoShop` serves, so the only ones a copy of it needs. */
const SERVED_DIRECTORIES = ['a', 'b', 'shared'] as const;

/** A temporary directory of this suite's, named so that a leftover says whose it was. */
const scratch = (what: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `personavision-acceptance-${what}-`));

/** One regeneration: where it was written, and the artifact that was written there. */
export interface Regeneration {
  /** The temporary `runs/` the run was written into — pass it to `discard` when done. */
  readonly runsRoot: string;
  readonly runDir: string;
  /** `run.json`, read back off disk rather than taken from the generator's return. */
  readonly run: Run;
  /** `findings.json`, likewise: what the gate judges is the artifact, not an object. */
  readonly findings: Findings;
}

export interface RegenerateOptions {
  /** The shop to serve. The demo shop itself unless a copy of it is being served. */
  readonly shopRoot?: string;
  /** Where the run's own report goes. Dropped when nothing is given. */
  readonly report?: (line: string) => void;
}

/**
 * Regenerate the run into a directory of its own.
 *
 * The temporary root is handed back rather than removed here, because the gate reads the
 * artifact after the run has finished and a determinism check holds two of them at once.
 */
export const regenerate = async (options: RegenerateOptions = {}): Promise<Regeneration> => {
  const runsRoot = await scratch('run');
  const runDir = join(runsRoot, RUN_ID);
  const paths = runPaths(runDir);
  const read = async <Parsed>(file: string): Promise<Parsed> =>
    JSON.parse(await readFile(file, 'utf8')) as Parsed;

  try {
    await generateDemoRun({ runsRoot, ...options });
    return {
      runsRoot,
      runDir,
      run: await read<Run>(paths.run),
      findings: await read<Findings>(paths.findings),
    };
  } catch (error) {
    // Nothing is handed back, so no hook can be given this directory to remove: whether the
    // run failed or its artifact would not parse, what it half wrote goes now. The whole of
    // a run — twenty-four sessions and eight screenshots — is what would otherwise be left
    // in the temporary directory.
    await discard(runsRoot);
    throw error;
  }
};

/**
 * Remove a temporary directory, whatever happened to the run that wrote it — and nothing at
 * all when there is nothing to remove, which is what a hook running after a failed
 * regeneration is given.
 */
export const discard = async (directory: string | undefined): Promise<void> => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
};

/**
 * Every file under `directory`, as `<sha256> <bytes> <path>` lines, sorted.
 *
 * Contents and not timestamps: the question the gate asks of the committed run directory is
 * whether a regeneration changed anything in it, and a file rewritten with the same bytes
 * has changed nothing a screen or a test can see.
 */
export const fingerprint = (directory: string): string[] => {
  const lines: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else {
        const bytes = readFileSync(full);
        const digest = createHash('sha256').update(bytes).digest('hex');
        lines.push(`${digest} ${String(statSync(full).size)} ${relative}`);
      }
    }
  };
  walk(directory, '');
  return lines.sort();
};

/** The markup that puts variant B's completing action out of sight — planted defect 1. */
const SPACER = '<div class="pushdown" aria-hidden="true"></div>';

/**
 * A copy of the demo shop with planted defect 1 taken out: the 1400 px spacer above variant
 * B's completing action, and nothing else.
 *
 * This is how the gate is shown to bite. Defect 1 is the one the run finds, so removing it
 * is what makes recall fall — the control is above the fold, the sessions that reach the
 * review step look at it, and `never-fixated-primary-action` has nothing to report. The
 * real shop is never written to: the three served directories are copied and the edit is
 * made in the copy, which is removed again afterwards.
 */
export const shopWithoutDefect1 = async (): Promise<string> => {
  const root = await scratch('shop');
  try {
    for (const directory of SERVED_DIRECTORIES) {
      await cp(join(shopRoot, directory), join(root, directory), { recursive: true });
    }

    const review = join(root, 'b', 'review.html');
    const markup = await readFile(review, 'utf8');
    if (!markup.includes(SPACER)) {
      throw new Error(
        `b/review.html no longer carries ${SPACER}, so this is not the way defect 1 is planted any more: find how it is planted now and remove that instead`,
      );
    }
    await writeFile(review, markup.replace(SPACER, ''), 'utf8');
    return root;
  } catch (error) {
    // The copy is only ever handed back finished, so the caller has nothing to clean up
    // when the guard above fires — which it will the day defect 1 is planted another way.
    await discard(root);
    throw error;
  }
};

/** A finding, as a reader of a failure message needs to see it. */
const describeFinding = (finding: Finding): string =>
  `${finding.id} (rank ${String(finding.rank)}, ${finding.severity}, ${finding.variant ?? 'run'}/${finding.step}/${finding.aoiId ?? '—'})`;

/**
 * The finding nearest to a defect nothing was credited to: one carrying the same rule
 * somewhere else, failing that one in the same place under another rule, failing that
 * nothing.
 *
 * A number alone sends the next session back to re-derive which defect was missed and how
 * near the run came to it, which is the one thing a failed gate should not make anybody do.
 */
const closestTo = (defect: PlantedDefect, findings: readonly Finding[]): string => {
  const sameRule = findings.find((finding) => findingRuleIdOf(finding) === defect.ruleId);
  if (sameRule !== undefined) {
    return `${describeFinding(sameRule)} carries the same rule somewhere else`;
  }
  const samePlace = findings.find(
    (finding) => finding.variant === defect.variant && finding.step === defect.step,
  );
  if (samePlace !== undefined) {
    return `${describeFinding(samePlace)} is the nearest finding in the same place`;
  }
  return 'no finding carries its rule or names its step';
};

/**
 * What the run did with each declared defect, in declared order: the finding credited to
 * it, or the miss with the closest finding named.
 *
 * Passed as the message of every headline assertion, so a red gate reads as a report.
 */
export const defectReport = (
  defects: readonly PlantedDefect[],
  findings: readonly Finding[],
  evaluation: PlantedDefectEvaluation,
): string => {
  const lines = defects.map((defect, index) => {
    const findingId = evaluation.matched[index]?.findingId ?? null;
    const where = `${defect.ruleId} @ ${defect.variant}/${defect.step}/${defect.aoiId ?? '—'}`;
    if (findingId !== null) return `  ${defect.id} (${where}) → ${findingId}`;
    return `  ${defect.id} (${where}) → NOT FOUND; ${closestTo(defect, findings)}`;
  });

  return [
    `precision ${evaluation.precision.toFixed(3)}, recall ${evaluation.recall.toFixed(3)} over ${String(findings.length)} findings`,
    ...lines,
    '  findings, ranked:',
    ...findings.map((finding) => `    ${describeFinding(finding)}`),
  ].join('\n');
};
