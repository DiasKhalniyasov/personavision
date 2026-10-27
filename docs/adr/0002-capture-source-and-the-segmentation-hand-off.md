# 2. Captures come from a `CaptureSource`, and segmentation is a hand-off over its output

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

`packages/browser` is the only module in the project that drives a browser. Everything downstream — the attention engine, the swarm, the scoring and every screen — reads what it produces and nothing else. Two questions about its edges have to be answered before the rest of the browser-driving step is written in parallel, because nine tickets and three later steps are written against the answers.

**Where a capture comes from.** A run launched against a URL needs a real Chromium session. The engine's offline mode, the swarm's tests and this repository's own test suite need the same captures without a network and with byte-identical results on every run — and `pnpm test` is specified to make no network call and read no credential.

**Where segmentation goes.** The DOM explains buttons, links, headings and form fields. It does not explain a hero image, a product card or a banner: `fixture.css` has two regions that exist precisely because the DOM cannot say what they are. A SAM-based segmenter is planned to fill them, in a later step, and `run.json`'s `aoiSource` already admits a third value — `sam` — alongside `dom` and `a11y`. If that arrival changes this module's interface, every consumer written in the meantime changes with it.

## Decision

**One interface, two implementations.** Captures are obtained through `CaptureSource`:

```ts
interface CaptureSource {
  openSession(variant: { id: string; url: string }, device: Device): Promise<PageHandle>;
  capture(page: PageHandle, ctx: CaptureContext): Promise<Capture>;
  act(page: PageHandle, action: Action, ctx: CaptureContext): Promise<ActResult>;
  close(page: PageHandle): Promise<void>;
}
```

`createLiveSource()` drives Chromium; `createFixtureSource(dir)` replays committed captures from a directory. Fixture mode is the default in tests and in the engine's offline mode; the live source is used only when a run is launched against a URL. No consumer branches on which one it holds.

**`PageHandle` carries the Chromium objects.** `browser`, `context` and `page` are on the handle, not behind an adapter, because this step's page-operating seams — element extraction, screenshots, step detection, actions — each need the real page. A replaying source satisfies the shape over a blank page: one launch, no navigation, no network, nothing read from the page it holds.

**Segmentation is a hand-off over a finished capture, not a stage inside this module.** A segmenter is a function from a `Capture` to further areas of interest:

- **It receives** the screenshot's path as `run.json` records it (`screenshots/<variant>/<step>.png`), the geometry that image is in — `viewport`, `pageHeight`, `foldY` — and the elements this module already found, each with its `source` (`dom` or `a11y`), role, accessible name, text and page-space box.
- **It returns** further areas of interest in that same page space, each with `source: "sam"`, a box, and a label it derives itself; `isPrimaryAction` is `false` on every one of them, because the primary action is declared by the task and resolved against the DOM, never segmented out of pixels.
- **It never** re-opens the page, re-measures geometry, renames an element or changes one this module produced. Both sets are appended to `run.json`'s `aois`, where `source` is what tells them apart.

`CaptureElement['source']` stays `"dom" | "a11y"` — this module produces only what it can see in a page — while the artifact's `aoiSource` is the wider `"dom" | "a11y" | "sam"`. The projection in `src/run-projection.ts` is the one place the two meet.

## Alternatives considered

**A single live implementation, with tests against a real browser only.** Rejected: a screenshot is not deterministic across machines, so the engine's fixation sequences could not be asserted byte-for-byte, and every test in three downstream steps would need Chromium on disk. The repository's own promise — `pnpm test` reaches no network and needs no credential — would be gone.

**A fixture mode selected by an environment variable inside one implementation.** Rejected: the branch would be inside every function that touches a page, which is exactly where it cannot be tested. Two implementations of one interface means the live path has no `if` in it at all.

**Hiding Playwright behind an adapter interface on `PageHandle`.** Rejected for now: it would be an interface with one implementation, and the parallel tickets would each have to extend it before they could do their own work — the adapter would be written by committee and would still end up shaped like `Page`. The cost of this decision is that a replaying source launches a browser it does not use; that is one process, once per session, against friction in every ticket that drives a page.

**Segmentation as a stage inside `capture()`.** Rejected: it would put a model call on the path of every capture, which contradicts the engine's and this module's separation — the browser module reaches no model and holds no key — and it would make the capture cache depend on a model's output. As a hand-off, a run can be segmented after the fact, or not at all, and the cache stays a function of the page.

## Consequences

- The engine, the swarm and their tests are written against `CaptureSource` and never import a Playwright type.
- A committed capture directory is a complete substitute for a browser, so three later steps can be built and tested offline.
- The segmenter, when it arrives, is a new package that reads `Capture` and writes `source: "sam"` areas of interest. **`packages/browser`'s interface does not change when it does.**
- `aois` in `run.json` is the join point: a screen reading it treats a `sam` area exactly like a `dom` one, except that it has no selector.
- A capture is cached on `(variant URL, step, device, content hash)` — all four properties of the page, none of a model — so segmentation can never invalidate a screenshot.
- **Amended by #52, which cost nothing to give up.** The fixture source turned out to need no blank page either: it imports no `playwright` value, and the `browser`, `context` and `page` on a replayed handle are stand-ins that throw, naming the source, if a seam reads one. So fixture mode launches no process and opens no socket — asserted with both broken in `packages/browser/test/fixture-source.test.ts` — and the one process per session this decision accepted is not spent. `PageHandle` is unchanged, and the live path still has no `if` in it.
