# CONTEXT — PersonaVision

PersonaVision is a **hosted web platform** for the person who decides which change ships — the owner or CEO of a website or app, not a designer or front-end engineer. They sign in, describe **the audience their business serves**, and point it at two versions of a page. A swarm of simulated people, _generated from that audience_, works through both, and the product answers in one sentence: which version their audience completes, and the one or two reasons why. Everything else — heatmaps, the friction score, the per-area numbers, individual replays — is one click deeper.

A run is still a **directory on disk**, not a database row. Everything else in this repository either writes that directory or reads it. The platform decides _who may read_ which run directory; it does not reshape the artifact, and **no account id, workspace id or credential is ever written into a run artifact**.

The user-facing word for a run is a **test**, and an **audience** is the first-class object personas are generated from. Both are fixed by `docs/FLOW.md` sections 1 and 8.

## Vocabulary

The product's vocabulary — fixation, saccade, dwell, area of interest, time to first fixation, revisit, scanpath, heatmap, persona, seed, session, variant, friction score, finding, attribution, simulated, and the distinction between _abandoned_, _failed_ and _automation failure_ — is fixed by **`docs/FLOW.md` section 8, "What this contract fixes for the workers"**.

It is not restated here. Read it there, and use those words in code, tests, issues and UI copy. Severity, outcome, attribution and score-band names come from the `--sev-*`, `--outcome-*`, `--attr-*` and `--score-*` tokens in `docs/design/tokens.css`.

## Module map

| Package                      | Owns                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@personavision/contract`    | The run artifact: zod schemas, the types inferred from them, the run-directory reader and writer, and `validate`.                                |
| `@personavision/cli`         | The `personavision` binary. `serve` starts the platform; `run`, `validate` and `open` are **internal tools**, with the read-only run-data mount. |
| `@personavision/engine`      | Drives a persona through a variant and emits a session.                                                                                          |
| `@personavision/browser`     | Browser driving, page screenshots with the fold drawn, area-of-interest extraction.                                                              |
| `@personavision/scoring`     | The friction score, its component weights, the per-seed-group spread and the verdict.                                                            |
| `@personavision/personas`    | The audience schema, the seeded persona **generator**, trait sampling and the device mix.                                                        |
| `@personavision/calibration` | Scores the engine against the UEyes benchmark and fits its configuration. The only place a human-likeness figure is produced. Added by step #11. |
| `@personavision/viewer`      | `apps/viewer` — the platform's web app. Added by its own ticket.                                                                                 |
| `@personavision/platform`    | Accounts, sign-in sessions, workspaces, audience storage and `personavision serve`.                                                              |
| `@personavision/provider`    | The decision layer: the `DecisionProvider` interface, the offline deterministic policy and the provider-contract suite. Added by step #8 (#33).  |

The binary is `personavision`. The library packages above exist as buildable placeholders from the first commit, so a step fills one rather than creating it, and no step edits `pnpm-workspace.yaml` — `packages/*` already covers a new one. Three packages are the exceptions, each created by the one step that needs it: `@personavision/calibration` (step #11, because nothing before it needed a home for the human-likeness figure; it depends on `@personavision/contract` and may depend on `@personavision/engine`, and nothing depends on it), `@personavision/platform` (the hosted-platform step, which arrived with the owner's direction change) and `@personavision/provider` (#33, which is where step #8 decided the decision layer lives rather than inside `personas`; it depends on `@personavision/contract` only).

## `packages/contract` is the only place the artifact is declared

**No package other than `@personavision/contract` declares an artifact field name or a run-directory path.** Not a constant, not a string literal, not a re-derived path. Readers and writers import the schemas and the inferred types, so a field name is read from the compiler rather than from prose, and a round trip through disk is type-checked at both ends.

The layout it declares: `runs/<YYYY-MM-DD-HHMM-name>/` containing `run.json`, `findings.json`, `sessions/S-01.json … S-NN.json`, and `screenshots/<variant>/<step>.png`. Every artifact file carries `schemaVersion`, and a file written for another version is named as such rather than read as this one.

`run.json` carries the **audience** the test was run for — by value, copied when the test started, so that editing the stored audience later cannot restate a finished test. The personas it lists are generated from that audience and carry `audienceId` and a `segment`; `scores[].completionRate` and the verdict's `preferredVariant`, `audienceSentence`, `reasons`, `headlineFindingIds` and `heroEvidence` are what the Verdict screen leads with, stored rather than computed in a browser.

**Every object in the artifact is closed.** A field the schemas do not declare is rejected at its own JSON path rather than quietly dropped, which is how the artifact stays portable: an account id, a workspace id, an email, a password or a token has nowhere to hide.

A step that needs a new field adds it in that package and says so on the contract step's issue. It never writes a sibling file.

## Two interfaces this repository publishes to every other step

### 1. The viewer reads run data over HTTP as static files

The run directory is served read-only, mirroring the on-disk layout exactly:

- `GET /runs/<runId>/run.json`
- `GET /runs/<runId>/findings.json`
- `GET /runs/<runId>/sessions/S-NN.json`
- `GET /runs/<runId>/screenshots/<variant>/<step>.png`

plus **one generated listing**:

- `GET /runs/index.json` → `[{ runId, name, createdAt }]`, sorted newest first.

There is no other endpoint and no server-side computation. The mount is implemented once in `packages/cli`, used by `personavision serve` and `personavision open` and wired into the viewer's Vite dev server, so a developer running `pnpm dev` reads the identical URLs the shipped app does. `serve` additionally requires a signed-in session and scopes the mount to the workspace that owns the run; the paths themselves do not change. Recorded in [`docs/adr/0001-run-data-over-http-as-static-files.md`](docs/adr/0001-run-data-over-http-as-static-files.md).

### 2. `docs/design/tokens.css` is imported by the app, never copied and never restated

`apps/viewer`'s entry imports `docs/design/tokens.css` directly. The app restates no colour, size or spacing value, and the band thresholds — `--score-threshold-good`, `--score-threshold-bad`, `--completion-threshold-good` and `--completion-threshold-bad` — are read from CSS at runtime rather than hard-coded.

This makes `docs/design/` a build input for `apps/viewer`: a token change moves the product without touching the app, and the app cannot be extracted from this repository without it.

## Properties the repository holds itself to

- A fresh clone installs, type-checks, lints, tests and builds with **no API key and no network access during the test run**.
- The platform is **self-hosted and offline-capable by default**: `personavision serve` with a file-backed store and a seeded demo workspace, so the whole product runs with no cloud account and no managed database. Deploying it to a managed host is its own ticket and needs the owner.
- **No script reads a credential.** `tests/workspace.test.ts` scans every tracked and untracked source file for an environment read that names a key, token, secret, password or credential, and for a CI secret reference, and fails the build on either.
- Node 22, pinned in `.nvmrc` and in `engines`. pnpm is the only package manager; its lockfile is committed.
- The root Vitest configuration already picks up a root-level `tests/` directory, and a suite that needs a DOM declares it per file rather than editing the configuration.
