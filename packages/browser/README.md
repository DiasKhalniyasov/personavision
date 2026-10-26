# `@personavision/browser`

Browser driving over Playwright: it opens a variant's URL in Chromium under an emulated
device, measures the page, captures each screen of the task with the fold line, extracts the
elements a session can look at, and executes the actions an agent decides — reporting every
failure of its own as a typed automation failure rather than as a failure of the product.

Vocabulary is `docs/FLOW.md` section 8's: area of interest, fixation, fold, step, variant,
automation failure. The shapes it writes are `@personavision/contract`'s; no artifact field
name is restated here.

## One command before the tests run

Playwright's browser download is the only install-time network dependency in this
repository, and it is deliberately not a `postinstall`: `pnpm install` never reaches for a
browser, so the workspace installs the same way with or without one.

```sh
pnpm --filter @personavision/browser exec playwright install chromium
```

A fresh clone runs that once. CI runs it too, with `~/.cache/ms-playwright` cached on the
installed Playwright version, so a green pipeline downloads a browser only when that version
moves.

Without it, this package's two browser suites **skip** rather than fail — a developer working
on another package is not made to download 150 MB to run `pnpm test`. In CI they do not skip:
there a missing browser is a broken workflow and has to be loud.

## The fold, and the space everything is in

Every box this module produces is in **page space** and in CSS pixels: the origin is the
document's, not the viewport's, and a screenshot is the whole page. `foldY` is the viewport's
bottom edge in page space **at scroll 0** — the line every screenshot in this project is
drawn with — so it does not move when a session scrolls, and an element is below the fold
when `y >= foldY`. A control below it is a finding waiting to happen.

The viewport is read as the page's `innerWidth`/`innerHeight`, which include the scrollbar
gutter and so are the emulated device's viewport exactly. `documentElement.clientWidth` would
be narrower by a scrollbar and would make a box's `x` disagree with the image it is drawn on.

## The published surface

`src/index.ts` is the whole of it, and nine tickets of the browser-driving step fill one
function each behind it without changing a name.

| Export                               | What it does                                                         |
| ------------------------------------ | -------------------------------------------------------------------- |
| `openSession` `closeSession`         | Launch Chromium with the device applied; close it                    |
| `readSessionState`                   | What the page says about its viewport, pixel ratio, touch and scroll |
| `readGeometry` `isBelowFold`         | The viewport, the page height and the fold; the fold rule            |
| `capture`                            | One captured screen, composed from everything below                  |
| `captureCacheKey` `readContentHash`  | The cache key, and the hash of what the page currently is            |
| `extractElements` `stableElementId`  | The candidate elements, and the id that is the same every session    |
| `writeScreenshot`                    | The full-page image, into the run directory                          |
| `toScreenshotEntries` `toAoiEntries` | Captures, projected into `run.json`                                  |
| `detectStep` `resolvePrimaryAction`  | Which step the page is on, and the control that advances it          |
| `act`                                | Click, scroll, type, back — and what the page became                 |
| `SessionBudget`                      | The per-session cap on retries and wall-clock time                   |
| `mapToAutomationFailure`             | A thrown error, read as one of our four reasons                      |
| `withCache`                          | Capture caching, keyed on content                                    |
| `createLiveSource` `walkTask`        | The `CaptureSource` over Chromium, and the walk above it             |
| `createFixtureSource`                | The `CaptureSource` that replays captures from disk                  |

### Which of them are neutral

A seam that has not landed yet **exists, is exported and is typed**, and returns an empty or
pass-through result instead of pretending to work — so a partly filled module still builds,
tests and captures.

| Seam                                     | Until its ticket lands        |
| ---------------------------------------- | ----------------------------- |
| `extractElements`                        | no elements                   |
| `writeScreenshot`                        | `null`, writes nothing        |
| `toScreenshotEntries` `toAoiEntries`     | no rows                       |
| `detectStep`                             | `null`                        |
| `resolvePrimaryAction`                   | the elements, unchanged       |
| `act`                                    | throws `act: not implemented` |
| `SessionBudget`                          | runs the work once, no caps   |
| `mapToAutomationFailure`                 | `null`; the caller rethrows   |
| `withCache`                              | always a miss                 |
| `createFixtureSource` `createLiveSource` | throw                         |

A capture with only these in place is real geometry and a real content hash, a `null`
screenshot, a `null` step and no elements — and it does not throw.

## `capture()` is composed once

`readGeometry` and `readContentHash` first, because the cache key is built from them; then
`detectStep`, because the step is part of that key and is the name a screenshot is written
under; then, inside `withCache`, the work that produces bytes — `writeScreenshot`,
`extractElements`, `resolvePrimaryAction`. All of it under the session's `SessionBudget`, so a
page that will not answer cannot hold a swarm of twenty-four sessions up.

That composition lives in `src/capture.ts` and **no later ticket of the step edits it**. One
that finds it has to says so on its own issue rather than quietly widening its reach.

## Two seams outlive this step

`CaptureSource` — Chromium over a URL, or committed captures replayed from disk — and the
hand-off for regions the DOM cannot explain, so that a SAM-based segmenter can add
`source: "sam"` areas of interest without this module's interface changing.
`docs/adr/0002-capture-source-and-the-segmentation-hand-off.md` records both.

## Tests

Two suites, both driving the public entry point against the static fixture site in
`test/fixtures/site/` (`test/helpers/static-site.ts` serves it from disk, with no dependency
of its own):

- `test/geometry.test.ts` — the viewport, the page height and the fold at a mobile and a
  desktop device, against the heights `test/fixtures/site/LANDMARKS.md` states.
- `test/session.test.ts` — that device emulation is real, read back out of the page; that a
  capture carries its variant, geometry and content hash; and that every neutral seam
  behaves as the table above says.

No test asserts a Playwright internal. `test/fixture-site.test.ts` holds the fixture site to
its own record and needs no browser at all.
