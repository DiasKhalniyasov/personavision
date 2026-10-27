# How a UEyes record becomes a session with `kind: "real"`

One conversion, so that calibration is a comparison of two files of the same shape: a human's free viewing of one
screenshot becomes a session `packages/contract`'s own `sessionSchema` accepts, beside a simulated one. There is no
second format, no second reader and **no field invented in this package** — the contract is the only place in this
repository where an artifact field name is declared (#86, #11).

The code is [`../src/convert/session.ts`](../src/convert/session.ts), reached through the package's entry point as
`convertRecord` and `convertRecords`; the assertions are [`../test/convert.test.ts`](../test/convert.test.ts) against
the hand-written records in [`../test/fixtures/raw-records.ts`](../test/fixtures/raw-records.ts). **No download, no
network, no API key**: this conversion is tested on committed material, as the no-vendoring auto-decision on #11
requires.

## One record, one session per participant

The dataset's unit is an image. Its gaze is one log per participant who saw it, and a session carries exactly one
participant — so a record with three participants converts to **three sessions**, which is three files to put beside
three simulated ones. `convertRecord` returns one `ConvertedSession` per participant, in the order the record lists
them; `convertRecords` does a batch.

## What a session's every field comes from

| Session field | Value | Why |
| --- | --- | --- |
| `kind` | `"real"` | The discriminator the contract already carries for an imported human session. |
| `participant` | `{ id }`, the dataset's participant id | A real session names the human whose gaze it is. |
| `persona` | `null` | A participant is a human being, not a generated person. |
| `seed` | `null` | Nothing about this session was sampled, so there is no seed to replay it from. |
| `variant` | the record's id (`webpage-0042`) | The image is what was looked at, so it is what the session is about. |
| `taskId` | `free-viewing-1s` / `-3s` / `-7s` | The dataset's viewing condition, which is the only "task" there was. |
| `runId` | the dataset's id from [`manifest.json`](../src/dataset/manifest.json), or the caller's | A converted session says which benchmark it came from, and the name is read rather than restated. |
| `sessionId` | `S-01`, `S-02` … | The contract's ordinal within a run, which is also the session file's name. |
| `startedAt` | synthesised — see [below](#the-one-synthesised-timestamp) | The dataset publishes no wall-clock time. |
| `durationMs` | the exposure: `1000`, `3000` or `7000` | How long the humans were shown the image. |
| `screens` | exactly one | A UEyes record is one image: one screen, `scrollY: 0`. |
| `screens[0].step` | the record's category (`webpage`, `desktop`, `mobile`, `poster`) | A figure is reported per category, and the category is the only step there is. |
| `screens[0].screenshot` | the image's file name as the dataset spells it | For a converted record this points into the dataset, not into a run directory's `screenshots/`. |
| `screens[0].intent` | *"Free viewing: look at the screenshot, with no task to do."* | **A free-viewing record has no task**, and the session says so in words rather than naming a goal it never had. |
| `screens[0].decidedAction` | `none` | There was nothing to decide. |
| `actions` | `[]` | Free viewing is looking, not doing: no click, no scroll, no typing. |
| `fixations` | the participant's scanpath — see [below](#fixations-and-saccades) | |
| `saccades` | between consecutive fixations | |
| `outcome` | `success`, attributed to `product`, `excludedFromScores: true` — see [below](#the-outcome) | |
| `integrity` | `{ selectorFailures: 0, retries: 0 }` | Nothing automated this session: a human looked at an image. |

## The display the humans saw travels **beside** the session

A prediction has to be made at the resolution the humans saw and never at a default (#11, user story 4), so the
record's own viewport and scale must survive the conversion. They do — as `ConvertedSession.display`, next to the
session rather than inside it:

```ts
const [first] = convertRecord(record);
first.display; // { viewport: { width: 1920, height: 1200 }, scale: 1.5 }
first.session; // kind: 'real', participant: { id: 'p-01' }, persona: null
```

**Why not on the session.** The contract's session records a viewport only on a `persona` — `persona.device.viewport`
and `persona.device.deviceScaleFactor` — and a real session has no persona and must not be given one: a participant
is a human, and a persona-shaped carrier would be a claim that this session was generated. There is no other field on
a session or on a screen that holds a display. So the display travels with the conversion's own result, where #88's
scoring and #91's CLI read it, and `packages/contract` **is unchanged by this ticket**, as #86's criteria and #11's
note both require. The auto-decision is recorded on #86 for #2 and #11, together with the one thing a reader of
`docs/FLOW.md` section 8 should know: that section lists "viewport, device" among what simulated and real sessions
share, and the schema offers them only by way of a persona. Closing that gap is a change to `packages/contract`,
announced and reviewed there — not a field invented here.

`ConvertedSession` carries the record's `category`, `viewingDurationSeconds` and `imageSize` for the same reason: so
that a caller grouping sessions reads the record's own facts instead of parsing them back out of a session's strings.

## Fixations and saccades

Geometry is **image space**: the origin is the image's top-left pixel, `x` runs right, `y` runs down — the convention
[`../src/types.ts`](../src/types.ts) fixes for this whole package.

- `index` runs `0, 1, 2 …` continuously across the session, which is what the contract's own refinement requires, and
  `screenIndex` is `0` for every fixation: there is one screen.
- `tMs` is the dataset's own onset from the start of viewing and `durationMs` its dwell. Neither is rescaled.
- `x`/`y` and `pageX`/`pageY` **coincide**. A UEyes record is one image with no page and no scroll, so the viewport
  and page coordinates of a point are the same point.
- `aoiId` is `null`. A UEyes image has no areas of interest, and a fabricated one would be a lie about where
  attention landed.
- A saccade joins each fixation to the next. Its `amplitudePx` is the distance the two points imply and its
  `durationMs` the gap between one dwell ending and the next onset. A single-fixation scanpath has no saccades.

The amplitude is `Math.sqrt(dx * dx + dy * dy)` rather than `Math.hypot`, whose precision the language leaves to the
implementation: IEEE 754 specifies a square root exactly, so every machine writes the same bytes. The fixtures are
built from a 3-4-5 and a 5-12-13 triangle, so the test asserts `400` and `520` px on the nose rather than a float a
reader has to trust.

**The image's own edge is on the image.** A fixation at exactly `(width, height)` converts; only a point strictly
outside is refused. That is the same inclusive upper edge the scanpath metrics read a boundary fixation at
([`metrics-scanpath.md`](./metrics-scanpath.md)), and for the same reason: a reader that reports a boundary pixel is
not wrong about where the human looked.

**A dwell may run past the viewing cut.** The dataset cuts a scanpath at 1, 3 or 7 seconds *by onset*, so a fixation
that begins inside the exposure and ends after it is kept as it is. The session's `durationMs` is the exposure, not
the last fixation's end. A fixation that *begins* after the exposure is a rejection.

## The outcome

| Field | Value |
| --- | --- |
| `status` | `success` |
| `step` | the record's category |
| `reason` | *"Free viewing of one screenshot with no task: the exposure ran to its end, so there was nothing to abandon or fail. Excluded from the product scores, which are about a task."* |
| `attribution` | `product` |
| `excludedFromScores` | `true` |

The viewing ran to completion, and of the outcomes the contract names `success` is the true one: `abandoned` is
giving up, `failed` is ending with the task not done, `automation_failure` is our own browsing breaking — and there
was no task and no automation. **The status enum is not extended.** A new value would ripple into every exhaustive
switch in the viewer and the scoring package, which is why #11's breakdown lists extending it as an alternative it
did not take. `excludedFromScores: true` is what keeps such a session out of a product figure, and it is `true` on
every converted session.

## The one synthesised timestamp

UEyes publishes no wall-clock time for a viewing, so `startedAt` is synthesised — and derived from the record's own
identity, as #86 requires:

```
startedAt = manifest.dataset.source.publishedOn (2023-06-06, read from the manifest)
          + hash32(`${recordId}\0${participantId}`) mod 24 h
```

`hash32` is FNV-1a over the string's UTF-16 code units through `Math.imul`, which is exact, so the instant is the
same on every platform and in every run. It is **a label, not a measurement**: stable for a given session, distinct
between sessions, inside the day the dataset was published, and obviously synthetic to anyone who reads it.

## Determinism

The same record converts to byte-identical JSON. There is no clock, no random source and no floating-point operation
whose result an implementation may choose; the session object is built in one field order and returned as built —
the contract's schema is used to *check* it, never to re-serialise it.

Session ids are the one thing that depends on more than the record: an id is an ordinal within a run (`S-01`, `S-02`
… `S-NN`, which is also the file's name), so a batch numbers the sessions in the order the records and their
participants arrive, continuing from `firstSessionNumber`. A record converted at another offset in another batch
differs in that one field and nowhere else, and a rejected record consumes no number — so the ids of what did
convert run unbroken.

## Rejections

A malformed record is rejected with a reason naming **the record and the field**, so a reader can go to the one line
of the one file that is wrong:

```
record "webpage-0042" is not convertible: participants[0].fixations[2].tMs is 400 ms, which is
not after fixation 1, whose dwell ends at 560 ms: a scanpath's fixations run forwards in time
and do not overlap
```

`convertRecord` throws `ConversionError`, which carries `recordId`, `field` and that message, and `error.rejection`
is the same facts as data. `convertRecords` collects them: **a batch reports every rejection and converts the rest**
rather than stopping at the first.

**A record converts whole or not at all.** One scanpath this conversion cannot read rejects the record it belongs to,
rather than dropping that participant and converting the others — no figure should ever be measured against ground
truth that was quietly trimmed of a human.

Every case, with the field it is named at:

| What is wrong | Field |
| --- | --- |
| No image | `image` |
| An image of no width or height | `image.width`, `image.height` |
| No display — a prediction would be made at a default | `display` |
| A viewport or scale that is not a measurement | `display.viewportWidth`, `display.viewportHeight`, `display.scale` |
| An unknown category | `category` |
| An unknown viewing condition | `viewingDurationSeconds` |
| A record with no id | `id` |
| No participants at all | `participants` |
| A participant with no id, or two scanpaths under one id | `participants[i].participantId` |
| No fixations | `participants[i].fixations` |
| An onset, dwell or coordinate that is not a finite, non-negative number | `participants[i].fixations[j].{tMs,durationMs,x,y}` |
| Timestamps out of order, or two fixations overlapping | `participants[i].fixations[j].tMs` |
| A fixation beginning after the exposure | `participants[i].fixations[j].tMs` |
| A fixation outside the image | `participants[i].fixations[j].x`, `…y` |
| A session the contract's schema does not accept — a defect here, not in the record | `session.<path>` |

The last row is the gate that makes the first criterion structural rather than a test's promise: every converted
session is handed to `sessionSchema` before it is returned, so a defect in this conversion cannot put an invalid
session in a run directory.

## What this conversion reads, and what nobody has verified

`RawRecord` is **this package's** name for what a reader of the dataset's own files hands over: one row per
screenshot with its category and display (`info.csv`), one log per participant (`eyetracker_logs/`). The archive's
layout is recorded in [`manifest.json`](../src/dataset/manifest.json) with `verifiedAgainstArchive: false`, and #81
deliberately declared no raw type for that reason — a field name invented from a README is the same mistake as an
invented checksum. So the reader that first opens the real files maps the real columns onto this shape, and nothing
downstream of the conversion ever sees a CSV column.

The types are loose exactly where the files are loose: `category` and `viewingDurationSeconds` are a string and a
number rather than this package's unions, `image` and `display` are nullable, a scanpath may be empty. Every one of
those is a malformed record to reject by name, not a state to rule out at the reader's expense.

## What this conversion does not do

- **It produces no saliency map and no `GroundTruthRecord`.** The humans' aggregated map is the dataset's own
  `fixmaps_{1,3,7}s` file, which is not in a scanpath log; the ground-truth record is what the metrics (#83, #84) and
  the scoring (#88) read, and the committed corpus (#82) already supplies it in that shape. A session is the other
  shape, for the other reader: the viewer, and a file beside a simulated one.
- **It downloads nothing and writes nothing.** The download is #85's and the run directory is the CLI's (#91). This
  is a pure function from a record to sessions.
