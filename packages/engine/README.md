# `@personavision/engine`

The attention engine: given a capture of a screen and an agent's goal, persona and viewing
history, it builds the areas of interest, weighs visual salience against goal relevance and
viewing history, samples a fixation sequence with human-like durations and saccades, and
aggregates a run's sessions into the per-area numbers the screens read.

Vocabulary is `docs/FLOW.md` section 8's: fixation, saccade, dwell, area of interest, time
to first fixation, revisit, scanpath, persona, seed, session, variant.

## The engine is pure

A capture plus state in, fixations out. **The engine reads no file, opens no socket and
calls no model.** Image bytes, captures and model-supplied relevance hints are handed to it
by the caller; the calibrated configuration arrives as a build-time import. Every draw
comes from the seeded generator in `@personavision/contract`, threaded as an argument —
no `Math.random`, no module-level generator, no iteration over unordered maps — so the
same seed, persona, page and goal produce byte-identical fixations.
`tests/config.test.ts` holds that line over the package's sources.

Dependencies: `@personavision/contract` for the artifact types and the seeded generator,
and `sharp` for the image statistics the salience term reads.

## One configuration object

`EngineConfig` is the only place a tunable number lives. The calibration step fits _this
object_ against UEyes and commits the result as data, so a number written inline in a
sampler or a salience term is a defect: it is a number calibration cannot reach.
`tests/config.test.ts` enumerates the object's leaf keys and fails if the set changes
unannounced.

| Group                  | What it holds                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `alpha` `beta` `gamma` | The softmax weights of `P(area) ∝ exp(alpha·salience + beta·relevance + gamma·history)`                |
| `salience.weights`     | Local luminance contrast, colour contrast, relative area, centre bias, top bias, role prior            |
| `salience.rolePriors`  | The role prior per element role, with `other` as the fallback                                          |
| `salience.surround`    | The ring of pixels an area's contrast is read against: its thickness, and its minimum                  |
| `relevance`            | Lexical match weights, the role weight, the hint weight, the floor, and the role weights per goal verb |
| `fixationDuration`     | The log-normal median and sigma, and the bounds a duration is clamped to                               |
| `saccade`              | Amplitude median and sigma; duration as `baseMs + msPerPixel · amplitude`, clamped                     |
| `interFixation`        | The gap between one fixation ending and the next starting                                              |
| `landing`              | The spread of a landing point inside its box, and the inset that keeps it inside                       |
| `inhibitionOfReturn`   | The penalty, its decay, the immediate-repeat allowance, and the deliberate-return condition            |
| `fixationsPerScreen`   | How many fixations a screen gets, and the bounds                                                       |
| `persona`              | The persona-trait table's numbers (see below)                                                          |
| `prediction`           | What `predict` assumes about a bare screenshot, and the map's resolution, kernel and normalisation     |

`defaultEngineConfig` holds the **uncalibrated** starting values: plausible, taken from
published ranges where one exists, and not claimed to be fitted.

`resolveEngineConfig(overrides)` layers the calibrated values and then the overrides over
the defaults — later layers win key by key, to any depth — and answers
`{ config, calibrated }`. It is pure: the same overrides always produce a deeply equal
result, neither the overrides nor the defaults are mutated, and no sub-object of the answer
is the module-level default itself, so a caller may hand in `run.engine.weights` directly.

```ts
const { config, calibrated } = resolveEngineConfig(run.engine.weights);
```

A **run artifact carries `alpha`, `beta` and `gamma` only**: `runSchema.engine.weights` in
`@personavision/contract` is those three and zod strips the rest. The deeper layers of
`EngineConfigOverrides` are reachable from `config/calibrated.json` and from an in-process
caller — a test, the benchmark — so a run that should carry more than the softmax weights
is a change to the contract's schema, to be asked for on #7.

### The calibrated configuration

`packages/engine/config/calibrated.json` is the path the calibration step commits its
fitted values to. It is imported as a static data module when present and becomes the
default layer; `calibrated` then reports `true`. While the file is absent, the resolved
configuration is the defaults and `calibrated` is `false` — never a fabricated number. The
import lives in one place, at the `calibratedOverrides` seam in `src/config.ts`, which
names the two lines the calibration step replaces. It is a build-time import and never a
run-time read: see _The engine is pure_ above.

## The persona-trait table

The one mapping from a persona's six traits — each 0..1, as `run.json` records them — to
the engine's sampling parameters. This table is the persona contract the swarm step writes
personas against, and it lives only here: `packages/personas` keeps the traits as data and
precomputes nothing. The numbers are in `config.persona`, so calibration can fit them; the
directions below are the contract, and `tests/persona.test.ts` holds one test per row.

| Trait                  | Parameter                | Direction as the trait rises                            |
| ---------------------- | ------------------------ | ------------------------------------------------------- |
| `scanningVsReading`    | `fixationDurationScale`  | **falls** — a scanner's fixations are shorter           |
| `scanningVsReading`    | `fixationCountScale`     | **rises** — a scanner makes more fixations per screen   |
| `detailOrientation`    | `dwellScale`             | **rises** — detail work dwells longer in an area        |
| `patience`             | `dwellScale`             | **rises** — a patient agent dwells longer in an area    |
| `interfaceFamiliarity` | `rolePriorScale`         | **rises** — familiar eyes go to conventional controls   |
| `persistence`          | `screenPersistenceScale` | **rises** — a persistent agent stays on a screen longer |
| `riskTolerance`        | `verificationScale`      | **falls** — a risk-taker re-checks less before acting   |

`dwellScale` reads the mean of `detailOrientation` and `patience`, so raising either one on
its own raises it. Each row interpolates linearly between the configured value at trait 0
(`atZero`) and at trait 1 (`atOne`), so it is monotonic by construction; `atZero` above
`atOne` is how an inverse row is written.

- `personaSamplingParams(traits, config)` — the six scales.
- `fixationDurationMedianMsFor(traits, config)` — the median fixation duration, clamped to
  `fixationDuration.minMs`/`maxMs`, so no trait combination asks for a duration of zero.
  It applies `fixationDurationScale` and nothing else: `dwellScale` belongs where dwell
  accumulates, in the sampler, and applying it twice would count `detailOrientation` and
  `patience` twice and could cancel the row above it.
- `fixationCountFor(traits, config)` — the fixations a screen gets, clamped to
  `fixationsPerScreen.min`/`max`, so no trait combination asks for an empty screen. It
  applies `fixationCountScale` only; `screenPersistenceScale` is the sampler's, which
  composes the two rows in `screenFixationCount` — see the scanpath section below.
- `rolePriorFor(role, traits, config)` — the role prior with familiarity applied. Only a
  conventional control (`CONVENTIONAL_CONTROL_ROLES`: which roles those are is structure,
  so it is code rather than configuration) is scaled; a paragraph's prior is the same for
  every persona. A control the table does not name falls back to `rolePriors.control`
  rather than to `other`, so a search box never scores below body text, and the lookup is
  an own-property one — a page is free to use `role="toString"`. It is a relative weight,
  not a 0..1 share: the salience term normalises it together with the others.

## The human-like draws

`src/sampling/distributions.ts` holds the seeded draws that make a sequence of chosen areas
look like a human looking: how long a fixation lasts, how far and how long the jump between
two of them is, when the next one starts, and where inside an area the gaze lands. Choosing
_which_ area is fixated is the sampler's job. Every parameter is in `config`, so calibration
fits these as data, and `tests/distributions.test.ts` holds the distributional properties.

- `drawFixationDurationMs(persona, rng, config)` — log-normal around
  `fixationDuration.medianMs`, scaled by the persona's `fixationDurationScale` and clamped
  to the configured bounds. Positive, right-skewed, and shorter for a scanning persona than
  for a reading one by the ratio the table above states. Consumes 2 values from `rng`.
- `drawSaccadeAmplitudePx(rng, config)` — log-normal around `saccade.amplitude.medianPx`,
  for the paths with no geometry to measure: `predict()` on a bare screenshot, and
  calibration fitting the amplitude distribution itself. Consumes 2.
- `saccadeDurationMsFor(amplitudePx, config)` — the main sequence, a longer jump takes
  longer: `baseMs + msPerPixel · amplitude`, clamped. No `rng`, because the relationship is
  not a draw. The sampler calls this with the distance between two landing points.
- `nextFixationStart(previous, saccadeDurationMs, rng, config)` → `{ tMs, gapMs }`. The gap
  is drawn around `interFixation.gapMs` and floored at the saccade plus `minGapMs`, so the
  saccade accounts for part of every gap and `tMs` strictly rises along a session. On the
  defaults that floor binds for about two gaps in five: the realized gaps are a truncated
  normal, which is what calibration fits. Consumes 2.
- `drawLandingPoint(box, rng, config)` → `{ x, y }` — an independent normal per axis with a
  standard deviation of `landing.spreadShare` of the box's half-extent, so the heatmap has a
  believable shape at any box size. Always strictly inside the box, from a 1×1 box to a
  page-sized one, and never a negative coordinate: the drawable interval is the box's inset
  interval intersected with the page. Consumes 4 — two per axis, `x` first.

Each draw is a pure function of its inputs, the persona's sampling parameters and the
generator it is handed, consumes a fixed number of values from it, and caches nothing
between calls, so two runs on one seed produce byte-identical sequences.

## Bottom-up salience

`src/salience.ts` answers how much each area of interest stands out _before_ anything is
known about the agent's goal — the bottom-up half of
`P(area) ∝ exp(alpha·salience + beta·relevance + gamma·history)`. Six explainable image
statistics, deliberately not a pretrained saliency network: SAM's role in this project is
segmentation, and calibration has to be able to fit these terms.

| Term                | What it reads                                                        |
| ------------------- | -------------------------------------------------------------------- |
| `luminanceContrast` | the area's mean luminance against the ring of pixels around it       |
| `colourContrast`    | the same ring in opponent colour, so hue counts apart from lightness |
| `relativeArea`      | how much of the page the area occupies                               |
| `centreBias`        | how near the page's centre it sits                                   |
| `topBias`           | how near the top of the page it sits                                 |
| `rolePrior`         | that a button is not a paragraph, scaled by interface familiarity    |

- `salienceByArea({ screenshot, page, aois, traits, config })` → `Map<aoiId, number>`, each
  value on **0..1 inclusive**: the weighted mean of the six terms, the weighted sum over the
  total weight. Normalising is what makes the value comparable rather than merely ordered,
  since the sampler weighs it against relevance; it survives a negative weight if
  calibration fits one, and zeroing a term's weight leaves the other terms' values alone.
- `salienceTermsByArea(…)` → `Map<aoiId, { salience, terms }>`, the same with the six terms
  each value came from, for a screen or a benchmark that has to say _why_.
- `readScreenshotPixels(bytes)` decodes a screenshot **once**. A caller scoring several
  personas over one capture passes the result back in as `screenshot`, so a run of
  twenty-four sessions decodes each capture once rather than once per persona per area.

`page` is `{ width: capture.viewport.width, height: capture.pageHeight }` — page space, the
space an area's `bbox` is in — and the screenshot's own pixel dimensions carry the device
pixel ratio, so a 2× screenshot needs no second argument. The module is pure in the sense
this README's first section means it: the bytes are handed to it, it resolves no path, and
it opens nothing. Values are deterministic across machines, because pixels are summed in
row-major order and only operations IEEE-754 rounds exactly get between a pixel and a value.

An area with no interior (a zero-width or zero-height element) and an area whose ring is
clipped away (one that fills the screenshot) report no contrast rather than an invented
number, and stay inside the range. `tests/salience.test.ts` holds the range over every such
area, reads one term at a time with the other weights zeroed, and fails on any numeric
literal in the module that is not a definition.

## The scanpath

`src/sampling/sample-fixations.ts` is where the terms above become a sequence. It is the
engine's centre, and the only module that recomputes a term as it goes.

```ts
sampleFixations({ aois, goal, persona, history, seed, weights }) -> { fixations, saccades }
```

A fixation's area is drawn from `P(area) ∝ exp(alpha·salience + beta·relevance +
gamma·history)`, with the three weights read from the resolved configuration — a run's
`engine.weights` over the defaults — so calibration changes behaviour without changing this
module. The answer's `fixations` and `saccades` are the contract's own session shapes, typed
from them: `index`, `screenIndex`, `tMs`, `durationMs`, `x`, `y`, `pageX`, `pageY` and
`aoiId`, and `fromFixation`, `toFixation`, `amplitudePx` and `durationMs`. No field is this
module's to invent, and an area the sampler never selected simply does not appear.

- `aois` are the areas on this screen, as `buildAois` built them: an id, a box in page
  space, and whatever words relevance reads. A `CaptureElement` satisfies the same type, so
  the benchmark can sample a screen it never built areas for.
- `salience` is the 0..1 value per area id that `salienceByArea` produced. It is an input
  because the engine is pure and this module takes no image: an area the salience module did
  not score contributes nothing through `alpha`, and omitting the map is how a screen whose
  screenshot was never read is sampled honestly.
- `history` is the fixations the agent has already made this session — `session.fixations`
  as it stands, no adapter — and it is both what inhibition of return reads and where this
  screen's `index` and clock continue from, so `index` is continuous across a session and
  `tMs` strictly rises through it. Omit it for the first screen of a session.
- `screenIndex` and `scrollY` are the screen's own: `scrollY` turns a page point into the
  viewport point the session records beside it.
- `relevanceHints` is model mode's optional per-area hint (#33); offline is the default.

**How long a screen lasts.** `screenFixationCount(traits, config)` composes two rows of the
persona-trait table: the count row through `fixationCountFor`, then `screenPersistenceScale`
— how long the agent keeps looking before it is done with the screen, which on a screen with
no clock of its own is measured in fixations — re-clamped to `fixationsPerScreen.min`/`max`.
The run loop does not spend the persistence row again on its own decision to leave. Each
duration is `drawFixationDurationMs`, and `dwellScale` scales a look at an area that already
has a fixation behind it this session, which is where an area's dwell accumulates; the first
look at an area is the duration draw unscaled, so the duration row and the dwell row are
never counted on the same number. The count is the persona's and not a draw, so
`fixationsPerScreen.logSigma` is the one leaf of that group nothing reads yet: spending it
needs a normal draw `src/sampling/distributions.ts` does not publish, so it is named on
#67 rather than fitted blind by calibration.

**Inhibition of return** is `src/sampling/history.ts`, beside the sampler because it is a
property of the sequence rather than a static term. Two mechanisms, both parameterised under
`inhibitionOfReturn`:

- the **run cap**, `immediateRepeatAllowance`: an area that has just held that many
  consecutive fixations is not a candidate for the next one while the screen offers another.
  A cap rather than a steep penalty because "no area twice in a row beyond the allowance" is
  a property of the output, and a penalty only makes a long run unlikely. Only the most
  recent area is ever held, so a screen with two areas always has somewhere to look.
- the **decaying penalty**, `penalty` and `decayPerFixation`: subtracted from the history
  term of an area with a fixation behind it and worth half as much again with every further
  fixation on the defaults, so the suppression wears off and a later return is possible.

A **deliberate return** is the same magnitude with its sign turned around: it happens when
the goal still points at the area (`deliberateReturnRelevance` against the relevance term)
_and_ enough fixations have passed (`deliberateReturnAfterFixations`). In the output it is
told from an immediate re-fixation by the distance between the two looks, which is why
neither needs a field of its own. `gamma` scales the whole term, so raising it pushes a
revisit further out; it does not change which areas the cap holds.

**Determinism.** One `createSeededRandom`, threaded through every draw and consumed in a
fixed order: per fixation the area (1 value), its duration (2), its landing point (4), then
the gap to the next fixation (2). Nothing reaches for the platform's unseeded generator,
nothing decides anything by iterating a map's keys, and the areas are sorted by id before
any of it, so the order a caller hands them over in cannot change a scanpath. `tests/sample-fixations.test.ts` holds the same
input to the same bytes in this process and in a second one, each weight to its documented
direction, the sequence properties above, and the empty screen and the one-area screen.

## Predicting from a bare screenshot

`src/predict.ts` is the path the calibration step scores the engine through. UEyes gives
images and human gaze, not web pages — no DOM, no accessibility tree, no goal and no
persona — so this path takes pixels alone and still answers a saliency map and a scanpath.

```ts
predict(image, seed, options?) -> { saliencyMap, scanpath, display }
```

It is not a second engine. The offline segmenter partitions the image with nothing
explained by elements, because there are no elements; the salience terms score those
regions from the pixels; the sampler draws a scanpath over them with the goal empty, so
relevance is flat at its floor and the result rests on salience, the position priors inside
it and the sequence dynamics; and the fixations are spread into a continuous map.

- `image` is `{ bytes, size, display? }` — the screenshot's bytes as the caller read them,
  its pixel size, and the display it was shown at when that is known. A **bare** image is
  one with no display: the viewport is defaulted from the image's own dimensions at a scale
  of 1, and the answer's `display` reports what was assumed, so a prediction is never
  quietly made at a resolution the humans did not see. A given display is echoed unchanged;
  a number that is not usable — zero, negative, `NaN` — is defaulted rather than carried.
- `seed` makes a reported score reproducible: the same image and seed answer the same map
  and the same scanpath, and a different seed answers a different scanpath, which is what
  lets the fit repeat a run exactly.
- `options.weights` layers over the engine defaults, so the fit varies the configuration
  without a code change, and `options.segmenter` replaces the offline heuristic one, which
  is the default. A replacement is handed a synthetic capture that names no screenshot file
  — `predict` holds the pixels — so an implementation that wants the image brings its own
  copy of it.

**What a reviewer of a reported figure has to know.** `CC, NSS, KLD and AUC-Judd` are each
sensitive to some of the following, so all four are stated rather than assumed, and every
number is in `config.prediction` where calibration can fit it.

| Convention      | What `predict` answers                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolution      | `round(imageWidth / cellPx)` × `round(imageHeight / cellPx)` cells, at least one of each: the image downscaled by `prediction.map.cellPx`, 10 on the defaults |
| Coordinates     | Row-major image space: cell `(x, y)` is `values[y * width + x]`, cell `(0, 0)` is the image's top-left corner, `x` right and `y` down                         |
| Kernel          | An isotropic 2-D Gaussian per fixation, standard deviation `kernelSigmaShare` of the map's longer side, truncated at `kernelRadiusSigmas`                     |
| Fixation weight | The dwell raised to `dwellWeightExponent` — 1 is dwell-weighted, 0 counts fixations                                                                           |
| Normalisation   | `sum-to-one`: the values sum to 1, finite and non-negative, so the map is a distribution over the image's cells                                               |

The two sides of the resolution are rounded independently, so the map's aspect ratio agrees
with the image's to within one cell, and the map carries the `imageSize` it describes —
taken from the bytes as they decoded, not from a declared size that disagrees with them.
Mass that the truncation or the image's edge drops is absorbed by the normalisation.
`sum-to-one` is the rule the calibration package's own maps use, so a metric compares like
with like and KLD — the one metric that is not invariant to a rescaling — converts on
neither side.

**Why the cell is ten pixels and not twenty.** The calibration package's saliency metrics
compare the two grids' _shapes_ and refuse a pair whose aspect ratios are more than one per
cent apart, and the shape of an integer grid is only as faithful as its own coarseness. A
twenty-pixel cell is outside that bound on a 390 × 844, an 828 × 1792 and a 1170 × 2532
image — ordinary phone screenshots — which would cost those records their score rather than
give them a poor one. A ten-pixel cell is inside it on every size tried, and
`tests/predict.test.ts` holds that over the sizes the engine is scored on. Halving the cell
costs nothing else: the kernel is a share of the grid's longer side, so it stays the same
width in image pixels and is only stated on a finer grid, and the prediction is then
resampled onto the ground truth's grid, which is the documented path and an exact
area-weighted mean whenever the two are integer multiples — as 32 × 24 onto 16 × 12 is.

**An image with nothing in it is still an answer.** The segmenter honestly finds nothing on
a flat field, which is the point of its background estimate. `predict` then partitions the
image into a grid of `prediction.priorGridCellsAcross` cells across, with the rows following
from the aspect ratio, and scores those with the same salience terms: their contrast is nil
and their areas are equal, so the centre bias and the top bias decide, and the result is a
valid map and a non-empty scanpath led by the position priors. `tests/predict.test.ts`
states that as the expected behaviour and holds the direction of both priors, rather than
treating an empty image as degenerate.

**A segmenter that fails is not an image with nothing in it.** `buildAois` swallows a
segmenter's throw because a segmenter is additive to the areas the elements explain — but
here there are no elements, so it is the only source of areas and "additive" has no content
left. `predict` therefore raises the error rather than answering the position priors, which
is what it already does with bytes `sharp` cannot decode: a caller scoring one image reports
a failed record instead of a figure nobody can tell from a weak one.

**Page space to image space is read from the image.** The sampler works in page space — the
image in CSS pixels — and the seam's fixations are image pixels, so the factor is the
image's own dimensions over the page's, per axis, exactly as `src/salience.ts` reads an
area's box. It is not `display.scale`, which equals that factor whenever a given display
agrees with the bytes and would silently relocate the whole scanpath whenever it does not:
`Display` is two independent numbers, and nothing holds `viewport * scale` to the image's
size.

A bare image has no persona, so every trait takes `prediction.neutralTrait` — the middle of
each row of the trait table, not a claim about a population — and no goal, so
`relevanceByArea` leaves every area at `relevance.floor`. Free viewing has no task to be
relevant to, and inventing one would predict a scanpath nobody performed.

**The seam with the calibration package.** `predict` satisfies that package's `Predictor`,
`(image, seed) => Prediction`, and `src/predict.ts` declares `PredictorImage`,
`Prediction`, `SaliencyMap`, `PredictedScanpath`, `PredictedFixation`, `Display`,
`ImageSize` and `SaliencyNormalisation` **field for field** as it publishes them, exactly as
`src/types.ts` declares the browser step's `Capture`. Neither package may import the other:
this one depends on `@personavision/contract` and `sharp` only, `tests/config.test.ts`
asserts that list, and the calibration package's own `test/dependency-direction.test.ts`
asserts that no file here imports it. The fixation's fields are not restated at all — they
come from `@personavision/contract`, which both packages already read. The assignment that
holds the two sides together is in `tests/predict.test.ts`, checked by
`tsc -p tsconfig.tests.json`, so a field renamed on either side fails the build there
rather than at the point of wiring.

**Purity and determinism.** The engine still reads no file and opens no socket: the bytes
arrive from the caller, the one decode hands them to `sharp`, and the default segmenter is
given the pixels that decode produced, so it opens nothing either. The scanpath is
byte-identical on any machine, as the sampler's is. The map's cells are accumulated with
`Math.exp`, which IEEE-754 does not pin the way it pins addition and square root, so a
_different JavaScript engine_ could differ in a cell's last bits; within the Node range this
repository supports they do not, and no metric of the calibration step is sensitive at that
scale.

## The published input types

`Capture`, `CaptureElement`, `BoundingBox`, `Viewport`, `ElementSource` and `Goal` are the
engine's **own** structural types, declared field-for-field as `packages/browser` publishes
its `Capture`. The engine does not import `packages/browser`: TypeScript's structural
typing joins the two sides, a capture from the browser step satisfies these types with no
adapter, and the engine's dependency graph stays free of Playwright. Geometry is in page
space, the same space `run.json`'s `aois[].bbox` uses.

A field renamed on either side stops satisfying these types with no compile error in either
package, so the names are binding on both: `tests/types.test.ts` asserts the browser step's
shape against them at compile time.

## The areas of interest, and the regions the DOM does not explain

`buildAois` merges the capture's DOM and accessibility reports of one control into one
area, derives a stable id from the variant, step, role, name and box, and returns the
screen's areas in reading order. The regions the elements leave over come from an injected
`Segmenter`, which is additive by contract: one that returns nothing, returns something
malformed or throws leaves the element-derived areas exactly as they were.

The **default** segmenter is the offline heuristic one, so a cold clone with no credential
and no network builds the areas CI and the demo build. It averages the screenshot onto a
grid of small cells in page space, strikes out every cell that touches an area the elements
already explain, estimates the page background as the most common colour on the grid, and
coalesces the cells that sit far enough from that background into regions of one colour.
Four filters then throw candidates away — under `minAreaShare` or `minSidePx`, under
`minAspectRatio`, or a shape whose rectangle is mostly not the shape — and the largest
`maxRegions` survivors are returned, labelled by where they are and how big they are:
"Bottom left card", not "region-7".

The background estimate is what keeps it honest. A page of plain prose has no ink the
elements did not already explain, so the answer is nothing rather than one area per
paragraph of paper — `tests/heuristic-segmenter.test.ts` asserts that on
`plain-text-control`, and asserts the six cards on `card-grid-unexplained`. It is
deterministic by construction: no draw, no clock, a row-major walk, and a region defined as
the connected set of cells similar to the one it started at, which no traversal order can
change.

`capture.screenshot` is run-directory-relative, so a caller that holds the run directory
builds its own rather than leaning on the default:

```ts
const segmenter = heuristicSegmenter({ runDir });
const aois = await buildAois({ capture, variant, segmenter });
```

`heuristicSegmenter` also takes `config` (layered over the engine defaults, so one
threshold can be moved and no other) and `readImage`, which replaces `sharp` for a caller
that already holds the pixels. Opening the screenshot is the one thing on the segmenter's
side of the purity line: the engine itself still reads no file, and `buildAois` passes the
path along without looking at it. `noSegmenter` asks for element-derived areas only.

## The fixture captures

The step's shared test material: five synthetic captures in `tests/fixtures/`, each a
screenshot plus a capture JSON shaped as the published input above. They are synthetic
rather than browser output because the engine is pure and must run thousands of times
cheaply, and because this step owns its fixtures — nothing here waits on the browser step.
Every later ticket tests against these five pages instead of inventing its own.

| Fixture                     | The property it exists for                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `high-contrast-banner`      | A saturated promotional banner above ordinary text, so bottom-up salience has a target            |
| `below-fold-primary-action` | A tall page whose primary action sits below `foldY`, so the never-fixated case can be produced    |
| `price-and-fees`            | A total, a line price and a service fee for a goal like "find the cheapest option" to pull toward |
| `card-grid-unexplained`     | Image-like cards with no elements reported, so the segmenter has unexplained area                 |
| `plain-text-control`        | Low contrast, evenly spread, no primary action — the null case, no strong preference              |

A test names a fixture and never builds a path:

```ts
const { capture, screenshotPath } = loadFixture('high-contrast-banner');
```

`loadFixture` throws on an unknown name, listing the ones that exist, and
`loadAllFixtures()` returns all five in declaration order. `capture.screenshot` is the
run-directory-relative path the type promises; `screenshotPath` is where the committed
image actually is.

The committed files are compared against the generator on every test run — the capture
JSON field for field, the screenshot pixel for pixel — so they cannot drift from it
unnoticed. Everything a fixture paints lies inside a declared element box, with one
deliberate exception: the card grid, whose ink is the unexplained area the segmenter is
there to partition.

**The fixtures do not draw the fold line.** A real page screenshot carries it
(`docs/FLOW.md` section 8, and the browser step draws it), but a full-width line at `foldY`
is an annotation for a human reader, and painting one into the engine's image input would
feed a strong artificial edge to the salience terms this step is calibrating. The fold is
in the capture as `foldY`, which is what the engine reads it from. A ticket that wants to
know how a drawn fold line changes salience needs a real capture, not these five.

`tests/fixtures.test.ts` asserts the invariants a later ticket should not have to re-check
— boxes inside the page, `belowFold` consistent with `foldY`, element ids unique and the
ones later tickets name, at most one declared primary action — and asserts each fixture's
reason for existing _from the image_, so a salience ticket is testing a real difference:
the banner's mean luminance is more than 60 levels from its surroundings, and the
plain-text page is the most uniform of the five by tile spread.

### Regenerating them

```sh
pnpm -F @personavision/engine fixtures
```

`scripts/make-fixtures.ts` is the generator, and it is deterministic: solid rectangles
painted into a raw buffer, no fonts, no randomness, no metadata and no timestamps in the
PNG. Regenerating leaves the working tree clean, which is what proves the committed bytes
are the generator's output. Add a fixture by adding its name to `tests/fixtures/index.ts`
— the generator keys its specs by that union, so a name without a spec fails to compile.

**Size.** The whole set is **16,960 bytes** (five PNGs, 933–2,208 B each, and five capture
JSON files). The budget is **32 KiB in all**, asserted in `tests/fixtures.test.ts`: these
files are read by every session in the step, so an oversized image costs all of them.

## The credibility harness

The suite that tests the project's _claims_ rather than its parts. Every other suite in
this package tests one term — that salience reads the pixels it says it reads, that the
distributions have the shape they advertise, that the sampler consumes its generator in the
documented order. These two test what the product says out loud, end to end over the
published entry point: a capture goes in, a scanpath comes out, and the properties a
designer would expect hold. They are the suite a change to any term has to keep green.

| File                        | What it holds                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `tests/harness.ts`          | The session-level path the claims are made over, and the shared personas and seeds |
| `tests/behaviour.test.ts`   | One named test per behavioural claim, with its expectation in the test name        |
| `tests/statistical.test.ts` | The shares and medians a _run_ produces, each inside a stated band                 |

**The claims.** A high-contrast banner is among the first three fixations in more than half
the sessions, and takes more of a run's fixations than the low-contrast paragraph below it.
A control below the fold is fixated later than a heading above it — and, for a persona that
never scrolls to it, by no session at all, which the metrics carry through as a `null` and a
`0` rather than a near-zero. A goal that names the total raises the share of fixations on
the total over the same page with an unrelated goal. A scanning persona makes more and
shorter fixations than a reading one on the same page and seed. Two personas reach a
different set of areas on 10 of the 24 seeds and diverge in order on 5, and no seed gives
the two of them the same scanpath.

**What the suite says about the uncalibrated defaults.** The salience preference is real but
_small_: the banner clears a chance baseline of about 0.49 by a session and a half, and its
lead in fixations over the quietest area on the page is 0.02. That is arithmetic, not a
defect — the six salience terms are normalised to 0..1 and averaged, which compresses this
page's range to 0.30 against 0.468, and `alpha` is 1, so one draw is a factor of 1.18. The
suite therefore states each of those claims at the strength the defaults support and proves
the direction with the weight: at `alpha` 0 the banner's lead is gone (−0.01), at 1 it is
+0.02, at 6 it is +0.12. Sharpening it is calibration's (#11) job, and these tests are what
will show it happened.

**Nothing here can flake.** Every claim runs over one fixed set of twenty-four seeds — a
run's worth of sessions — through a sampler whose only randomness is the seed it is handed,
so a share is an exact number on every machine rather than a sample. The bands are
tolerances on _the engine_: each one states the mechanism that puts it where it is and
leaves room for calibration (#11) to refit the weights, so narrowing one is a decision
somebody takes in a diff that says so. Three tests prove the suite is sensitive to what it
tests: raising `beta` raises the share on the area the goal names (0.33 → 0.61), raising
`alpha` widens the banner's lead over the quietest area on its page, and raising `gamma`
pushes a revisit further out (4.40 → 4.87 fixations between two looks at one area).

**Determinism is asserted end to end**, not just in the sampler: a fixed capture, persona,
goal and seed produce byte-identical fixations in this process — with the harness's memo
tables cleared between the two, so the screenshot is decoded and rescored both times — and
in a second process through `tests/session.child.ts`.

**Time budget: 5 seconds** of wall time for the two suites together, measured at **0.7 s**
on a laptop (0.4 s of test time, of which the second process is 0.17 s). The headroom is
there because the cost is seeds × captures: `buildAois`, the screenshot decode and the
salience map are memoised per capture in the harness, so twenty-four sessions decode one
image once, and a claim that needs a new persona pays only for a new salience map.

**Two rules in the harness are the harness's, not the engine's**, and they are stated in
its docblock because a later ticket will move them into the run loop (#44): an area is on a
screen when its box meets the viewport band that screen is scrolled to, and an agent at
least as persistent as the median one (`screenPersistenceScale >= 1`) scrolls the page
through while a hurried one stays on the first screen. The engine does no geometry of its
own and decides no scroll — `sampleFixations` takes "the areas on this screen" — so a
harness that handed it a whole tall page as one screen would be claiming the engine can
fixate pixels nobody has scrolled to.

**No API key and no network.** `buildAois` runs the offline heuristic segmenter, relevance
is lexical and role-based, and the only bytes read are the committed fixtures'. A test in
`behaviour.test.ts` holds that line over the suite's own sources: they import the engine
only through its published entry point, and reach for nothing of the platform but files,
paths and the one child process the determinism check spawns.
