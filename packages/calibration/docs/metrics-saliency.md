# The saliency metrics: CC, NSS, KLD and AUC-Judd

Four numbers that say how closely a predicted saliency map resembles a human one. They are the location half of
step #11's human-likeness figure — the order half is [`metrics-scanpath.md`](./metrics-scanpath.md) (#84) — and they
are what makes the badge the product shows a measurement rather than a decoration.

Everything here is implemented in TypeScript in [`../src/metrics/saliency.ts`](../src/metrics/saliency.ts) and
asserted in [`../test/metrics-saliency.test.ts`](../test/metrics-saliency.test.ts). **No Python sidecar was needed.**
#11 allows one, confined to this package, for a metric that proves costly to reproduce faithfully; none of these four
did, so nothing here leaves the main build, the demo or CI, and the route is recorded on #83 and #11 as that ticket
requires.

## The four at a glance

| Metric | Reads | Direction | Best | Worst | Chance | What it means |
| --- | --- | --- | --- | --- | --- | --- |
| **CC** | two maps | higher is better | `1` | `-1` | `0` | How strongly the two maps vary together, cell for cell. |
| **NSS** | map + fixations | higher is better | *unbounded* | *unbounded* | `0` | How many standard deviations above its own mean the prediction sits where the humans looked. |
| **KLD** | two maps | **lower is better** | `0` | *unbounded* | *not one number* | How many nats are lost reading the human distribution as the predicted one. |
| **AUC-Judd** | map + fixations | higher is better | `1` | `0` | `0.5` | The chance the prediction ranks a fixated cell above an unfixated one. |

Those columns are **data, not prose**: every one of them is a field on `SALIENCY_METRICS[id]`, so #88 and #89 cannot
print a figure without knowing which way it reads. KLD is the one metric that reads downwards, which is exactly the
mistake the `direction` field exists to prevent.

`chance` is what an *uninformative* prediction scores — a finite prediction with no variation at all, which expresses
no preference. It is `null` for KLD because a flat prediction is a perfectly good uniform distribution, and the
divergence of the humans from it depends on the humans' own spread rather than being one constant.

## What is compared, and at what resolution

**Geometry is image space**, as [`../src/types.ts`](../src/types.ts) fixes it: the origin is the image's top-left
pixel, `x` runs right, `y` runs down, and cell `(x, y)` of a map is `values[y * width + x]`. This is not the run
artifact's page space, and the two are never mixed.

| Metric | Compared at |
| --- | --- |
| CC, KLD | the **ground truth's grid**. A prediction at a different resolution is resampled onto it; the humans' map is never moved. |
| NSS, AUC-Judd | the **prediction's own grid**. These read the human *fixations*, not the human map, so there is no second grid to reconcile. |

### The one rule for a resolution or aspect mismatch

Three cases, and the code takes exactly one branch per case:

1. **The two maps describe images of different sizes** → refused, with a `SaliencyMetricError` saying the two "are
   not about the same picture". A prediction of a 640 × 480 image is not evidence about a 320 × 240 one.
2. **Same image, same grid shape, different resolution** → the **prediction is resampled** onto the ground truth's
   grid by an exact area-weighted mean, and then put back into the normalisation it declares. "Same shape" means the
   two grids' aspect ratios agree within `gridAspectTolerance`, 1%: a 4:3 image carries a 16 × 12 grid exactly and a
   37 × 28 one to within 0.89%, which passes, while a 21 × 16 grid is 1.56% off and is refused.
3. **Same image, different grid shape** → refused, with both grids named in the message. A 2 × 2 prediction and a
   2 × 8 ground truth are two different pictures of one image, and squeezing one onto the other produces a number
   about neither.

The test asserts all three, and asserts the resample is exact where it can be: a prediction that is the human map
with every cell split into four scores `cc = 1` and `kld = 0` after resampling, because the two really are the same
distribution at two resolutions.

Averaging rather than summing when resampling cannot move any figure here — CC and NSS are invariant to a positive
affine rescaling, AUC-Judd to any monotone one, and KLD renormalises both maps before reading them — so it is chosen
for the reason that reads best: a saliency map is a field over the image, and a field resampled coarser is an
average, not a total.

### Normalisation

A map carries the rule its values obey (`sum-to-one`, `peak-to-one`, `none`), which is the auto-decision on #81.
Three of the four metrics are invariant to it and read the values exactly as given. **KLD is not**, because it reads
both maps as distributions, so it converts both to sum to one first whatever they declare. That conversion is the
whole reason the field exists.

### A fixation to a cell

By `SaliencyMap`'s own rule: `(floor(x · width / imageWidth), floor(y · height / imageHeight))`.

- The image's **right and bottom edges are inclusive**: a fixation at exactly `imageWidth` falls in the last column
  rather than failing, because a converter reporting a boundary pixel is not wrong about where the human looked.
- Anything **strictly outside** the image is refused by name, with the fixation's index and its coordinates. A
  fixation off the image is a conversion defect, and clamping it would hide the defect behind a plausible number.
- A cell counts **once** however many fixations or participants landed in it. That is the published convention — the
  MIT benchmark's NSS and AUC-Judd read a binary fixation map — so a figure from here is comparable with one from
  there. Dwell is deliberately not weighted: how long and in what order the humans looked is what the scanpath
  metrics measure (#84), and smuggling duration into a saliency figure would make it a different quantity under a
  published name.
- A record's participants are **pooled** by `poolFixations`, in the order the dataset lists them, because the human
  map is an aggregate and the fixations it is scored against are too.

## Degenerate inputs: a documented value, or a named error

No `NaN` and no `Infinity` escapes any metric. Either a documented number comes back, or a `SaliencyMetricError`
names the reason. The test walks this whole table, and then sweeps every metric over every degenerate map and
fixation set asserting that each call returns a finite number or raises a named error.

| Input | CC | NSS | KLD | AUC-Judd |
| --- | --- | --- | --- | --- |
| **An all-zero prediction** | `0` | `0` | **refused** — not a distribution | `0.5` |
| **A flat non-zero prediction** | `0` | `0` | a number: a uniform distribution is legitimate | `0.5` |
| **A human map that is all zero** | `0` | — | **refused** | — |
| **An empty map** (no cells) | **refused** | **refused** | **refused** | **refused** |
| **A malformed map** (wrong value count, a `NaN`, a negative cell, a fractional grid, a zero-sized image) | **refused** at the offending field | ← | ← | ← |
| **One human fixation** | — | ordinary | — | ordinary |
| **No human fixation at all** | — | **refused** | — | **refused** |
| **Every cell fixated** | — | ordinary (lands near `0`) | — | **refused**: no negative to rank against |
| **A fixation outside the image** | — | **refused**, naming index and coordinates | — | **refused** |

Two of those deserve their reasons written out.

**Why a flat map scores `0` rather than failing.** A prediction with no variation has no deviation to correlate and
nothing to standardise. Returning `0` — which is also what chance returns — says the true thing: a flat field
expresses no preference, so it can share none. The consequence worth knowing is that **two identical flat maps score
`0` for CC and not `1`**: identity is the maximum only for a map that has something to agree about.

The flat case is detected by comparing the cells bit for bit, not by testing whether the variance came out exactly
zero. A mean accumulated over many cells need not land exactly on the value they all hold — twelve cells of `0.4` sum
to `4.800000000000001`, whose twelfth is `0.4000000000000001` — and dividing by a variance of a few times 10⁻³² would
turn a map that expresses nothing into a confident one.

**Why KLD refuses an all-zero map instead of returning infinity.** A map whose cells sum to zero cannot be made into
a distribution. The divergence is conceptually unbounded there, and the ticket forbids an `Infinity` escaping, so the
honest answer is a named error rather than a fabricated large number. A prediction that merely *misses* mass the
humans put somewhere is a different case and is scored: the epsilon bounds that term at about `P · ln(P / eps)` ≈ 18
nats a cell instead of letting it diverge.

## The direction and the epsilon of KLD

`KLD = Σᵢ Pᵢ · log((Pᵢ + ε) / (Qᵢ + ε))`, with **`P` the humans and `Q` the prediction**, both read as distributions.

The direction is the published one: the humans are the reference, so mass the prediction **missed** costs it, and
mass it added where the humans put none costs it nothing. It is not symmetric — `kld(a, b)` and `kld(b, a)` are
different numbers, and the test asserts both of them against hand arithmetic so the asymmetry is on the record.

`ε` is `SALIENCY_METRIC_PARAMETERS.kldEpsilon` = `Number.EPSILON` = `2.220446049250313e-16`, which is exactly
MATLAB's `eps` and so exactly the constant the published `KLdiv.m` uses. It guards both the ratio and its logarithm.

The result is **clamped at zero from below**, because the divergence cannot be negative and the epsilon can carry the
sum a few times 10⁻¹⁵ beneath it. So an identical prediction returns exactly `0`, which is the documented minimum.

## AUC-Judd's negative sampling, and where it leaves the published code

**The negatives are exhaustive: every cell of the prediction that holds no human fixation.** Nothing is sampled, so
nothing needs a seed, which is a large part of why the figure is identical across runs. (AUC-Borji is the variant
that samples its negatives. It is not this metric and is not implemented here.)

The score is computed as the **normalised Mann–Whitney U statistic**: the share of (fixated, unfixated) pairs the
prediction ranks the right way, counting a pair it scores equally as **half a win**. That is the area under the ROC
curve — their equivalence is Hanley and McNeil (1982) — and the test asserts it against a full textbook ROC sweep
over every distinct threshold, on a tie-free input, a tied one and a flat one.

This is where the implementation parts company with the published `AUC_Judd.m`, in two ways, both asserted in the
test:

- **Ties.** That file plants its thresholds at the fixated cells' values and relies on a little **random jitter**
  added to the map when it holds too few distinct values. Without the jitter its sweep puts a false-positive rate
  above 1 at the first threshold and its area collapses to `0` on a flat map, which is wrong — chance is `0.5`. Half
  credit gets `0.5` with no randomness at all.
- **Coarseness.** Because it only plants a vertex where a fixation lies, it interpolates straight across whatever
  negatives fall between two fixations, reading a trapezoid where the curve is a step. It therefore **over-estimates**
  the area by `Σ Δfp · Δtp / 2`, which with `k` fixations is at most `1 / (2k)`. On the test's 12-cell map with three
  fixations the bound is `1/6` and the sweep is `0.0926` high; on a 1,200-cell map with sixty fixations — the density
  that code is actually used at — the bound falls to `1/120` and the two agree inside it. The implementation computes
  the area exactly instead of approaching it.

## Published references

The definitions followed here are the MIT saliency benchmark's:

- Z. Bylinskii, T. Judd, A. Oliva, A. Torralba and F. Durand, *What do different evaluation metrics tell us about
  saliency models?*, IEEE TPAMI 41(3):740–757, 2019 — [arXiv:1604.03605](https://arxiv.org/abs/1604.03605).
- The same group's reference implementations, `code_forMetrics`: `CC.m`, `NSS.m`, `KLdiv.m`, `AUC_Judd.m` —
  <https://github.com/cvzoya/saliency>.
- J. A. Hanley and B. J. McNeil, *The meaning and use of the area under a receiver operating characteristic (ROC)
  curve*, Radiology 143(1):29–36, 1982, for the ROC-area and Mann–Whitney U equivalence AUC-Judd is computed by.

`describe('the published formulations')` in the test **re-derives each of those four expressions from the published
definition, in the test file and without calling the implementation**, and asserts the two agree to twelve decimal
places. That is the reference pairing: a figure here is the published quantity, computed twice by different code.
The published chance levels and bounds are asserted alongside it — AUC `0.5` at chance and `1` at best, CC `1` at
identity and `0` for an uninformative prediction, KLD `0` at identity, NSS `0` at chance and no upper bound.

A number comparable with a *published score* is a different thing again, and needs the real dataset: see
[`corpus.md`](./corpus.md) on why a figure measured on the committed synthetic corpus is not a UEyes score.

## What these metrics cannot see

They are **blind to order**. All four read where the humans looked and none reads the sequence, so reversing every
participant's scanpath on `desktop-two-panels` leaves all four figures bit-identical — which the test asserts, as the
documented blindness rather than a defect. Order is #84's measurement, and that is why the step reports both.

They are also, honestly, **blind where there is nothing to see**. Scoring a record's own human map against its own
human fixations gives `cc = 1` and `kld = 0` on every committed record, but NSS and AUC-Judd come out at about chance
on `poster-uniform-field` (`-0.011` and `0.489`), because that record is deliberately the flattest of the four and a
perfect prediction has nothing to find in it. The test asserts that too. It is the reason #88 must report the number
of records behind every figure instead of one average.

## The parameters, and who may change them

Every number and rule these metrics are decided by is committed data on `SALIENCY_METRIC_PARAMETERS`, frozen, with
its reason in the code beside it:

| Parameter | Value |
| --- | --- |
| `kldEpsilon` | `Number.EPSILON` — MATLAB's `eps`, as `KLdiv.m` uses |
| `gridAspectTolerance` | `0.01` |
| `resolutionRule` | `resample-prediction-onto-ground-truth` |
| `resampleKernel` | `area-weighted-mean` |
| `aspectRule`, `imageSizeRule` | `reject` |
| `fixationCellRule` | `distinct-cells` |
| `fixationEdgeRule` | `inclusive-upper-edge` |
| `aucNegatives` | `every-cell-without-a-human-fixation` |
| `aucTieRule` | `half-credit` |
| `nssStandardDeviation` | `sample` — dividing by `n − 1`, as `NSS.m` does |
| `kldNonNegativeClamp` | `true` |

That object is the surface #88 carries as provenance, so no figure is quoted without saying what produced it. It is
**not** part of any fitting search space: the auto-decision on #11 commits the project to fitting the engine and
never the ruler.

## Cost

Pure and deterministic: no clock, no randomness, no filesystem, no network, no API key. The same inputs give the
identical number twice, down to the last bit, and the inputs are never mutated — the test asserts all three.

**The measured budget**, on 2026-10-26: the 63 tests of `test/metrics-saliency.test.ts` run in **96–132 ms** of
vitest-reported duration (of which about 55 ms is the tests themselves), or **0.35–0.42 s** of wall clock including
process start, over three consecutive runs. Measured on an **Apple M4 Pro, 14 cores, Node 22.20.0, macOS (Darwin
27.0.0)**. The heaviest single case is the 1,200-cell convergence check against `AUC_Judd.m`'s sweep, which is
quadratic in the cell count by construction; the metrics themselves are `O(n)` apart from AUC-Judd's `O(n log n)`
sort of the negatives.
