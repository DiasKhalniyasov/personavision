# The baselines: the centre-bias prior and random fixations

A similarity figure with nothing beside it is decoration. A reviewer's first question about a human-likeness number
is "what does a centre prior get?", and the second is "what does chance get?" — so step #11 reports two baselines
beside every figure the engine scores (#87), measured on the same records, through the same seam, with maps drawn by
the same function.

Both live in [`../src/baselines/`](../src/baselines/) and are asserted in
[`../test/baselines.test.ts`](../test/baselines.test.ts). Both satisfy the `Predictor` seam `src/types.ts` declares —
an image and a seed in, a saliency map and a scanpath out — so #88 scores the engine, the prior and uniform noise
with one piece of code and a reported margin is a margin between comparable numbers. Neither reads a pixel of the
image it is handed, and neither imports `packages/engine`.

## The two at a glance

| Baseline | What it is | Evidence of | **Not** evidence of |
| --- | --- | --- | --- |
| **Random fixations** | Fixations drawn uniformly over the image | That a predictor is doing *something* | Anything else. Beating it is a **floor**, not a result |
| **Centre-bias prior** | A Gaussian over the image, peaked a little above the middle | That a predictor found structure beyond where pictures usually get looked at | The order attention was paid in, and not a ceiling either |

**Beating the random baseline is a floor, not a result.** A predictor that cannot beat uniform noise is broken; one
that beats it has shown only that it found structure of some kind. The random baseline is also what *measures*
chance for the metrics that have no analytic chance level: #84 states that ScanMatch's chance depends on the grid,
on the two scanpath lengths and on how far apart the regions a human visited are, rather than being one constant the
way AUC-Judd's `0.5` is.

**The margin over the centre-bias prior is the number a sceptical reader wants.** Human gaze on a user interface is
strongly centre- and top-biased whatever the interface shows, so a predictor that knows only "look near the middle,
a little above it" already scores well on every saliency metric. That is exactly why it is hard to beat and worth
reporting — and a negative margin against it is a reported result, not a test failure (#88 carries that criterion).

**Neither one is a ceiling.** The ceiling is the human-to-human agreement #84 reports for every record with more
than one participant, and #88 prints it beside both baselines.

## What they score on the committed corpus

Measured on the four synthetic records of the committed corpus (#82) as the mean over the seeds 1–8. These are the
figures #88 reports against; they are measured on **synthetic** records, as every CI figure in this step is.

| Record | Category | CC: prior | CC: random | ScanMatch: prior | ScanMatch: random |
| --- | --- | --- | --- | --- | --- |
| `webpage-bright-hero` | webpage | 0.590 | −0.026 | 0.203 | 0.176 |
| `desktop-two-panels` | desktop | 0.232 | 0.088 | 0.212 | 0.186 |
| `mobile-single-fixation` | mobile | 0.559 | −0.008 | 0.117 | 0.106 |
| `poster-uniform-field` | poster | 0.861 | 0.071 | 0.131 | 0.123 |

Two things a reader should take from that table. The prior beats uniform noise on **where** attention lands by half
a correlation point or more on three of the four records, which is the gap an engine has to clear to have said
anything. And on **order** the two are within hundredths of each other: neither baseline has any sequence logic —
each fixation is drawn independently of the one before it — so a ScanMatch figure a little above the prior's is not
evidence that a predictor got the order right. The scanpath half of the figure is only worth quoting against the
human-to-human ceiling.

## The map-rendering function

One function, in [`../src/baselines/render-map.ts`](../src/baselines/render-map.ts): **fixations in, saliency map
out**. Both baselines render through it, and #88 reports the kernel behind every figure as provenance.

| Convention | What `renderSaliencyMap` answers |
| --- | --- |
| Resolution | `round(imageWidth / cellPx)` × `round(imageHeight / cellPx)` cells, at least one of each: the image downscaled by `cellPx`, **10 image pixels** a cell on the defaults |
| Coordinates | Row-major image space: cell `(x, y)` is `values[y · width + x]`, cell `(0, 0)` is the image's top-left corner, `x` right and `y` down, a cell's kernel measured from its centre at half a cell |
| Kernel | An isotropic 2-D Gaussian per fixation, standard deviation `kernelSigmaShare` — **0.03** — of the map's longer side in cells, truncated at `kernelRadiusSigmas` (3) |
| Fixation weight | The dwell raised to `dwellWeightExponent` — 1 is dwell-weighted, 0 counts fixations |
| Normalisation | **`sum-to-one`**: the values sum to 1, every one finite and non-negative, so the map is a distribution over the image's cells |

The sides are rounded independently, so a map's shape agrees with its image's to within one cell — which is what
keeps a comparison inside the one-per-cent grid-shape tolerance #83's metrics refuse a pair outside of. Mass that
the truncation or the image's edge drops is absorbed by the normalisation. A map with no mass at all — no fixations,
or every weight zero — comes back **uniform**: still a distribution, and still honest about having found no
structure. A fixation strictly outside the image is refused by name, as this package's metrics refuse one.

### The correspondence with the engine's own map (#68)

Every value above is the value `packages/engine`'s `prediction.map` carries on its defaults, as
`packages/engine/README.md` documents them: `cellPx` 10, `kernelSigmaShare` 0.03, `kernelRadiusSigmas` 3,
`dwellWeightExponent` 1, `sum-to-one`, row-major image space. **The correspondence is stated here because it cannot
be stated in code:** this package may not import `packages/engine` — the dependency runs one way and
`test/dependency-direction.test.ts` asserts it — so the two sides are held together by the table above, by
`MAP_RENDERING`'s own doc comments, and by a test that reads this file.

Nothing in the engine's documented map diverges from it, so #87's "say so on #11 and #87 rather than quietly
choosing one" clause has nothing to report. The engine's numbers are leaves of `EngineConfig.prediction.map` that
#90 may fit; the ones here are frozen data that no fit may reach, because #11 settled that the fit moves the engine
and never the ruler. A change on either side is a change to both.

## The centre-bias prior

| Parameter | Value | Why it is what it is |
| --- | --- | --- |
| `centreXShare` | 0.5 | A user interface is laid out about its vertical axis — a centred column, a centred hero, a symmetric pair of panels — so there is no evidence for a left or right bias across the four categories UEyes covers |
| `centreYShare` | 0.42 | The peak sits a twelfth of the height above the middle. Gaze on a screen is top-biased: reading order starts at the top, navigation and hero live there, and the lower part of a tall screenshot is often never reached. Enough of a shift to carry that, small enough that the prior stays a *centre* prior |
| `spreadShare` | 0.25 | The standard deviation, a quarter of the image's **shorter** side — the spread the saliency benchmarks publish their centre baselines at. Isotropic in image pixels, because the spread of human gaze is a span of visual angle; measured against the shorter side so it stays a blob on any aspect ratio rather than a horizontal band on a phone screenshot |
| `truncation` | `whole-map` | Not truncated at all: every cell gets mass. A zero cell under a human fixation is a hole in a distribution rather than a low score — KLD reads it as one — and a baseline should lose on where it put its mass, never on having none |

The prior is **the same Gaussian machinery at a wider setting**, not a second way of drawing a map: it is one point
at the prior's centre rendered by the map-rendering function with the prior's own spread as that point's kernel. So
its resolution, coordinate convention and normalisation are the ones in the table above. Measured: 0.42 of the mass
lies within one standard deviation of the peak and 0.91 within two — a little above a Gaussian's 0.39 and 0.86,
because the tails that fall off the image are renormalised away.

`centreYShare` is a documented choice from the layout literature and **not** a value fitted to UEyes. Fitting a
baseline to the dataset it is a baseline for would make the margin over it meaningless.

**The scanpath drawn from it.** A fixation is drawn by inverse transform over the prior's cells — the map sums to 1,
so one uniform draw walked against the running total picks a cell with exactly the prior's probability — and then
placed uniformly inside the cell it picked, so a drawn scanpath is not a lattice a binning metric would see instead
of the prior. Three draws per fixation, in that order. The map does not move with the seed; only the scanpath does.

## The random-fixation baseline

Fixations drawn uniformly over the image's pixels: `x` is `random() · width`, so it lies on `[0, width)` and every
fixation is strictly inside the image. Every position is drawn before any dwell, so the two are separable in a seed.
Its map is the fixations spread by the kernel above rather than a flat field — a flat map is a different baseline
(chance for AUC-Judd by construction) and would not answer "what does a predictor that looks in the wrong places
score?", which is the question this one exists for.

**Seeded** through the contract's `createSeededRandom`, as everything in this project samples: mulberry32, 32-bit
integer arithmetic, no floating-point drift between platforms. The same seed gives byte-identical fixations in every
process; a different seed gives different ones.

**Uniform, measured.** Over the committed 128 seeds — 1,280 fixations — the four quadrant shares of a 1280 × 1024
image run from 0.2492 to 0.2516, the widest departure from a quarter being 0.0016. That is exact rather than noisy,
because the seed set is committed. `RANDOM_FIXATION_UNIFORMITY.tolerance` is nonetheless 0.05, about four standard
errors of a quadrant share at that many samples: the claim is that the draw is uniform, not that these 128 seeds
are, so it has to survive a change of seed range, while a genuinely skewed draw misses by far more.

## The scanpath shape both baselines share

Committed data in `BASELINE_SCANPATH`, shared by both baselines **on purpose**: the prior differs from uniform noise
only in *where* its fixations land, so the margin between the two is a spatial result and not a difference in how
long either one looked or how many times.

| Parameter | Value | Why |
| --- | --- | --- |
| `fixations` | 10 | At the dwell below plus a saccade, about three seconds of free viewing — the middle of the three cuts UEyes publishes (1 s, 3 s, 7 s) and the one three of the committed corpus's four records state. The seam is `(image, seed)` and never sees a record's `viewingDurationSeconds`, so the count is committed with the viewing duration it stands for; #88 reports it as provenance |
| `duration` | log-normal, median 250 ms, log σ 0.45, clamped to 80–1200 ms | The family fixation durations are published in, with the numbers `packages/engine`'s `fixationDuration` defaults carry. Shared with the engine so a margin over a baseline is a difference in where each one looked, not in how long it dwelled |
| `saccadeMs` | 40 | The middle of the 30–50 ms a saccade across a screen-sized image takes. It sets `tMs` and nothing else: neither the saliency metrics nor the scanpath metrics read a fixation's onset, they read its position and its dwell |

Measured over 320 dwells: a sample median of 256 ms for uniform noise and 267 ms for the prior — the same
distribution sampled in a different order — with the minimum at the 80 ms clamp and the largest draw at 914 ms.

## Determinism

Everything here is pure: no network, no API key, no filesystem, no clock. A baseline reads the image's size and its
display and never its bytes. The same image and seed give the same prediction in every process and on every
platform, which is what lets #88 report a figure twice and #90 replay a fit exactly.
