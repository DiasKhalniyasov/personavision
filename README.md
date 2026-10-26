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

## Two commands that do not work yet

`personavision open` starts the local web app and opens the most recent run under `./runs/`. **It arrives in a later ticket of this step** ("Run artifact contract and app skeleton"); until then `pnpm open` exits non-zero and says so. `pnpm seed:example-run` behaves the same way until the seed-example-run ticket lands. Both root scripts already point at the files those tickets write, so neither ticket touches the workspace manifest, the lockfile or the tool configuration.

`pnpm dev` runs the dev server of every app that declares one. There is no app yet — `apps/viewer` arrives in its own ticket — so today it does nothing and exits cleanly.

## Where to read next

- **`CONTEXT.md`** — the module map, the one place artifact field names are declared, and the two interfaces this repository publishes to every other step.
- **`docs/FLOW.md`** — the flow contract. Section 8 is the product's vocabulary; nothing restates it.
- **`docs/design/prototype.html`** and **`docs/design/tokens.css`** — the visual contract. The app imports the tokens; it never copies them.
- **`docs/adr/`** — the decisions, with the alternatives that were rejected.
