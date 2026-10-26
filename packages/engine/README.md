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
  applies `fixationCountScale` only; `screenPersistenceScale` is spent on the decision to
  leave a screen, not on the count drawn here.
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
