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
