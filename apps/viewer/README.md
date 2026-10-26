# @personavision/viewer

The design tokens are **imported** from `docs/design/tokens.css` by `src/main.tsx` and must never be copied into this app: a colour, a size, a spacing step and the score-band thresholds live in that file alone, and `src/tokens.ts` reads a threshold from the cascade rather than restating it.

The chrome, the router and the screens are **not** owned here: the app shell, the route table and the Comparison screen belong to step #3, the Attention screen to step #4, and the Sessions and Replay screens to step #5 — this package is the document shell and a neutral boot placeholder only.

## Running it

From the repository root: `pnpm dev` serves it on localhost, `pnpm build` builds it into `apps/viewer/dist`, and `pnpm test` runs its tests. Nothing is fetched from a network at build time or at run time.

## For the screen steps

- `src/tokens.ts` — `readScoreThreshold('good' | 'bad')` and `scoreBand(score)`. Use them instead of a number of your own.
- Tests: a suite that needs a DOM opens with `// @vitest-environment jsdom` and imports `./setup` from `tests/`, as the root Vitest configuration asks. jsdom and Testing Library are already dependencies here.
- Run data arrives over HTTP as static files under `/runs/`; the mount is `packages/cli`'s and is wired into this app's dev server by the CLI step. See `docs/adr/0001-run-data-over-http-as-static-files.md`.
