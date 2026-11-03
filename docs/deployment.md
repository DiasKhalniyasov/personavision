# Deploying the session runner

Everything here is **optional**. With `PV_RUNNER` unset the product runs a hundred sessions on
the machine the command was typed on, ten at a time, which is what every test, the acceptance
suite and the demo do and what `docs/FLOW.md` section 17 point 1 calls the default. Nothing
below is needed to run, test or demonstrate PersonaVision.

Read it when you want a hundred sessions to run as **Google Cloud Run job executions** instead.

## What the image carries, and how much of this was actually run

The image is `Dockerfile.session-runner`. It starts from `node:22.20.0-bookworm-slim` and
installs the browser with

```
pnpm -F @personavision/browser exec playwright install --with-deps chromium
```

so it carries **Playwright's Chromium and the system libraries Chromium needs** —
`--with-deps` is the half that matters, because a slim Debian installs the browser binary
happily and then has no `libnss3`, `libatk-1.0` or `libasound2`, and Chromium exits before it
opens a page.

**Why this and not `mcr.microsoft.com/playwright:v1.64.1-noble`.** Playwright's own image is a
known-good container setup and would carry the same libraries. It also pins its own Node, and
this repository's `engines` field pins ours (`>=22.13.0 <23.0.0`); a session runner on a Node
nobody tested is a worse risk than one `apt` invocation. The published image stays the
fall-back if the dependency install ever becomes the slow part of a deployment — the two
differ in one `FROM` line.

**How much of this build has been run, and where.** Honestly: **none of it has been built or
started.** The `Dockerfile` and the commands on this page were written and reviewed against
Playwright's documented container setup; they have not been executed. The machine this was
written on has the Docker client installed (28.4.0) and **no reachable daemon**
(`Cannot connect to the Docker daemon at unix:///…/docker.sock`), so no image was built, no
container was started and no `playwright install` was run inside one. What *is* exercised by
the test suite is everything on this side of the container boundary: the requests the
coordinator makes, the per-session environment, how each failure is read, and the task
function the image's entry point calls — `packages/swarm/test/runner.test.ts` runs that
function in process, against the committed capture set, with no socket and no browser.

The first person with a container runtime should run the build command below once and replace
this paragraph with what happened.

## One command to build and push it

The tag is the commit, and the tree must be clean — an image built from uncommitted work is an
image nobody can map back to code, which is the one thing `run.json`'s `runner.image` field
exists to make impossible:

```
test -z "$(git status --porcelain)" \
  && TAG="$PV_GCP_REGION-docker.pkg.dev/$PV_GCP_PROJECT/personavision/session-runner:$(git rev-parse --short HEAD)" \
  && docker build -f Dockerfile.session-runner -t "$TAG" . \
  && docker push "$TAG" \
  && echo "PV_RUNNER_IMAGE=$TAG"
```

The line it prints is the value `PV_RUNNER_IMAGE` takes below, and the value the run records.

## Creating the job, once

The job is created once and then only ever run with per-execution overrides, so a deployment
is an image push and nothing else. `--parallelism 1` and `--tasks 1` because **the
coordinator** decides how many sessions are in flight, not the job: the caps belong to
`@personavision/platform` and a job that fanned out on its own would be a second opinion about
them.

```
gcloud run jobs create personavision-session-runner \
  --project "$PV_GCP_PROJECT" --region "$PV_GCP_REGION" \
  --image "$PV_RUNNER_IMAGE" \
  --tasks 1 --parallelism 1 --max-retries 0 \
  --memory 2Gi --cpu 2 --task-timeout 10m \
  --service-account "$PV_RUNNER_SERVICE_ACCOUNT"
```

**`--max-retries 0` is deliberate.** A retried task would walk the same site again under the
same session id and overwrite the session already collected, so a flaky execution would become
a silently different measurement. A failed execution is one session's typed automation
failure, counted in the run's integrity counters, and the run carries on — which is the
behaviour `docs/FLOW.md` section 8 asks for and the behaviour the tests pin.

**Memory.** 2 GiB per task is one Chromium with its pages plus the session's own buffers; the
figure to size this from is the per-session memory #246 measures, and it is the one number
from the session-video step this page depends on.

## The variables

| Variable                 | What it selects                                                                 |
| ------------------------ | ------------------------------------------------------------------------------- |
| `PV_RUNNER`              | `local` (the default, unset included) or `cloud-run`                             |
| `PV_GCP_PROJECT`         | the project the job lives in                                                     |
| `PV_GCP_REGION`          | the region the job lives in; the API is addressed at that region's endpoint       |
| `PV_RUNNER_JOB`          | the job's name. Optional; defaults to `personavision-session-runner`              |
| `PV_RUNNER_IMAGE`        | the image the job runs, **tag included**. Recorded on the run                     |
| `PV_RUNNER_CONCURRENCY`  | **our own** ceiling on sessions in flight. Never a per-site cap — see below       |
| `PV_RUNNER_START_ALLOWANCE_MS` | how long an execution may take to be scheduled and pull the image before the wait counts against the session. Optional; five minutes |
| `PV_VIDEO_BUCKET`        | where a remote session's output comes back through (#316). Required for `cloud-run` |

**Not one of them is a credential**, and this repository reads no variable whose name is key-,
token-, secret- or credential-shaped except the one sanctioned model-key read in
`packages/provider` — `tests/workspace.test.ts` holds the whole workspace to that. The
coordinator's own access token comes from the metadata server of the machine it runs on; a
coordinator hosted anywhere else injects a `JobsTransport` that knows how it is authorised, and
the default transport is built only when none is given.

### Two clocks, and why there is an allowance

Cloud Run's `--task-timeout` starts when the **task begins running**. The coordinator's own
wait starts when the **execution is created**, which is earlier by however long scheduling and
the image pull take. So the coordinator waits the session's cap *plus*
`PV_RUNNER_START_ALLOWANCE_MS` *plus* a second's write-up grace, and is never the first clock
to fire on a session that is still working.

Five minutes by default, which is longer than a session's own budget on purpose: the cost of
too much is that a genuinely hung execution is cancelled later than it could have been, and the
cost of too little is a cold run of a hundred sessions every one of which is cancelled before
its container started and recorded as having passed its cap without running. Lower it once you
know what a warm pull of your image costs.

### `PV_RUNNER_CONCURRENCY` moves the estimate and moves no cap

The three caps — **100 agents a run, 10 browsers at a time per site, 4 runs an hour per site** —
are `docs/FLOW.md` section 13's, they live in one place in `@personavision/platform`, and they
are about **the site being driven**. None of them reads this variable and raising it cannot put
an eleventh browser on a site.

What it does move is our own ceiling: `sessionsInFlight` takes the smallest of the per-site cap,
what the caller asked for and this number, and that is the figure the estimate divides the
sessions by to get its batches — so the launch screen quotes the speed the run will really run
at. Lowering it to 2 makes a hundred sessions fifty batches and the estimate says so. Raising it
to 1000 changes nothing, because the site's cap is still ten.

**It is read by the platform, not by the runner.** `@personavision/platform` computes the
number and hands it to the swarm, which holds whatever bound it is given. A run driven from the
command line does not go through the platform, so `personavision run` takes its bound from its
own `--concurrency` flag and this variable does not reach it.

## What a remote run needs that this does not provide

A Cloud Run task cannot write to the coordinator's disk, so a remote session's session file, its
run contributions and its video reach the run directory through the **object store of #316**,
which `PV_VIDEO_BUCKET` selects. That store is not in this build. Until it lands:

- `PV_RUNNER=cloud-run` with no `PV_VIDEO_BUCKET` is **refused before any execution is
  created**, with that reason;
- with one set, the coordinator creates executions and the task runs its session, writes it and
  then exits saying the upload is the object store's — which the coordinator reads as a failed
  execution and records as that session's typed automation failure. Nothing is lost silently and
  nothing is reported as collected that was not.

That is why the two are built in this order.
