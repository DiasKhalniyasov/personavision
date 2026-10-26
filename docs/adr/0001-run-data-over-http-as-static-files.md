# 1. Run data reaches the viewer over HTTP as static files

- **Status:** Accepted
- **Date:** 2026-10-26

## Context

A run is a directory on disk: `runs/<YYYY-MM-DD-HHMM-name>/` with `run.json`, `findings.json`, `sessions/S-NN.json` and `screenshots/<variant>/<step>.png`. The project has already ruled out a database, auth, a job queue, server-side users and cloud storage. The local web app still has to get that data into a browser, and nine parallel workstreams need to know how before any screen is written.

Three further constraints bear on it:

- The viewer's specification says it **formats and never calculates**. Anything that computes is in the pipeline, not in front of it.
- `./runs/` changes without a rebuild: a developer runs the CLI, a new directory appears, and the app must see it.
- A screen worker running `pnpm dev` must read the same URLs the shipped app reads, or the screens get built against a fiction.

## Decision

The run directory is served **read-only over HTTP as static files, mirroring the on-disk layout exactly**:

- `GET /runs/<runId>/run.json`
- `GET /runs/<runId>/findings.json`
- `GET /runs/<runId>/sessions/S-NN.json`
- `GET /runs/<runId>/screenshots/<variant>/<step>.png`

plus exactly **one generated listing**, because a directory is not enumerable over HTTP:

- `GET /runs/index.json` → `[{ runId, name, createdAt }]`, sorted newest first.

There is no other endpoint and no server-side computation. The mount is implemented once in `packages/cli`, used by `personavision open` and wired into the viewer's Vite dev server.

## Alternatives considered

**A small JSON API over the run directory.** Rejected: an API is a place to put computation, and the moment one exists the temptation is to let the server aggregate sessions or recompute a score. The viewer is specified to format and never calculate, and a read-only file mount is the only shape that cannot drift into doing otherwise. It also would have meant two implementations of every path — one in the server's routes, one in the contract.

**Bundling the runs into the app at build time.** Rejected: `./runs/` changes without a rebuild. A bundled app would freeze whichever runs existed when it was built — including freezing the seed example run into the shipped bundle — and `personavision run` followed by a page refresh would show nothing new. It also puts screenshots through the bundler for no gain.

**Reading the files from the browser's filesystem APIs.** Rejected: it needs a user gesture to grant access to a directory, once per run, which breaks the one-command demo that the CLI exists to give.

## Why reading files won

The run directory is already the interface. Serving it verbatim means the layout is the only index: a new artifact file is reachable the moment it is written, with no server change and no second declaration of its path. The server can answer exactly the questions the CLI could answer by reading a file and no others — which is the property the whole no-database decision rests on, and the reason a screen can never quietly become dependent on a server that computes.

## Consequences

- Every screen step fetches run data at those URLs and nothing else.
- `packages/contract` stays the only declaration of the paths; the mount derives its URLs from it.
- The listing at `/runs/index.json` is the one generated resource, and the one thing to keep in step with the directory.
- A run directory copied onto any static file host is a working deployment.
