# CONTEXT — PersonaVision

PersonaVision is a **hosted web platform** for the person who decides which change ships — the owner or CEO of a website or app, not a designer or front-end engineer. They sign in, describe **the audience their business serves**, and point it at two versions of a page. A swarm of simulated people, _generated from that audience_, works through both, and the product answers in one sentence: which version their audience completes, and the one or two reasons why. Everything else — heatmaps, the friction score, the per-area numbers, individual replays — is one click deeper.

A run is still a **directory on disk**, not a database row. Everything else in this repository either writes that directory or reads it. The platform decides _who may read_ which run directory; it does not reshape the artifact, and **no account id, workspace id or credential is ever written into a run artifact**.

The user-facing word for a run is a **test**, and an **audience** is the first-class object personas are generated from. Both are fixed by `docs/FLOW.md` sections 1 and 8.

## Vocabulary

The product's vocabulary — fixation, saccade, dwell, area of interest, time to first fixation, revisit, scanpath, heatmap, persona, seed, session, variant, friction score, finding, attribution, simulated, and the distinction between _abandoned_, _failed_ and _automation failure_ — is fixed by **`docs/FLOW.md` section 8, "What this contract fixes for the workers"**.

It is not restated here. Read it there, and use those words in code, tests, issues and UI copy. Severity, outcome, attribution and score-band names come from the `--sev-*`, `--outcome-*`, `--attr-*` and `--score-*` tokens in `docs/design/tokens.css`.

Three words the owner's direction of **2026-11-03** adds, fixed by `docs/FLOW.md` section 13 and written down here
because section 8 predates them:

- A **site** is a URL that belongs to a workspace. It is what a test runs against and what the per-site caps are
  counted against. A site is listed, read and removed only through the workspace that holds it, and a site of another
  workspace answers **404 and not 403** — that somebody else holds that URL is not disclosed. The same URL added by two
  workspaces is two sites. Removing one is a soft delete, so the site a finished test ran against stays readable.
- A site's **verification token** is a short public string — `pv_` and hex — minted by the platform, one per site. It is
  a **proof of control, not a secret**: the user publishes it themselves as a DNS record, a meta tag or a file, and the
  platform answers it over the API and prints it on screen with the line to copy. Nothing hashes it, redacts it or
  handles it as a credential. Two workspaces that add the same URL get two tokens, so one workspace's published token
  is never another's proof.
- A site's **verification state** is `unverified` or `verified`, with the method that proved it and the moment it was
  proved. **Only a check the platform ran itself may move it** — never a submitted field, and never a box a user ticks.
  It **gates nothing about testing**: the owner's answer of 2026-11-03 settled decision 71 as _no gate on testing_, so an
  unverified site runs under exactly the same caps as a verified one. A run records what was true of its site at launch
  (`site.verifiedAtLaunch`) and no cap reads it. What verification unlocks is **Improve my site**.
- A site's **launch ledger** is every run started against it — the run id and when — trimmed to the last 24 hours on
  write. The runs-per-site-per-hour cap counts the trailing hour off it, so the cap is a ledger rather than a counter
  nothing resets. Starting a test is the only thing that writes it, and writing it cannot move the verification state.
- The **caps** are three numbers in one module, `packages/platform/src/caps.ts`, and nothing else in the repository
  defines them: **100** agents a run (the audience's `size`, capped), **10** concurrent sessions per site, **4** runs per
  site per hour. They protect the site being driven rather than the person who asked, so the verification state does not
  enter them and the offline engine is bound by them exactly as a model run is. A launch a cap refuses is a
  `CapRefusedError` carrying the cap, its limit, the observed value and when it next passes — answered as **429** with
  those as fields beside one sentence, so the screen, the API and the CLI say the same thing. A screen states a cap by
  asking the API for the number; a screen that prints a different one is wrong rather than a cap that moved.

## Module map

| Package                      | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@personavision/contract`    | The run artifact: zod schemas, the types inferred from them, the run-directory reader and writer, and `validate`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `@personavision/cli`         | The `personavision` binary. `serve` starts the platform; `run`, `validate` and `open` are **internal tools**, with the read-only run-data mount.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@personavision/engine`      | Drives a persona through a variant and emits a session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@personavision/browser`     | Browser driving, page screenshots with the fold drawn, area-of-interest extraction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `@personavision/scoring`     | The friction score, its component weights, the per-seed-group spread and the verdict.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `@personavision/personas`    | The seeded persona **generator**: an audience in, people out. Trait sampling and the device mix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@personavision/calibration` | Scores the engine against the UEyes benchmark and fits its configuration. The only place a human-likeness figure is produced. Added by step #11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@personavision/viewer`      | `apps/viewer` — the platform's web app. Added by its own ticket.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@personavision/platform`    | Accounts, sign-in sessions, workspaces, audience and site storage, and `personavision serve`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `@personavision/provider`    | The model layer: **two interfaces side by side** — `DecisionProvider`, session-scoped (an agent, a screen, a decision), and `WonderProvider`, one-shot (a document in, a typed object out, no session and no screen). Each has an offline deterministic implementation that is the default and a contract suite in `@personavision/provider/testing`; the decision interface has its model implementation behind it, and the one-shot interface gets its own in #255. Added by step #8 (#33); the one-shot seam by step #219 (#251), and `docs/adr/0003-the-one-shot-wonder-seam.md` records why it is not an extension of the first. |
| `@personavision/improve`     | Path 2's closed loop: the one GitHub client, the change, its pull request, the preview URL and the comment. Added by step #227 (#297).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

The owner's direction of **2026-11-03** (`docs/FLOW.md` sections 11 to 17) adds two product paths, a real onboarding
and a results page for 100-agent runs. It adds **one** package, `@personavision/improve` — path 2's closed loop: the
GitHub App client, the change Muse Wonder decides, the pull request it opens, the preview URL it is tested on and the
comment it posts back. It depends on `@personavision/contract`, `@personavision/provider` and `@personavision/scoring`,
and nothing depends on it. The step that owns path 2 is the only one permitted to add it to `pnpm-workspace.yaml`.
Everything else that direction needs is filled into packages that already exist: the sites, their ownership
verification and the per-site caps in `@personavision/platform`; CloakBrowser and session video in
`@personavision/browser`, behind the interface it already publishes; Muse Wonder in `@personavision/provider`; the
aggregate and the recommendations in `@personavision/scoring`; the new screens in `apps/viewer`.

The binary is `personavision`. The library packages above exist as buildable placeholders from the first commit, so a step fills one rather than creating it, and no step edits `pnpm-workspace.yaml` — `packages/*` already covers a new one. Three packages are the exceptions, each created by the one step that needs it: `@personavision/calibration` (step #11, because nothing before it needed a home for the human-likeness figure; it depends on `@personavision/contract` and may depend on `@personavision/engine`, and nothing depends on it), `@personavision/platform` (the hosted-platform step, which arrived with the owner's direction change) and `@personavision/provider` (#33, which is where step #8 decided the decision layer lives rather than inside `personas`; it depends on `@personavision/contract` only).

## `packages/contract` is the only place the artifact is declared

**No package other than `@personavision/contract` declares an artifact field name or a run-directory path.** Not a constant, not a string literal, not a re-derived path. Readers and writers import the schemas and the inferred types, so a field name is read from the compiler rather than from prose, and a round trip through disk is type-checked at both ends.

The layout it declares: `runs/<YYYY-MM-DD-HHMM-name>/` containing `run.json`, `findings.json`, `recommendations.json`, `sessions/S-01.json … S-NN.json`, `screenshots/<variant>/<step>.png`, and `videos/S-NN.webm`. Every artifact file carries `schemaVersion`, and a file written for another version is named as such rather than read as this one. `recommendations.json` is **optional**: a run directory without it produced no recommendation, which is not a zero somebody measured.

A session's **video** is optional by the same rule. `videos/S-NN.webm` is the recording of session `S-NN` — WebM, 720p, capped at 30 seconds a screen and 10 minutes a session — and the session's own JSON carries the block that names it: the run-directory-relative path, the duration, the cap it hit if it hit one, and the millisecond offset of **each screen and each action** into the recording, positionally aligned with the session's own `screens` and `actions` and length-checked, so a recommendation citing `S-62 · 0:48` resolves without replaying anything. A session recorded before session video existed carries no block, and a recording that could not be made is recorded as **absent with its reason in words** — the session is otherwise complete and still scored, because a broken recording does not lose a person's whole attempt. The path is spelt by the paths module (`runPaths(dir).videosDir`, `runPaths(dir).video(sessionId)`) and re-derived nowhere.

`run.json` carries the **audience** the test was run for — by value, copied when the test started, so that editing the stored audience later cannot restate a finished test. The personas it lists are generated from that audience and carry `audienceId` and a `segment`; `scores[].completionRate` and the verdict's `preferredVariant`, `audienceSentence`, `reasons`, `headlineFindingIds` and `heroEvidence` are what the Verdict screen leads with, stored rather than computed in a browser.

**Every object in the artifact is closed.** A field the schemas do not declare is rejected at its own JSON path rather than quietly dropped, which is how the artifact stays portable: an account id, a workspace id, an email, a password or a token has nowhere to hide.

A step that needs a new field adds it in that package and says so on the contract step's issue. It never writes a sibling file.

## Two interfaces this repository publishes to every other step

### 1. The viewer reads run data over HTTP as static files

The run directory is served read-only, mirroring the on-disk layout exactly:

- `GET /runs/<runId>/run.json`
- `GET /runs/<runId>/findings.json`
- `GET /runs/<runId>/recommendations.json` (when the run has one)
- `GET /runs/<runId>/sessions/S-NN.json`
- `GET /runs/<runId>/screenshots/<variant>/<step>.png`
- `GET /runs/<runId>/videos/S-NN.webm` (when the session recorded one), which also answers a `Range: bytes=…` request with that slice

plus **one generated listing**:

- `GET /runs/index.json` → `[{ runId, name, createdAt }]`, sorted newest first.

There is no other endpoint and no server-side computation. **The mount computes nothing for a video either**: a `.webm` is the bytes that are on disk, served as a screenshot is — no transcoding, no thumbnail, no duration read on the server. What a player needs to seek it, the viewer gets from the session JSON's offsets, and a session that recorded none has no file to serve. What it does serve is **byte ranges**, on every file it streams: a `Range: bytes=…` request is answered `206` with its `content-range`, an unsatisfiable one `416`, and `accept-ranges: bytes` is declared on the whole file too — so a `?t=` deep link seeks to its frame instead of downloading the whole recording to reach it, which is the difference between a grid of a hundred tiles and a hundred downloads. A range is an offset into the same read, not a computation. A recording that was never made is the mount's own **404**, never an empty body: a video that is absent and one that is zero bytes long must not look the same to a client. The mount is implemented once in `packages/cli`, used by `personavision serve` and `personavision open` and wired into the viewer's Vite dev server, so a developer running `pnpm dev` reads the identical URLs the shipped app does. `serve` additionally scopes the mount to the workspace that owns the run — a signed-out request reaches only the seeded demo run, which the public landing page and `/demo` read, and a run of another workspace is 404 rather than 403; the paths themselves do not change. That the run data reaches the viewer as read-only files at all, rather than through an API that could grow a calculation, is recorded in [`docs/adr/0001-run-data-over-http-as-static-files.md`](docs/adr/0001-run-data-over-http-as-static-files.md); what that mount has come to serve — the optional files, the videos, the ranges, the scoping — is stated here, and the ADR records the decision rather than the inventory.

### 2. `docs/design/tokens.css` is imported by the app, never copied and never restated

`apps/viewer`'s entry imports `docs/design/tokens.css` directly. The app restates no colour, size or spacing value, and the band thresholds — `--score-threshold-good`, `--score-threshold-bad`, `--completion-threshold-good` and `--completion-threshold-bad` — are read from CSS at runtime rather than hard-coded.

This makes `docs/design/` a build input for `apps/viewer`: a token change moves the product without touching the app, and the app cannot be extracted from this repository without it.

## Properties the repository holds itself to

- A fresh clone installs, type-checks, lints, tests and builds with **no API key and no network access during the test run**.
- The platform is **self-hosted and offline-capable by default**: `personavision serve` with a file-backed store and a seeded demo workspace, so the whole product runs with no cloud account and no managed database. Deploying it to a managed host is its own ticket and needs the owner.
- **Credential reads are a named list, and a short one.** `packages/provider/src/select.ts` reads the model API key from the environment at call time and hands it to the model provider's factory; `packages/provider/src/meta-model.ts` and `packages/provider/src/wonder-model.ts` read the same variable at the moment of a call — the decision provider and the one-shot one — because the key a run was selected with and the key a call is made with have to be the same one, and their live tests read it only to decide whether to run at all (#43, #255). In none of them is it written to a file, a run artifact, a log line or an error. `tests/workspace.test.ts` scans every other tracked and untracked source file for an environment read that names a key, token, secret, password or credential, and for a CI secret reference, fails the build on either, and holds each exception to still being a real read, so the carve-out cannot rot.
- Node 22, pinned in `.nvmrc` and in `engines`. pnpm is the only package manager; its lockfile is committed.
- The root Vitest configuration already picks up a root-level `tests/` directory, and a suite that needs a DOM declares it per file rather than editing the configuration.
