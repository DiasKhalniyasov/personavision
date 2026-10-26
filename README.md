# personavision

A swarm of simulated users that produces Tobii-style eye tracking for websites: pre-test UI changes before a real A/B test.

## What a new developer runs, in order

Node 22 and pnpm. `.nvmrc` pins the Node version, `package.json` pins the pnpm version, and pnpm is the only package manager — its lockfile is committed and no npm or yarn lockfile exists.

```sh
nvm use            # or any Node 22; the version is pinned in .nvmrc
corepack enable    # pnpm, at the version package.json pins
pnpm install       # no API key, no account, nothing to provision
pnpm typecheck
pnpm lint
pnpm test          # makes no network call and reads no credential
pnpm build
```

A fresh clone passes all four checks. A package's public entry point is its built output, so `pnpm typecheck` builds first; `pnpm test` does not need to, because Vitest reads each package's source through a `development` export condition and so never tests a stale build. CI runs the same four on Node 22 with a frozen lockfile.

## Every root script

| Script                  | What it does                                                             |
| ----------------------- | ------------------------------------------------------------------------ |
| `pnpm typecheck`        | Builds every package, then type-checks the root `tests/` and `scripts/`. |
| `pnpm lint`             | ESLint with typescript-eslint over the whole workspace.                  |
| `pnpm format`           | Prettier, writing in place. `pnpm format:check` only reports.            |
| `pnpm test`             | Vitest once, over `tests/` and every package's own tests.                |
| `pnpm build`            | `tsc` per package, into each package's `dist/`.                          |
| `pnpm dev`              | Starts the dev server of every app that has one.                         |
| `pnpm seed:example-run` | Generates the committed seed example run under `runs/`.                  |
| `pnpm open`             | `personavision open` — the local web app on the most recent run.         |

## The command line

`personavision` is this repository's command line. **`personavision serve` is the product's entry point**: it starts the hosted platform, with sign-in and workspace scoping, and arrives in the hosted-platform step. The three commands below are **internal tools** — how the team regenerates fixtures, checks an artifact in CI and debugs one by eye. None of them signs anybody in or scopes anything to a workspace, so none of them is how a customer uses PersonaVision.

| Command                              | What it is for                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `personavision validate <runDir>`    | Every schema violation in a run directory, each at the JSON path of the offending value. Exits non-zero if there is one, zero if there is none — which is what CI and a fixture regeneration check against.                                                                                                              |
| `personavision run --url … --task …` | The arguments the New test form submits, parsed into the `RunRequest` the contract declares, and rejected the way the form rejects them. The decision engine is a later step, so a valid request exits non-zero naming that step and writes no run directory.                                                            |
| `personavision open`                 | The viewer and `./runs` on localhost, opened in a browser at `/` — which the app resolves to the most recent test: for a developer debugging an artifact. It builds the viewer when `apps/viewer/dist` is missing — `--no-build` fails instead — and `--no-open` starts the server without a browser, `--port` moves it. |

`personavision open --help`, and each subcommand's `--help`, names its flags.

All three serve or read the one run-data interface `CONTEXT.md` publishes: `GET /runs/index.json` and the run's own files, read-only, mirroring the directory. That mount is implemented once in `packages/cli`, exported, and mounted by `personavision serve`, by `personavision open` and by `apps/viewer`'s dev server — so `pnpm dev` reads the identical URLs the shipped app does.

`pnpm dev` runs the dev server of every app that declares one, which today is `apps/viewer`.

## Where to read next

- **`CONTEXT.md`** — the module map, the one place artifact field names are declared, and the two interfaces this repository publishes to every other step.
- **`docs/FLOW.md`** — the flow contract. Section 8 is the product's vocabulary; nothing restates it.
- **`docs/design/prototype.html`** and **`docs/design/tokens.css`** — the visual contract. The app imports the tokens; it never copies them.
- **`docs/adr/`** — the decisions, with the alternatives that were rejected.
