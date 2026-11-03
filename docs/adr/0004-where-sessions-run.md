# 4. Where a session runs is one variable, and a remote session is a Cloud Run job execution

- **Status:** Accepted
- **Date:** 2026-11-04

## Context

A run is a hundred sessions, each one a Chromium with its pages (`docs/FLOW.md` section 13). Ten at a time on a laptop is two dozen sessions in a minute and a hundred in five; it is also the whole of what the machine can do, and it is the machine the person asking for the test happens to own. `docs/FLOW.md` section 17 lists "where a hundred concurrent browsers run" as the first of the five things this revision needs the owner for, and says the local path is the default everywhere.

The owner chose **Google Cloud Run jobs** on 2026-11-03, and dropped CloakBrowser the same day: `packages/browser` stays on Playwright Chromium, which is a setup Playwright documents and publishes an image for, so there is no open question about whether the browser runs in a container.

Two facts shaped this more than the choice of provider did:

1. **A Cloud Run task cannot write to the owner's disk.** A run directory is a directory on the machine that asked for the run. A remote session's session file, its run contributions and its video have to come back some other way, which is the object store of #316 (`PV_VIDEO_BUCKET`).
2. **The caps are about the site, not about us.** A hundred agents a run, ten browsers at a time per site and four runs an hour per site exist so that a hundred stealth browsers cannot be pointed at a small site. Moving to managed jobs makes more compute available and changes none of that.

## Decision

**One seam, two implementations, chosen by `PV_RUNNER` in exactly one place.**

```ts
type SessionRunner = (request: SessionRunRequest) => Promise<WalkedSession>;
```

`PV_RUNNER` unset, empty or `local` is the swarm's own pool — a session in this process, bounded by the concurrency its caller hands it, which is what every test, the acceptance suite and the demo run. `cloud-run` is one job execution per session, configured by `PV_GCP_PROJECT`, `PV_GCP_REGION`, `PV_RUNNER_JOB`, `PV_RUNNER_IMAGE` and `PV_RUNNER_CONCURRENCY`. `chooseRunner` is the only function in the repository that reads `PV_RUNNER`, and nothing downstream of it branches on the answer.

**A session is a session wherever it runs.** The same persona, the same seed, the same task and the same written session file, so a run driven remotely reads back through `@personavision/contract` identically to a local run of the same seeds. The far end calls the same `runSession`; what the container decides is only where to write, what to drive and who decides — a scratch directory, `createLiveSource()`, and `@personavision/provider`'s own selection.

**The Jobs API goes through an injected transport**, the shape every third-party call here takes, and the default is built only when none is given. A local run constructs no cloud client at all. The default transport is plain `fetch` against the regional Cloud Run endpoint and takes its access token from the metadata server of the machine it runs on: no Google client library, no dependency whose transport we could not inject, and no credential read by this repository.

**A failed execution is a typed automation failure, not a lost run.** A task that died, a quota refusal, an image that will not start and an execution that succeeded and left no session behind are read from what the API answered and recorded as **that one session's** outcome, carrying what was asked (the job, the image, the session) and what was answered (the status and the words). They are counted in the run's automation-failure total, the rule that a run whose failures exceed a fifth of its sessions says so above its summary holds unchanged, and the other ninety-nine sessions are untouched.

**No new failure kind.** `AUTOMATION_FAILURE_KINDS` stays five words. An execution past its cap is `wall_clock_timeout`, which is exactly what it is; the other four are `navigation_error`, which is already how this repository records breakage of ours it cannot place. The kind is never the record — the sentence is, and each of the four has its own.

**Nothing runs for ever, and the two clocks do not start together.** The session's wall-clock cap is passed to the task as the execution's own timeout, which Cloud Run starts when the task begins **running**; the coordinator's wait starts when the execution is **created**. So the coordinator waits the session's cap plus `PV_RUNNER_START_ALLOWANCE_MS` — five minutes by default, longer than a session's own budget — plus a write-up grace, and is never the first clock to fire on a session that is still working. Without the allowance a cold run would cancel every session before its container had started. Either half still going at that point, the execution or the collection of what it wrote, is given up on: the execution is cancelled, by name, and reported.

**The image is built from the repository, and the run records its tag.** `Dockerfile.session-runner` copies the committed tree, installs with `--frozen-lockfile`, and installs Chromium with `playwright install --with-deps chromium`; `.dockerignore` keeps a developer's `node_modules`, `dist` and `.git` out of it. The documented build command refuses a dirty tree and tags the image with the commit, and `run.json`'s new optional `runner` block records `where`, `image` and `concurrency` — so the first question asked of a remote run that went wrong, *which code drove it*, has an answer in the artifact.

**`PV_RUNNER_CONCURRENCY` is our own ceiling and is an input to the estimate.** `sessionsInFlight` takes the smallest of the per-site cap, what the caller asked for and this number; the estimate divides by what it produces, and the run runs at the same figure, so the launch screen quotes a speed the run will really keep. The three caps do not read it.

**A remote run with no bucket is refused before any execution is created**, with that reason. #316 and #317 are therefore built in that order.

## Consequences

**What this costs.** Per session, one Cloud Run task at 2 vCPU and 2 GiB for the length of a session. A hundred sessions of two minutes is about 3.3 vCPU-hours and 3.3 GiB-hours per run, which at Cloud Run's 2026 request-based rates is a few tens of US cents a run, plus the object store's egress for a hundred videos (#316 records that side) and one image pull per cold instance. The image is single-stage and large — it carries the whole workspace and a Chromium — and nobody has measured the pull; if a hundred cold starts a run turns out to be the slow part, the fix is a second build stage that keeps `dist`, the production `node_modules` and `/ms-playwright`, and nothing above changes.

**What cannot be reproduced from the repository.** The project, the region, the Artifact Registry repository, the job, the service account and its roles (#230), and the bucket (#228). They are the owner's, both are a `stroika:needs-human` ticket, and neither blocks anything: the local path is the default and no test reads a credential or opens a socket.

**What a reader of an old artifact sees.** `runner` is optional with no default, so a run written before this block carries none — which reads as a run that did not say where it ran, never as a run that ran locally.

**What was proved and what was not.** Everything on this side of the container boundary is tested: the requests made, the per-session environment, each failure's reading, the cancel at the cap, the refusal without a bucket, and a hundred sessions through the seam against a fake transport that runs the real task function. The image itself has not been built — the machine this was written on has no container runtime — and `docs/deployment.md` says so in those words rather than claiming a build nobody ran.
