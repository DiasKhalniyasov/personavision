import { join } from 'node:path';
import { readRun, runPaths, SCHEMA_VERSION, writeRun } from '@personavision/contract';
import { decideChange } from '@personavision/provider';
import { findings as writeFindings, score, verdict as writeVerdict } from '@personavision/scoring';
import { branchForRun, openChange } from './change/open.js';
import { postRunComment } from './comment/post.js';
import { GitHubCallError } from './github/errors.js';
import { previewRecordOf, resolvePreview } from './preview/resolve.js';
import type {
  Change,
  HoldoutVerdict,
  Improve,
  Preview,
  Recommendation,
  Run,
  Session,
} from '@personavision/contract';
import type { ChangeFile, WonderProvider } from '@personavision/provider';
import type { GitHubClient, GitHubRepository, PullRequestOpened } from './github/client.js';
import type { PullRequestRecord } from './change/open.js';
import type { RunCommentResult } from './comment/post.js';
import type { PreviewOptions, PreviewResolution } from './preview/resolve.js';

/**
 * The loop: path 2 from a finished path-1 run to a comment on a pull request, in order, with
 * every step able to stop it.
 *
 * Each piece of the step exists on its own — the client (#297), the change and its refusal
 * (#302), the preview (#300), the holdout (#303), the comparison (#304), the comment (#301).
 * This is the thing that runs them in order, decides what happens when one of them says no,
 * and is what `personavision improve <runId>` calls (`docs/FLOW.md` section 15).
 *
 * Six properties are load-bearing, and all six are tested rather than documented:
 *
 * 1. **The order is fixed and each step can stop it.** The connected repository, the change,
 *    the preview, the comparison, the comment — in that order, and a stop names the step and
 *    the reason. **What was already done stays done**: a pull request that was opened is
 *    never closed, deleted or re-opened because a later step failed, and the client has no
 *    call that could (#297). It is reported as open with no comparison yet.
 * 2. **Nothing is written twice**, and that is keyed on the **repository** rather than on our
 *    own disk: the branch of this run is read first, and where a pull request was already
 *    opened from it that pull request is reused. A user who deletes their `runs/` directory
 *    and runs `improve` again gets no second pull request on their repository. A branch that
 *    is there with **no** pull request is the refusal decision 112 chose: nothing is written
 *    to it, and the change opens under a new run id.
 * 3. **It never merges, on any path.** The client has no merge, close, delete or push call;
 *    this module adds no second path to one, and `tests/loop/transcript.test.ts` asserts it
 *    over the whole recorded transcript of a full successful loop rather than on the surface.
 * 4. **No credential anywhere but in the call.** The installation token is the client's, and
 *    this module never holds one: nothing here reads an environment variable, no reported
 *    line is composed from anything but a repository, a pull request and a preview, and a
 *    GitHub failure arrives already redacted ({@link GitHubCallError}).
 * 5. **A dry run makes no write call**, because the client it is handed cannot make one: the
 *    whole of {@link openChange} runs against a read-only view that refuses every write, so
 *    the refusals, the reads and the patch check all happen and the transcript is provably
 *    read-only. It reports the change, the file, the diff and the preview it would resolve.
 * 6. **It drives nothing itself.** The swarm, the browser and the people are reached through
 *    {@link DriveComparison}, which is the caller's — so this package stays free of
 *    Playwright and a test of the loop is a test of the order rather than of a hundred
 *    sessions. The caller that drives it for real is `@personavision/cli`'s `improve`.
 */

/** The steps, in the order the loop runs them. A stop names one of these. */
export const IMPROVE_STEPS = ['repository', 'change', 'preview', 'comparison', 'comment'] as const;

export type ImproveStep = (typeof IMPROVE_STEPS)[number];

/** What a finished loop produced: a run, a pull request, and the comment on it. */
export interface ImproveFinished {
  readonly kind: 'finished';
  readonly runId: string;
  readonly runDir: string;
  /** The path-2 run as it was written: the change, the preview, the holdout, the figures. */
  readonly run: Run;
  readonly pullRequest: PullRequestRecord;
  /** Posted, or edited where this product had already commented on that pull request. */
  readonly comment: RunCommentResult;
  /** Whether this call drove the comparison or found it already done and updated the comment. */
  readonly drove: boolean;
}

/**
 * Which step stopped the loop and why — and what had already happened when it did.
 *
 * `pullRequest` is the whole of "what was already done stays done": it is set whenever a
 * pull request exists on the repository, including on every stop after the change was
 * opened, and nothing about it is undone.
 */
export interface ImproveStopped {
  readonly kind: 'stopped';
  readonly step: ImproveStep;
  readonly reason: string;
  readonly runId: string;
  readonly runDir: string;
  /** The pull request that is open, where one is. Never closed and never re-opened. */
  readonly pullRequest?: PullRequestRecord;
  /** The preview, where one was resolved into a record — a URL, or the stated nothing. */
  readonly preview?: Preview;
  /** The run this stop wrote, where it wrote one. */
  readonly run?: Run;
}

/** What `--dry-run` reports: everything it would do, and the nothing it wrote. */
export interface ImproveDryRun {
  readonly kind: 'dry_run';
  readonly runId: string;
  /** The change Muse Wonder decided, or `undefined` where it was refused. */
  readonly change?: Change;
  /** Why no change would be opened, where that is the answer. */
  readonly reason?: string;
  /** The branch the change would be written on. */
  readonly branch: string;
  /** The pull request already open from that branch, where there is one. */
  readonly pullRequest?: PullRequestRecord;
  /** The preview this loop would resolve, in the words the report prints. */
  readonly preview: string;
}

export type ImproveResult = ImproveFinished | ImproveStopped | ImproveDryRun;

/** The finished path-1 run the change comes from, by value. */
export interface SourceRun {
  /** The run's own id, which the improve run is named after. */
  readonly runId: string;
  readonly run: Run;
  /** Its own `recommendations.json`, which the change answers one of. */
  readonly recommendations: readonly Recommendation[];
}

/** The change as the open run records it, bar the holdout — which is the driver's answer. */
export type ChangeUnderWay = Omit<Improve, 'holdout'>;

/** The two versions a comparison drives, as the run declares a variant. */
export interface ComparisonVariant {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

/** Everything the caller needs to drive the baseline, the change and the holdout. */
export interface ComparisonRequest {
  /** The run to write: named by the loop, and not yet on disk. */
  readonly runId: string;
  readonly runDir: string;
  /** The site as it is — the version of the source run the recommendation came from. */
  readonly baseline: ComparisonVariant;
  /** The pull request's version, at the URL the preview resolved to. */
  readonly change: ComparisonVariant;
  /**
   * What the open run records of the change. The holdout is **not** here: the driver
   * generates the people, so the driver completes the block with
   * `holdout: { personaIds, confirmed: null }` for the run it opens, and the loop writes
   * `confirmed` once scoring has judged it.
   */
  readonly improve: ChangeUnderWay;
  /** The run the change was recommended from: its audience, its task and its seeds. */
  readonly source: Run;
  readonly report: (line: string) => void;
}

/** What driving the comparison produced. Nothing of it is scored. */
export interface ComparisonDriven {
  /** The run as the swarm closed it: every session landed, nothing scored. */
  readonly run: Run;
  readonly sessions: readonly Session[];
  /** The per-area aggregates the scoring reads, which the engine produced. */
  readonly aoiMetrics: Run['aoiMetrics'];
  /** Exactly the people driven as the holdout, in the order the generator drew them. */
  readonly holdoutPersonaIds: readonly string[];
}

/**
 * The baseline, the change and the holdout in one run — the caller's, because it reaches the
 * swarm and so Chromium, and this package reaches neither.
 */
export type DriveComparison = (request: ComparisonRequest) => Promise<ComparisonDriven>;

export interface ImproveRequest {
  /** Where run directories sit — `./runs`, from where the command was run. */
  readonly runsRoot: string;
  readonly source: SourceRun;
  /**
   * The connected repository, or absent for a workspace that has connected none — which is
   * refused with the sentence that says what to connect, and nothing is written.
   */
  readonly repository?: GitHubRepository;
  /**
   * The branch the pull request is opened against. **Read only**: it is the commit a branch
   * of ours starts from, and nothing in this product writes to it.
   */
  readonly baseBranch: string;
  /** The files the change may touch, as #263's decision is handed them. */
  readonly files: readonly ChangeFile[];
  /** Muse Wonder, through whichever implementation the caller selected. */
  readonly wonder: WonderProvider;
  readonly client: GitHubClient;
  readonly drive: DriveComparison;
  /** Where the run is on the platform; the comment links to it and to nothing else. */
  readonly runUrl: (runId: string) => string;
  /** Every line the loop reports. It never carries a credential. */
  readonly report?: (line: string) => void;
  /** Report what it would do and write nothing: no branch, no commit, no pull request. */
  readonly dryRun?: boolean;
  /** The caps on waiting for a preview deployment, and the probe that asks the URL. */
  readonly preview?: PreviewOptions;
  /** Opened as a draft where the caller asks for one. It is never merged either way. */
  readonly draft?: boolean;
}

/**
 * The run directory a loop writes, named for the run it improves.
 *
 * It is **deterministic**, which is what makes "the comparison is already done" a question
 * that can be asked of the disk: a second `improve` of one run reads the run the first one
 * wrote rather than opening a directory beside it. It is also what names the branch, so the
 * branch of a run is the same branch on every attempt and the repository can answer whether
 * the change was already opened.
 *
 * The suffix is a **suffix** and not a prefix because a run directory's name is the run's id
 * and a run id begins with the date and time the run was asked for — `listRunDirs` in
 * `@personavision/contract` recognises a run directory by exactly that, and the server mounts
 * what it lists. `improve-2026-…` is not a name this product can list, serve or open, which
 * `tests/path2-cold-start.test.ts` is where we found out: with it, `personavision open` said
 * there was no test under `./runs` and the Improve screen of a real path-2 run was a 404.
 */
export const improveRunId = (sourceRunId: string): string => `${sourceRunId}-improve`;

/**
 * The two versions a path-2 run declares, in the user's own words (`docs/FLOW.md` section
 * 16): **baseline** is the site as it is and **the change** is the pull request's version.
 *
 * The ids are this run's own and not the source run's. A comparison is between two versions
 * of one site, so a run that borrowed the ids of whatever the path-1 test happened to call
 * its versions could name the same id twice — which the contract refuses, and rightly. `A`
 * and `B` are what every other run of this product spells its two versions, so the
 * screenshot paths and the score rows of a path-2 run read like any other's.
 */
const BASELINE_VARIANT = { id: 'A', name: 'Baseline' } as const;
const CHANGE_VARIANT = { id: 'B', name: 'The change' } as const;

/** The states the artifact records of a pull request. GitHub's `draft` is not one of them. */
type RecordedState = NonNullable<Improve['pullRequest']['state']>;

const RECORDED_STATES: readonly RecordedState[] = ['open', 'closed', 'merged'];

const recordedState = (state: string): RecordedState | undefined =>
  RECORDED_STATES.find((recorded) => recorded === state);

/** The one mapping from a recorded verdict back to the boolean the artifact stores. */
const confirmedOf = (verdict: HoldoutVerdict | undefined): boolean | null => {
  if (verdict === 'confirmed') return true;
  if (verdict === 'not_confirmed') return false;
  return null;
};

/** What a run that was stopped before a session ran says where a finished one has figures. */
const NOTHING_WAS_RUN = 'Nothing was simulated: this test stopped before it could run.';

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** No repository, said as the sentence that names what to connect. */
const NO_REPOSITORY =
  'Path 2 needs a connected repository: this run’s workspace has connected none, so there is no repository to open a pull request on. Connect a GitHub repository — a PersonaVision GitHub App installed on one repository — and run improve again. Nothing was written.';

const pullRequestRecordOf = (
  repository: GitHubRepository,
  opened: PullRequestOpened,
): PullRequestRecord => ({
  repository: `${repository.owner}/${repository.repo}`,
  number: opened.number,
  url: opened.url,
  title: opened.title,
  state: opened.draft ? 'draft' : opened.state,
});

/**
 * A view of the client that cannot write.
 *
 * This is how `--dry-run` is a property rather than a promise: {@link openChange} is run in
 * full against it — the refusals, the two reads and the patch applied to the repository's own
 * content all happen — and the first write it reaches throws {@link WouldWriteError} instead
 * of creating anything. The transcript a dry run leaves is therefore read-only by
 * construction, which is what a test can assert.
 */
class WouldWriteError extends Error {
  readonly call: string;

  constructor(call: string) {
    super(`a dry run makes no write call, and this would have called ${call}`);
    this.name = 'WouldWriteError';
    this.call = call;
  }
}

const readOnly = (client: GitHubClient): GitHubClient => {
  const refuse = (call: string) => async (): Promise<never> => {
    throw new WouldWriteError(call);
  };
  return {
    readBranch: client.readBranch,
    readFile: client.readFile,
    readPullRequest: client.readPullRequest,
    readPullRequestsForBranch: client.readPullRequestsForBranch,
    readDeployments: client.readDeployments,
    readDeploymentStatuses: client.readDeploymentStatuses,
    readComments: client.readComments,
    createBranch: refuse('createBranch'),
    writeFile: refuse('writeFile'),
    openPullRequest: refuse('openPullRequest'),
    postComment: refuse('postComment'),
    editComment: refuse('editComment'),
  };
};

/** The commit a branch of ours points at, or `undefined` because there is no such branch. */
const headOfOurBranch = async (
  client: GitHubClient,
  repository: GitHubRepository,
  branch: string,
): Promise<string | undefined> => {
  try {
    return (await client.readBranch(repository, branch)).sha;
  } catch (error) {
    // 404 is the answer "there is no such branch", which is the normal first attempt. Any
    // other failure is GitHub not answering what was asked, and is the caller's to report.
    if (error instanceof GitHubCallError && error.kind === 'not_found') return undefined;
    throw error;
  }
};

/**
 * The pull request this product already opened from a branch of its own, where there is one.
 *
 * Newest first is GitHub's own order for this listing, and the newest is the one a resumed
 * run reports on: a branch with two pull requests on it has had one closed, and the comment
 * belongs on the one that is current.
 */
const alreadyOpened = async (
  client: GitHubClient,
  repository: GitHubRepository,
  branch: string,
): Promise<PullRequestOpened | undefined> =>
  (await client.readPullRequestsForBranch(repository, branch))[0];

/** The run a previous loop finished, where the comparison is already done. */
const finishedComparison = async (runDir: string): Promise<Run | null> => {
  const artifact = await readRun(runDir).catch(() => null);
  if (artifact === null) return null;
  const { run } = artifact;
  if (run.status !== 'finished' || run.improve === undefined) return null;
  const sides = [run.improve.baselineVariant, run.improve.changeVariant];
  const scored = sides.every((variant) =>
    run.scores.some((row) => row.variant === variant && row.taskId === run.task.id),
  );
  return scored ? run : null;
};

/**
 * What a loop that stopped before there was anything to compare leaves on disk: a run
 * recorded as **failed**, naming the step that stopped it and the pull request that is open.
 *
 * It carries no `improve` block, because that block names a change variant and a variant
 * carries the URL it was opened at — and the change was never served at one. So the pull
 * request is in the failure's detail, where a person reads it, and in this call's own answer,
 * where the platform reads it. Decided on #306.
 */
const stoppedRunRecord = (
  source: Run,
  runId: string,
  reason: string,
  detail: string,
  at: string,
): Run => {
  const baseline = source.variants[0];
  const step = source.steps[0];
  if (baseline === undefined || step === undefined) {
    throw new Error(`${runId}: the run this change came from declares no version to compare`);
  }
  // A verdict names the evidence it turns on and the evidence has to be a screenshot the run
  // declares, so the baseline's own first screen is declared and the verdict points at it —
  // the same placeholder an open run carries (`@personavision/cli`'s `openRunRecord`).
  const screen = source.screenshots.find((shot) => shot.variant === baseline.id) ?? {
    variant: baseline.id,
    step: step.id,
    path: runPaths('').screenshot(baseline.id, step.id),
    viewport: source.personas[0]?.device.viewport ?? { width: 1, height: 1 },
    pageHeight: source.personas[0]?.device.viewport.height ?? 1,
    foldY: source.personas[0]?.device.viewport.height ?? 1,
  };
  return {
    ...source,
    runId,
    createdAt: at,
    status: 'failed',
    startedAt: at,
    finishedAt: at,
    failure: { reason, detail },
    progress: { totalSessions: 0, finishedSessions: 0, perVariant: [], sessions: [] },
    variants: [baseline],
    sessionIds: [],
    screenshots: [screen],
    stepCaptions: [],
    aois: [],
    aoiMetrics: [],
    scores: [],
    // Nothing was simulated, so nothing was measured: the placeholders say so in words
    // rather than carrying the source run's own figures over onto a run that has none.
    verdict: {
      harderVariant: baseline.id,
      gapPoints: 0,
      bandsDisjoint: false,
      seedGroupsAgreeing: 0,
      sentence: NOTHING_WAS_RUN,
      preferredVariant: baseline.id,
      audienceSentence: NOTHING_WAS_RUN,
      reasons: [NOTHING_WAS_RUN],
      headlineFindingIds: [],
      heroEvidence: { variant: screen.variant, step: screen.step, aoiId: null },
    },
    // No model was called into this run, and a Wonder call's own figures belong to the run
    // that recorded a change: this one recorded none.
    usage: undefined,
    reproduce: undefined,
    improve: undefined,
  };
};

const writeStoppedRun = async (runDir: string, run: Run): Promise<Run | undefined> => {
  // A directory that cannot be written is not worth losing the reason the loop stopped over:
  // the stop is reported either way, and this is the record beside it.
  const written = await writeRun(runDir, {
    run,
    sessions: [],
    findings: { schemaVersion: SCHEMA_VERSION, runId: run.runId, findings: [] },
  })
    .then(() => run)
    .catch(() => undefined);
  return written;
};

/** The preview a dry run would look for, in the one sentence the report prints. */
const previewItWouldResolve = (
  repository: GitHubRepository,
  branch: string,
  pullNumber: number | undefined,
): string =>
  `the preview deployment ${repository.owner}/${repository.repo} publishes for ${
    pullNumber === undefined
      ? `the pull request this change would open from ${branch}`
      : `pull request #${String(pullNumber)}`
  }, read from the deployment statuses of that branch’s head commit. PersonaVision never runs your build.`;

export const runImproveLoop = async (request: ImproveRequest): Promise<ImproveResult> => {
  const report = request.report ?? ((): void => undefined);
  const { source, repository, client } = request;
  const runId = improveRunId(source.runId);
  const runDir = join(request.runsRoot, runId);
  const branch = branchForRun(runId);
  const dryRun = request.dryRun ?? false;

  const stop = (step: ImproveStep, reason: string, over: Partial<ImproveStopped> = {}) => {
    report(`Stopped at the ${step} step: ${reason}`);
    return { kind: 'stopped' as const, step, reason, runId, runDir, ...over };
  };

  /* ---- the repository ---------------------------------------------------- */

  if (repository === undefined) return stop('repository', NO_REPOSITORY);
  const where = `${repository.owner}/${repository.repo}`;
  report(
    `Improving ${source.runId} on ${where}, against ${request.baseBranch}${dryRun ? ' — a dry run: nothing is written' : ''}.`,
  );

  /* ---- the comparison a previous loop already made ----------------------- */

  const done = dryRun ? null : await finishedComparison(runDir);
  if (done !== null) {
    const recorded = done.improve;
    if (recorded === undefined) throw new Error(`${runDir}: this run lost its change`);
    report(`Step 1 of 2 — ${runId} already carries the before and after. Nothing is run again.`);
    const comment = await postRunComment(client, { run: done, runUrl: request.runUrl(runId) });
    const open: PullRequestRecord = { ...recorded.pullRequest, state: 'open' };
    if (comment.kind === 'refused') {
      return stop('comment', comment.reason, {
        pullRequest: open,
        run: done,
        preview: recorded.preview,
      });
    }
    report(
      `Step 2 of 2 — the comment on pull request #${String(recorded.pullRequest.number)} was ${comment.kind}.`,
    );
    return { kind: 'finished', runId, runDir, run: done, pullRequest: open, comment, drove: false };
  }

  /* ---- the change, or the pull request already opened for it -------------- */

  const head = await headOfOurBranch(client, repository, branch);
  const opened = head === undefined ? undefined : await alreadyOpened(client, repository, branch);
  if (head !== undefined && opened === undefined) {
    return stop(
      'change',
      `the branch ${branch} is already on ${where} and carries no pull request of ours, and this run writes a branch of its own rather than over one that is there: nothing was written and nothing was overwritten. The change opens under a new run id.`,
    );
  }

  if (source.recommendations.length === 0) {
    return stop(
      'change',
      `${source.runId} recommended nothing, so there is no change to decide: a change answers one of a run’s own recommendations. Nothing was written.`,
    );
  }
  if (request.files.length === 0) {
    return stop(
      'change',
      'a change touches a file, and this loop was handed none: the files the change may touch come from the connected repository and are passed in. Nothing was written.',
    );
  }

  report(
    `Step 1 of 5 — deciding one change from ${String(source.recommendations.length)} ${source.recommendations.length === 1 ? 'recommendation' : 'recommendations'}, over ${String(request.files.length)} ${request.files.length === 1 ? 'file' : 'files'}.`,
  );
  const decided = await decideChange(request.wonder, {
    recommendations: [...source.recommendations],
    files: [...request.files],
    seed: source.run.seedGroups[0] ?? 1,
  });
  const change = decided.value;
  const recommendation = source.recommendations.find(
    (entry) => entry.id === change.recommendationId,
  );
  if (recommendation === undefined) {
    return stop(
      'change',
      `the change answers recommendation ${change.recommendationId} and ${source.runId} recommended ${source.recommendations.map((entry) => entry.id).join(', ')}: nothing was written.`,
    );
  }
  report(`  ${change.changedFile}, answering ${recommendation.id}: ${recommendation.sentence}`);

  const changeRequest = {
    repository,
    runId,
    baseBranch: request.baseBranch,
    change,
    recommendation,
    files: request.files,
    ...(request.draft === undefined ? {} : { draft: request.draft }),
  };

  /* ---- the dry run stops here, having written nothing --------------------- */

  if (dryRun) {
    const reused = opened === undefined ? undefined : pullRequestRecordOf(repository, opened);
    let refusal: string | undefined;
    if (opened === undefined) {
      try {
        const attempt = await openChange(readOnly(client), changeRequest);
        // The read-only view refuses every write, so reaching an answer at all means the
        // change was refused before anything would have been created.
        refusal = attempt.kind === 'refused' ? attempt.reason : undefined;
      } catch (error) {
        if (!(error instanceof WouldWriteError)) throw error;
      }
    }
    const preview = previewItWouldResolve(repository, branch, opened?.number);
    report(
      refusal === undefined
        ? `It would open "${change.pullRequest.title}" on ${where}, from ${branch} against ${request.baseBranch}, changing ${change.changedFile}:`
        : `It would open nothing: ${refusal}`,
    );
    if (refusal === undefined) for (const line of change.patch.split('\n')) report(`  | ${line}`);
    if (reused !== undefined) {
      report(
        `  Pull request #${String(reused.number)} is already open from ${branch}: it would be reused.`,
      );
    }
    report(`It would then resolve ${preview}`);
    report('Nothing was written: no branch, no commit, no pull request and no comment.');
    return {
      kind: 'dry_run',
      runId,
      branch,
      preview,
      ...(refusal === undefined ? { change } : { reason: refusal }),
      ...(reused === undefined ? {} : { pullRequest: reused }),
    };
  }

  /* ---- the pull request --------------------------------------------------- */

  let pullRequest: PullRequestRecord;
  let headSha: string;
  let changedFile: string;

  if (opened !== undefined && head !== undefined) {
    // Resumed. The pull request on the repository is the record, and the change decided just
    // now has to be the one it carries — a title that does not match is a pull request this
    // run did not open, and it is refused rather than commented on.
    if (opened.title !== change.pullRequest.title) {
      return stop(
        'change',
        `pull request #${String(opened.number)} is open from ${branch} on ${where} and is titled "${opened.title}", and the change decided for this run is "${change.pullRequest.title}": this loop comments on the pull request it opened and on no other. The change opens under a new run id.`,
        { pullRequest: pullRequestRecordOf(repository, opened) },
      );
    }
    pullRequest = pullRequestRecordOf(repository, opened);
    headSha = head;
    changedFile = change.changedFile;
    report(
      `Step 2 of 5 — pull request #${String(opened.number)} is already open from ${branch}: it is reused and no second one is opened.`,
    );
  } else {
    report(`Step 2 of 5 — opening the change as a pull request on ${where}.`);
    const result = await openChange(client, changeRequest);
    if (result.kind === 'refused') return stop('change', result.reason);
    pullRequest = result.pullRequest;
    headSha = result.headSha;
    changedFile = result.changedFile;
    report(
      `  Pull request #${String(result.pullRequest.number)} is ${result.pullRequest.state}: ${result.pullRequest.url}`,
    );
  }

  /* ---- the preview -------------------------------------------------------- */

  report(`Step 3 of 5 — resolving the preview for pull request #${String(pullRequest.number)}.`);
  const resolution: PreviewResolution = await resolvePreview(
    client,
    { repository, pullNumber: pullRequest.number, sha: headSha },
    request.preview ?? {},
  );
  if (resolution.kind !== 'preview') {
    const preview = previewRecordOf(resolution);
    const run = await writeStoppedRun(
      runDir,
      stoppedRunRecord(
        source.run,
        runId,
        resolution.kind === 'no_preview'
          ? 'The change has no preview deployment to be tested at'
          : 'The change’s preview deployment could not be used',
        [
          preview.reason ?? '',
          `Pull request #${String(pullRequest.number)} — "${pullRequest.title}" — is open on ${where} at ${pullRequest.url}, and stays open: nothing about it was undone. There is no before and after yet.`,
        ].join('\n'),
        new Date().toISOString(),
      ),
    );
    return stop('preview', preview.reason ?? resolution.reason, {
      pullRequest,
      preview,
      ...(run === undefined ? {} : { run }),
    });
  }
  report(`  The change is served at ${resolution.url} — ${resolution.answered}`);

  /* ---- the comparison ----------------------------------------------------- */

  const baseline = source.run.variants[0];
  if (baseline === undefined) {
    return stop(
      'comparison',
      `${source.runId} declares no version to compare the change against. Nothing was run.`,
      { pullRequest, preview: previewRecordOf(resolution) },
    );
  }
  const baselineVariant: ComparisonVariant = { ...BASELINE_VARIANT, url: baseline.url };
  const changeVariant: ComparisonVariant = { ...CHANGE_VARIANT, url: resolution.url };
  const underWay: ChangeUnderWay = {
    recommendationId: recommendation.id,
    // The two fields the Improve screen prints beside the pull request's title: the
    // recommendation in the pipeline's own words, and the diff itself. Both are in hand
    // here — the recommendation this change answers and the patch Wonder decided — and
    // **decision 116 option A** is what the screen was built against: the run carries the
    // patch, the pull request's state and the recommendation's own sentence, and the screen
    // prints the diff rather than sending the reader to GitHub to find out what was written
    // in their repository (#227, user story 4). Until #307 drove that screen against a run
    // this loop had actually written, none of the three was ever recorded. A resumed loop
    // records the same: the pull request it reuses is the one this change opened, asserted
    // on its title just above.
    recommendationSentence: recommendation.sentence,
    patch: change.patch,
    changedFile,
    pullRequest: {
      repository: pullRequest.repository,
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
      // The state the screen prints beside the repository and the number. The contract
      // records `open`, `closed` or `merged` and no fourth: a **draft** is how a pull
      // request was opened rather than where it stands, so a draft records no state and
      // the tag carries the repository and the number alone.
      ...(recordedState(pullRequest.state) === undefined
        ? {}
        : { state: recordedState(pullRequest.state) }),
    },
    preview: previewRecordOf(resolution),
    baselineVariant: baselineVariant.id,
    changeVariant: changeVariant.id,
  };

  report(
    `Step 4 of 5 — driving ${baselineVariant.name} at ${baselineVariant.url} and ${changeVariant.name} at ${changeVariant.url}, on the same people and seeds, plus the holdout.`,
  );
  let driven: ComparisonDriven;
  try {
    driven = await request.drive({
      runId,
      runDir,
      baseline: baselineVariant,
      change: changeVariant,
      improve: underWay,
      source: source.run,
      report,
    });
  } catch (error) {
    return stop('comparison', reasonOf(error), {
      pullRequest,
      preview: underWay.preview,
    });
  }

  /* ---- the before and after, written ------------------------------------- */

  const scores = score(
    driven.sessions,
    driven.run.aois,
    driven.aoiMetrics,
    driven.run.task,
    driven.holdoutPersonaIds,
  );
  const found = writeFindings(driven.sessions, driven.run.aois, driven.aoiMetrics, scores);
  const verdict = writeVerdict(
    scores,
    found,
    driven.run.audience,
    {
      baselineVariant: underWay.baselineVariant,
      changeVariant: underWay.changeVariant,
    },
    // The sessions, for the one fact the scores cannot carry when the task declared no
    // control that advances it: the furthest step they reached, which is the step the
    // hero evidence then points at (#422).
    driven.sessions,
  );
  const improve: Improve = {
    ...underWay,
    holdout: {
      personaIds: [...driven.holdoutPersonaIds],
      // The one mapping between the record and the notice, read off the verdict that judged
      // it: a holdout that ran and could not separate the two versions is `null` and reads
      // as `none`, which is what `judgeHoldout` answered (#304).
      confirmed: driven.holdoutPersonaIds.length === 0 ? null : confirmedOf(verdict.holdout),
    },
  };
  const run: Run = { ...driven.run, aoiMetrics: driven.aoiMetrics, scores, verdict, improve };
  // The figures the run wrote for itself as the sessions landed (#293), carried through this
  // write. `writeRun` owns the directory it writes and removes an `aggregate.json` it is not
  // given — which is right for a run written over an older one, and wrong here, where the
  // file is this run's own and nothing between the drive and here has changed what it is of.
  // Passing on the artifact that was read is what the writer's own doc holds a caller that
  // means to keep the aggregate to.
  //
  // A directory that cannot be read has no figures to carry, and that is all the failure
  // means here: this write is the loop's first on any path whose driver wrote nothing, and
  // what it falls back to is exactly what it did before there were figures to keep.
  const figures = await readRun(runDir).then(
    (artifact) => artifact.aggregate,
    () => undefined,
  );
  await writeRun(runDir, {
    run,
    sessions: [...driven.sessions],
    findings: { schemaVersion: SCHEMA_VERSION, runId: run.runId, findings: found },
    ...(figures === undefined ? {} : { aggregate: figures }),
  });
  report(`  ${verdict.audienceSentence}`);

  /* ---- the comment -------------------------------------------------------- */

  report(`Step 5 of 5 — the comment on pull request #${String(pullRequest.number)}.`);
  const comment = await postRunComment(client, { run, runUrl: request.runUrl(runId) });
  if (comment.kind === 'refused') {
    return stop('comment', comment.reason, { pullRequest, preview: improve.preview, run });
  }
  report(`  The comment was ${comment.kind}: ${comment.comment.url}`);
  return { kind: 'finished', runId, runDir, run, pullRequest, comment, drove: true };
};
