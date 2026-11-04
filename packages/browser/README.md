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

## Running one session

`walkTask` over a live source is the whole module in one call: it opens the variant under the
device, captures each screen of the task, and acts on each one until the task's last step is
reached.

```ts
import {
  createLiveSource,
  toAoiEntries,
  toScreenshotEntries,
  walkTask,
} from '@personavision/browser';

const mobile = {
  name: 'mobile',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  touch: true,
};

const walked = await walkTask(createLiveSource(), {
  variant: { id: 'control', url: 'https://shop.example/cart.html' },
  device: mobile,
  // The task's steps, each with a URL pattern, a required element and a primary action.
  task,
  runDir: 'runs/2026-10-27-1012-shop',
});

walked.completed; // true when the walk reached the task's last step
walked.step; // the last step it recognised
walked.integrity; // { selectorFailures, retries }: the two counters a session records
walked.outcome; // an automation-failure outcome, or null when nothing of ours broke

const captures = walked.screens.map((screen) => screen.capture);
const screenshots = toScreenshotEntries(captures); // run.json's `screenshots`
const aois = toAoiEntries(captures); // run.json's `aois`
```

**The walk decides nothing.** `decide` — `(screen, step) => Action | null` — is where the
swarm's decision loop goes: it is handed the capture and the step's declaration, and answers
with the action to take or with `null` to stop the walk on that screen. Without one the walk
advances on the control the step declares, which is what drives the task from end to end. A
walk is capped in screens too — `maxScreens`, eight per declared step by default — so a
decision layer that never advances the step ends the walk rather than spending the session's
whole clock and being recorded as our breakage.

**It reports no product outcome.** A failure of _ours_ ends the walk and comes back as
`failure` with the one outcome it can produce — `attribution: "automation"`,
`excludedFromScores: true`, naming the step it broke on — and the screens captured before it
are kept, because the trace is built from them. Whether a session was a success, was abandoned
or failed is `packages/swarm`'s `decideOutcome` to decide from that trace and the persona:
`completed: true` says the walk reached the last step, not that the person did.

**One budget runs the whole session.** Opening, every capture and every action go through a
single `SessionBudget`, so the caps and the counters are the session's rather than one
operation's. A caller that holds one — the swarm holds one per session — passes it as `budget`.

## Recording a session

Recording is **off unless a session asks for it**, and asking for it is one option:

```ts
const walked = await walkTask(
  createLiveSource({ video: { runDir: 'runs/2026-10-27-1012-shop', sessionId: 'S-01' } }),
  { variant, device: mobile, task, runDir: 'runs/2026-10-27-1012-shop' },
);

walked.video; // the contract's session video block, or undefined when nothing recorded
```

The file is the browser's own: the context is opened with `recordVideo`, so recording needs no
dependency, no binary and no second install command — the Chromium above is all of it. It lands
at `videos/S-NN.webm` inside the run directory, which is `@personavision/contract`'s spelling and
is produced nowhere else, and `walked.video` is the block a session JSON records: the path, the
duration the file has, the cap it hit, and the millisecond offset of every screen and every
action, so that a recommendation citing `S-62 · 0:48` opens on the frame it means.

**A source with `video` records one session.** The request names the session the file belongs to,
and one file cannot be two sessions, so a source opened a second time records nothing rather than
writing over the first recording and reporting its path twice. A caller recording many sessions
builds a source per session — it is an object literal — or opens them itself.

A caller that drives sessions itself — the swarm does — opens with `openSession(variant, device,
{ video })`, marks its own entries with `handle.video?.screen()` and `handle.video?.action()` in
the order its own `screens` and `actions` arrays record them, and **finishes before closing**:

```ts
const session = await openSession(variant, device, { video: { runDir, sessionId: 'S-01' } });
// … capture, act, capture …
const video = await session.video?.finish(); // closes the context and saves the file
await closeSession(session);
```

`finish()` is what closes the context, saves the recording at the contract's path and measures
it, so nothing ever reads a file that is still being written. Closing the browser first leaves
the file where Playwright chose to put it instead.

An **offset is measured when the entry it belongs to is recorded, and marked when the entry is
kept** — `video.at()` gives the moment, `video.screen(atMs)` marks it — because an offset list
has to be exactly as long as the array it indexes, and a screen whose action breaks on the way
never becomes an entry of the session at all.

**A recording is 720p.** The frame is the device's own viewport scaled to fit inside
1280 × 720 — a 390 × 844 phone records at 332 × 720 — so the cap is on the pixels while the
aspect ratio stays the device's, rather than a tall strip in the middle of a landscape frame.

**The caps are the contract's `VIDEO_CAP_MS`, and are restated nowhere — here included.** They
are sized for a session that waits on a model rather than one that only draws: minutes a screen,
an hour a session. Playwright cannot
stop recording a page it is still showing, so a cap is enforced on the file: the recording is cut
at it as it is saved, `truncated` names the cap it hit, `durationMs` is the duration it reached,
and the screens and actions that happened after it carry **no offset** rather than one pointing
at a frame showing something else. A cap does not touch the session, which keeps going and is
still scored.

**A recording that fails is not a failed session.** A videos directory that cannot be made, a
context that opened no recording, a file that cannot be saved or measured, an upload that was
refused: each comes back as `{ state: 'absent', reason }` with the reason in words, the session
otherwise complete, and no automation failure anywhere. The one failure that is known before a
browser is launched — the directory — is found there, so a session whose recording cannot start
never leaks a browser.

**Where the bytes end up is one variable, and this package never branches on it.**
`PV_VIDEO_BUCKET` unset — which is every test, the acceptance suite and the demo — means the file
stays in the run directory, exactly as above. Set, it names a Google Cloud Storage bucket, and
`storeRecording` hands the measured bytes to the store `@personavision/contract`'s
`selectVideoStore` answers with, then removes the local copy so one recording has one home. The
session's own block is identical either way: the same run-directory-relative
`videos/S-NN.webm`, the same duration, the same offsets, and **no bucket name, object URL or
credential anywhere in it**. A caller that wants its own store passes one —
`createLiveSource({ video: { runDir, sessionId, store } })` — and `null` is the run directory,
said explicitly. An object is filed under **the run the caller names**: `runId` defaults to the
run directory's own name, which is right wherever that directory _is_ the run, and a process
writing to a scratch directory of its own — a Cloud Run task's `mkdtemp` — must say, or the
recording is filed under a name nothing can read back. A session that is abandoned finishes its
recording and is written up as having none, so `discardRecording` takes it back out of whichever
home it reached. `docs/adr/0005-where-session-videos-live.md` records the choice, what it costs
and how the recording is then served.

A recording outlasts its session by about a second, because Playwright holds the last frame when
it stops recording. The duration reported is the file's own, read back off the bytes rather than
echoed from the clock that marked the offsets.

### What one recording session costs

Measured here on **plain Playwright Chromium 1.64.1, headless, macOS arm64**, walking the
four-step fixture task at the 390 × 844 mobile device, one session at a time, recording to local
disk. These are the figures #222's concurrency arithmetic and #230's Cloud Run task sizing quote;
the 742–792 MB the dropped CloakBrowser spike measured against a patched build is not this
number.

| What                                       | Measured                                                       |
| ------------------------------------------ | -------------------------------------------------------------- |
| Peak resident memory, Chromium's processes | **0.40 GB**                                                    |
| Peak resident memory, with the Node driver | **0.60 GB**                                                    |
| Wall clock, one recorded session           | **0.79 s** (0.77 s unrecorded: recording costs ~4%)            |
| One session's video                        | **71 KB** for a 1.4 s recording (≈ 25–45 KB/s)                 |
| One that waits on a model                  | **570 KB** for 30.2 s, **753 KB** for 36.3 s (≈ 19–21 KB/s)    |
| A hundred of them                          | **≈ 7 MB** of the short ones; **≈ 1.2 GB** at ten minutes each |

Peak memory is the highest summed resident set size of the whole process tree, sampled ten times
a second while the session ran. It is an upper bound: macOS counts shared framework pages once
per Chromium process. The wall clock is a warm process against a fixture site on loopback, so it
is the floor a real site is measured against rather than what a real session costs. Size scales
with how much of the page moves rather than with how long the task is — a 10.5-second session of
the same walk is 262 KB. The waiting session is the two-step walk of the same site with
thirty-five seconds dwelt on each screen, measured on #412: a page sitting still still costs
about 20 KB a second, so the ten-minute visit a model-driven session of forty screens runs to is
around 12 MB, a hundred of them around 1.2 GB, and the hour-long session cap bounds one recording
at about 70 MB. Which is why the caps exist, and why the bucket in #228 has a lifecycle rule.

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

| Export                               | What it does                                                          |
| ------------------------------------ | --------------------------------------------------------------------- |
| `openSession` `closeSession`         | Launch Chromium with the device applied; close it                     |
| `readSessionState`                   | What the page says about its viewport, pixel ratio, touch and scroll  |
| `readGeometry` `isBelowFold`         | The viewport, the page height and the fold; the fold rule             |
| `capture`                            | One captured screen, composed from everything below                   |
| `captureCacheKey` `readContentHash`  | The cache key, and the hash of what the page currently is             |
| `extractElements` `stableElementId`  | The candidate elements, and the id that is the same every session     |
| `writeScreenshot`                    | The full-page image, into the run directory                           |
| `toScreenshotEntries` `toAoiEntries` | Captures, projected into `run.json`                                   |
| `detectStep` `resolvePrimaryAction`  | Which step the page is on, and the control that advances it           |
| `act`                                | Click, scroll, type, back — and what the page became                  |
| `SessionBudget`                      | The per-session cap on retries and wall-clock time                    |
| `mapToAutomationFailure`             | A thrown error, read as one of our four reasons                       |
| `toAutomationFailure`                | That reason, worded with what was being attempted                     |
| `navigationFailure` `frameFailure`   | The two failures of ours that nothing throws                          |
| `watchFrameFailures`                 | A page's frame failures, as they arrive                               |
| `toAutomationFailureOutcome`         | The session outcome a failure of ours produces                        |
| `withCache`                          | Capture caching, keyed on content                                     |
| `createLiveSource` `walkTask`        | The `CaptureSource` over Chromium, and the walk above it              |
| `prepareRecording` `videoFrame`      | A session's recording, and the 720p frame it is recorded at           |
| `storeRecording`                     | The finished bytes handed to the store one variable chooses           |
| `discardRecording`                   | A recording that was made and will not be reported, out of both homes |
| `readRecording` `cutRecording`       | A recording's own duration and frame; the same file cut at a cap      |
| `createFixtureSource`                | The `CaptureSource` that replays captures from disk                   |

### Which of them are neutral

A seam that has not landed yet **exists, is exported and is typed**, and returns an empty or
pass-through result instead of pretending to work — so a partly filled module still builds,
tests and captures.

**None are left.** `createFixtureSource` was the last one and #52 filled it, so every seam
in the table above does its job. What follows is what it does.

A capture is real geometry, a real content hash, a real step label,
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

`withCache` keeps its entries under `.capture-cache/` in the run directory, so the cache
travels with the run it belongs to and a fresh run starts cold. A hit returns the whole capture
the first session produced — its geometry, its element ids and the path of the screenshot that
session wrote — so sessions over one variant take one picture of each screen rather than one
each. Sessions that reach a screen before the first has finished it all miss and all capture
it: this is a cache over a directory, not a lock over a screen.

**One entry per screen, keyed on `(variant URL, step, device, content hash)`.** The key is what
makes it content-addressed: a screen that rendered differently, or the same markup at another
device, is a different key and a miss. The entry nonetheless lives at the _screen_ and carries
the key it was captured under, because `screenshots/<variant>/<step>.png` is one image per
screen of one variant, whichever device took it and however the page rendered. An entry per key
would answer a desktop session, after a mobile one had overwritten that image, with the first
capture's geometry over the second's picture — the one thing `run-projection.ts` says must not
happen, since the last capture of a screen is the one `run.json` records _because it is the one
on disk_. An entry per screen cannot: the entry and the image are written by the same work.

It is the one path inside a run directory the contract does not spell. `runPaths` declares what
a run publishes; this is the module's own working state, dotted so that nothing globbing a run
mistakes it for artifact data, and read by `cache.ts` alone. The static mount in `packages/cli`
serves any file inside a run directory, so an entry is fetchable by a client that knows to ask —
it holds the capture `run.json`'s own `aois` are projected from, so that exposes nothing the
artifact does not. Nothing the cache does can fail a session either: a truncated entry, an entry
belonging to another key and a run directory that cannot be written to are each a miss.

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
  not, that a capture is never answered from an entry whose image another device has
  overwritten, and that a damaged entry or an unwritable run directory is a miss and never a
  failed session. The screenshot is deleted between two captures, because that is the one thing
  a hit and a miss leave differently on disk; where a hit would be wrong, the image's own
  pixel dimensions are read instead.
- `test/video.test.ts` — one recorded walk per assertion, each read back off disk: the
  non-empty WebM at the contract's path whose measured duration is the one the session
  reports, the 720p frame, the offsets of every screen and action parsed against the
  contract's session schema, the two caps cutting the file and leaving the entries past them
  without an offset, the unwritable videos directory that leaves the session complete with
  its video absent and no automation failure, and one walk handed a fake object store whose
  session records the same contract path and nothing of the store. The frame arithmetic and
  bytes that are not a WebM need no browser.
- `test/video-store.test.ts` — the hand-over on its own: no store leaves the file where it is,
  a store takes the bytes under the run and the local copy goes, the run is the one the caller
  named rather than the scratch directory it was written to, an abandoned recording comes back
  out of both homes, a store that refuses is a stated absence naming a status and no bucket, and
  neither mode writes a log line. No browser.
- `test/budget.test.ts` — the retry and wall-clock caps and the integrity counters. No browser.
- `test/run-projection.test.ts` — the two `run.json` arrays, placed into the committed
  example run and parsed by `@personavision/contract`, and that a screen a dozen sessions
  captured is one row. No browser.
- `test/integration/live-source.test.ts` — one live walk of the four-step fixture task: four
  screenshots on disk with the geometry of each, one primary action marked per step, the
  control that is below the fold at the mobile device and not at the desktop one, an action
  aimed by `elementId` at the capture it was decided against, the screen cap that ends a walk
  whose decision layer never advances, a session abandoned mid-launch being closed rather than
  leaked, the two `run.json` arrays the walk's captures project into parsed by the contract,
  and the two ways a walk ends as an automation failure rather than as a verdict on the
  product.

No test asserts a Playwright _object_ or reaches past the entry point for a result.
`test/fixture-site.test.ts` holds the fixture site to its own record and needs no browser.

**One thing is pinned to Playwright, deliberately.** The driver raises a single
`TimeoutError` for a selector that never resolved and for a navigation that never completed,
so `mapToAutomationFailure` reads its message and call log. Those shapes live in
`test/helpers/driver-errors.ts` — written once, used by both suites — and `failures.test.ts`
drives the same four failures out of a real browser, so a Playwright release that rewords
them turns that suite red rather than silently recording our breakage as the product's.
