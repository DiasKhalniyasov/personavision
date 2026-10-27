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

Without it, the assertions that need a browser **skip** rather than fail — a developer working
on another package is not made to download 150 MB to run `pnpm test`. The ones that need none —
the cache key, the budget, the projections, the failure mapping, the stable ids — still run. In
CI nothing skips: there a missing browser is a broken workflow and has to be loud.

## The fold, and the space everything is in

Every box this module produces is in **page space** and in CSS pixels: the origin is the
document's, not the viewport's, and a screenshot is the whole page. `foldY` is the viewport's
bottom edge in page space **at scroll 0** — the line every screenshot in this project is
drawn with — so it does not move when a session scrolls, and an element is below the fold
when `y >= foldY`. A control below it is a finding waiting to happen.

The viewport is read as the page's `innerWidth`/`innerHeight`, which include the scrollbar
gutter and so are the emulated device's viewport exactly. `documentElement.clientWidth` would
be narrower by a scrollbar and would make a box's `x` disagree with the image it is drawn on.

## Two sources for one page

`extractElements` reads a page twice. The **DOM** pass reads what the markup says: the role a
tag implies, and the text an element holds itself. The **accessibility** pass reads what
Chromium computed — the role and the accessible name a screen reader would announce, with
`aria-label`, `<label for>` and `alt` already resolved — over the DevTools protocol, because
an accessible name is the browser's answer and not a rule this module could restate. Roles are
reported in ARIA's spelling whichever pass found them.

The two disagree, and the disagreement is the point: a button that reads `Save` and is named
`Save the canvas tote for later` is one control and two candidates, told apart by `source`.
Neither is dropped, and no element is reported twice from one source.

An element's **id** is minted from the variant, the step, the source, the role, the accessible
name and the element's position **in the document** — never from its box, which moves with the
viewport, and never from a hash of the page, which moves with any edit. That is what lets
area-of-interest metrics be aggregated over sessions that do not share a seed or a viewport.

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
| `toAutomationFailure`                | That reason, worded with what was being attempted                    |
| `navigationFailure` `frameFailure`   | The two failures of ours that nothing throws                         |
| `watchFrameFailures`                 | A page's frame failures, as they arrive                              |
| `toAutomationFailureOutcome`         | The session outcome a failure of ours produces                       |
| `withCache`                          | Capture caching, keyed on content                                    |
| `createLiveSource` `walkTask`        | The `CaptureSource` over Chromium, and the walk above it             |
| `createFixtureSource`                | The `CaptureSource` that replays captures from disk                  |

### Which of them are neutral

A seam that has not landed yet **exists, is exported and is typed**, and returns an empty or
pass-through result instead of pretending to work — so a partly filled module still builds,
tests and captures.

| Seam                                     | Until its ticket lands |
| ---------------------------------------- | ---------------------- |
| `createFixtureSource` `createLiveSource` | throw                  |

A capture with only these in place is real geometry, a real content hash, a real step label,
a written screenshot and the page's elements, one of them marked as the step's primary
action. A screen the task does not declare still has a `null` step and a `null` screenshot,
because an unrecognised screen has no name to write an image under. It raises one thing: a
page on one of the task's steps whose declared primary action cannot be resolved is an
`AutomationFailure` with reason `selector_not_found`, because a session with no primary
action to measure is excluded rather than scored as a zero.

## `capture()` is composed once

`readGeometry` and `readContentHash` first, because the cache key is built from them; then
`detectStep`, because the step is part of that key and is the name a screenshot is written
under; then, inside `withCache`, the work that produces bytes — `writeScreenshot`,
`extractElements`, `resolvePrimaryAction`. All of it under the session's `SessionBudget`, so a
page that will not answer cannot hold a swarm of twenty-four sessions up.

That composition lives in `src/capture.ts` and **no later ticket of the step edits it**. One
that finds it has to says so on its own issue rather than quietly widening its reach.

## The cache is a directory inside the run

`withCache` stores one entry per `(variant URL, step, device, content hash)` under
`.capture-cache/` in the run directory, so the cache travels with the run it belongs to and a
fresh run starts cold. A hit returns the whole capture the first session produced — its
geometry, its element ids and the path of the screenshot that session wrote — so twelve
sessions over one variant take one picture of each screen rather than twelve.

It is the one path inside a run directory the contract does not spell. `runPaths` declares what
a run **publishes**, over HTTP as well as on disk; this one is private to this module, dotted so
that nothing globbing a run mistakes it for artifact data, and read by `cache.ts` alone. Nothing
it does can fail a session either: a truncated entry, an entry belonging to another key and a
run directory that cannot be written to are each a miss.

## Two seams outlive this step

`CaptureSource` — Chromium over a URL, or committed captures replayed from disk — and the
hand-off for regions the DOM cannot explain, so that a SAM-based segmenter can add
`source: "sam"` areas of interest without this module's interface changing.
`docs/adr/0002-capture-source-and-the-segmentation-hand-off.md` records both.

## Tests

Every suite goes through the package's public entry point. Those that need a browser drive
Chromium against the static fixture site in `test/fixtures/site/` (`test/helpers/static-site.ts`
serves it from disk, with no dependency of its own):

- `test/geometry.test.ts` — the viewport, the page height and the fold at a mobile and a
  desktop device, against the heights `test/fixtures/site/LANDMARKS.md` states.
- `test/session.test.ts` — that device emulation is real, read back out of the page; that a
  capture carries its variant, geometry and content hash; and that every neutral seam
  behaves as the table above says.
- `test/steps.test.ts` — that a page is labelled by the task's URL pattern and required
  element and never by its words, and that the control a step declares resolves to exactly
  one extracted element or fails as ours.
- `test/screenshot.test.ts` — the written PNG, read back from the run directory: its path,
  that it covers the whole document at the device's pixels, and that one screen is one file.
- `test/act.test.ts` — what a click, a scroll, a text entry and a back navigation leave
  behind, read back out of the page: the URL it reports, where it is scrolled to, what the
  field holds, and which failures come back typed rather than thrown.
- `test/failures.test.ts` — the four automation failures, each driven out of a real browser:
  a selector the site has not, the never-answering `/slow` route, `/boom` and a vacated port,
  and `broken-frame.html`'s frame that never arrives. Each has to be produced **inside the cap
  its operation was given** rather than by hanging, and each outcome is parsed against the
  contract's session schema.
- `test/cache.test.ts` — that a second session over one screen is answered from the first
  session's capture and takes no second picture, that a changed page and a second device are
  not, and that a damaged entry or an unwritable run directory is a miss and never a failed
  session. The screenshot is deleted between two captures, because that is the one thing a hit
  and a miss leave differently on disk.
- `test/budget.test.ts` — the retry and wall-clock caps and the integrity counters. No browser.
- `test/run-projection.test.ts` — the two `run.json` arrays, placed into the committed
  example run and parsed by `@personavision/contract`, and that a screen a dozen sessions
  captured is one row. No browser.

No test asserts a Playwright _object_ or reaches past the entry point for a result.
`test/fixture-site.test.ts` holds the fixture site to its own record and needs no browser.

**One thing is pinned to Playwright, deliberately.** The driver raises a single
`TimeoutError` for a selector that never resolved and for a navigation that never completed,
so `mapToAutomationFailure` reads its message and call log. Those shapes live in
`test/helpers/driver-errors.ts` — written once, used by both suites — and `failures.test.ts`
drives the same four failures out of a real browser, so a Playwright release that rewords
them turns that suite red rather than silently recording our breakage as the product's.
