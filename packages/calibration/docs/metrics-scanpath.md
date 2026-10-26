# The scanpath metrics: ScanMatch and a sequence score

Two numbers that say whether a predicted scanpath visits the regions a human visited **in the order a human visited
them**. They are the order half of step #11's human-likeness figure — the location half is
[`metrics-saliency.md`](./metrics-saliency.md) (#83) — and they exist because the four saliency metrics cannot see
order at all: `test/metrics-saliency.test.ts` asserts that reversing every participant's scanpath leaves CC, NSS, KLD
and AUC-Judd untouched. A prediction that looks at the right places in the wrong sequence passes all four, and fails
these two.

Everything here is implemented in TypeScript in [`../src/metrics/scanpath.ts`](../src/metrics/scanpath.ts) and
asserted in [`../test/metrics-scanpath.test.ts`](../test/metrics-scanpath.test.ts). **No Python sidecar was needed.**
#11 allows one, confined to this package, for a metric that proves costly to reproduce faithfully; neither of these
two is — both are a grid, an alignment and a division — so nothing here leaves the main build, the demo or CI, and
the route is recorded on #84 and #11 as that ticket requires.

## The two at a glance

| Metric | Reads | Direction | Best | Worst | Chance | What it means |
| --- | --- | --- | --- | --- | --- | --- |
| **ScanMatch** | two scanpaths | higher is better | `1` | `0` | *not one number* | How well the two paths align once each fixation is a letter repeated per bin of dwell. |
| **Sequence score** | two scanpaths | higher is better | `1` | `0` | *not one number* | One minus the edit distance between the two sequences of visited regions. |

Those columns are **data, not prose**: every one is a field on `SCANPATH_METRICS[id]`, the same descriptor shape the
saliency metrics publish, so #88 and #89 print a scanpath figure with the code that prints a saliency one.

`chance` is `null` for both, and deliberately. What an unrelated scanpath scores depends on the grid, on the two
lengths and on how far apart the regions a human actually visited are, so it is not one constant the way AUC-Judd's
`0.5` is. [Chance, measured](#chance-measured) states it for one documented setup instead, and #87's random-fixation
baseline measures it on the corpus the figure is actually quoted from.

## What is compared

Both metrics read the same two things: a grid over the image, and the order the fixations fell into its regions.

**The grid.** `12 × 8` regions over the image, row-major, numbered `row · 12 + column`. The region of a fixation at
image pixel `(x, y)` is `floor(x · 12 / imageWidth) + floor(y · 8 / imageHeight) · 12` — `SaliencyMap`'s own
fixation-to-cell rule at this metric's grid rather than at a map's, including its **inclusive upper edge**: a
fixation at exactly `imageWidth` falls in the last column rather than failing, because a converter that reports a
boundary pixel is not wrong about where the human looked. Anything strictly outside the image is refused by name.

The grid is laid over the **image**, not over a fixed pixel size, so one grid serves a 320 × 240 corpus record and a
1920 × 1080 screenshot alike and a figure does not move when the dataset's resolution does. Geometry is image space
throughout, as `src/types.ts` fixes it: origin top-left, `x` right, `y` down.

**The letters.** ScanMatch writes each fixation as the letter of its region, repeated `max(1, round(durationMs / 50))`
times — once per 50 ms bin of dwell. A 300 ms fixation is six letters, so a three-fixation scanpath at 300 ms each is
an eighteen-letter sequence. The sequence score writes each fixation as its region too, but **collapses consecutive
repeats** and ignores dwell entirely: the same three fixations are the three-region sequence `13 · 54 · 82`.

**The order is the array's order.** `Scanpath.fixations` is ordered, and a scanpath whose `index` values are not
`0, 1, 2 …` in that order is refused rather than scored. These metrics are entirely about order; a converter that
listed a record's fixations out of order would otherwise produce a confident wrong figure.

## ScanMatch

Cristino, Mathôt, Theeuwes and Gilchrist's method, in four steps: bin, letter, align, normalise.

**The substitution matrix.** `score(p, q) = 1 − d(p, q) / (0.5 · dMax)`, where `d` is the Euclidean distance between
the two region centres **in normalised image space** (the unit square) and `dMax` the distance between the two
extreme centres. So the same region scores `1`, regions half the grid's diagonal apart score `0`, and opposite
corners score `−1`. A matrix that only ever rewarded would hand two unrelated scanpaths most of the scale; the
negative half is what the paper's own distance threshold exists to prevent.

**The alignment.** Needleman–Wunsch, global, with a gap contributing `0` — the toolbox's default, and note that it is
what a gap *contributes*, not what it costs. Together with a matrix that crosses zero at half the diagonal that means
a pairing of two fixations further apart than half the image is never made: two gaps at `0` beat one negative
substitution, so distant fixations are left unaligned rather than scored as a bad match. Ties in the traceback are
broken diagonal first, which changes no figure and makes the printed alignment identical on every machine.

**The normalisation.** The alignment score over `max(lengthA, lengthB) · 1`, the lengths being the duration-weighted
ones. An aligned column scores at most `1` and there are at most `min(lengthA, lengthB)` of them, so the figure
cannot exceed `1` and reaches it only for two identical letter sequences; the all-gap alignment scores `0`, so the
figure cannot fall below that either. Both bounds hold **for the committed gap penalty of 0** — a different gap
penalty would move them, which is one of the reasons the parameters are committed data.

`substitutionMaximum` is a unit rather than a knob: the alignment score is linear in the matrix and the divisor
carries the same factor, so scaling the whole matrix leaves the figure and even the chosen alignment unchanged. The
test asserts that invariance.

### A worked example

Three points of a 320 × 240 image, in three regions of the committed grid:

| Point | Pixel | Region | Centre, normalised |
| --- | --- | --- | --- |
| top-left | `(40, 40)` | `13` | `(0.125, 0.1875)` |
| centre | `(160, 120)` | `54` | `(0.5417, 0.5625)` |
| bottom-right | `(280, 200)` | `82` | `(0.875, 0.8125)` |

`dMax = hypot(11/12, 7/8) = 1.267242`, so the matrix crosses zero at `0.633621`:

| Pair | Distance | Substitution |
| --- | --- | --- |
| `13` ↔ `13` | `0` | `1` |
| `13` ↔ `54` | `hypot(5/12, 3/8) = 0.560568` | `0.115295` |
| `54` ↔ `82` | `hypot(4/12, 2/8) = 0.416667` | `0.342404` |
| `13` ↔ `82` | `hypot(9/12, 5/8) = 0.976332` | `−0.540797` |

A human who looked top-left then bottom-right for 50 ms each is the sequence `13 · 82`; a prediction that looked
top-left then at the centre is `13 · 54`. The alignment is two columns — `13` against `13` at `1`, and `54` against
`82` at `0.342404` — because the gapped alternative (match nothing, pay two gaps) scores `1`, less than `1.342404`.
The figure is `1.342404 / 2 = 0.671202`.

## The sequence score

**What it is: a normalised edit distance over the visited-region sequence.** `1 − editDistance(a, b) / max(|a|, |b|)`,
with unit insertion, deletion and substitution costs, over the two region sequences with consecutive repeats
collapsed.

**Why that rather than a published variant.** #84 allows either, and the string-edit comparisons that predate
ScanMatch — and that ScanMatch generalises by replacing their binary match with a distance-weighted matrix — differ
from one another in exactly the places this figure is supposed to be silent: how regions are coded, whether dwell is
weighted, how a near miss is credited. The point of the second number is to be the one a reader can take at face
value: **order agreement alone**, with no dwell weighting and no partial credit. A plain normalised edit distance is
that, it is one line of arithmetic a reviewer can repeat, and it lands in `[0, 1]` with `1` for the same regions in
the same order, so it sits beside ScanMatch without rescaling.

Consecutive repeats collapse because a refixation within one region is a dwell, which this metric does not read. A
region **returned to** after leaving it appears again, so a revisit still counts — `13 · 54 · 13` is three visits.

## Where the two disagree

Both metrics on the same pairs, against a human who looked top-left, centre, bottom-right for 300 ms each:

| Prediction | ScanMatch | Sequence score | Why they differ |
| --- | --- | --- | --- |
| the same scanpath | `1` | `1` | identity, both at the documented maximum |
| the same order, dwelling 350 / 250 / 300 ms | `0.950850` | `1` | ScanMatch reads dwell; the sequence score does not |
| the same order, every dwell doubled | `0.5` | `1` | eighteen letters against thirty-six: half the columns are gaps |
| the same regions reversed | `1/3` | `1/3` | only the middle region survives either comparison |
| the centre fixation moved 30 px, into the next region | `0.956160` | `2/3` | ScanMatch pays for a near miss; the sequence score gives it nothing |

**Read the disagreement, do not average it.** The two numbers are not two estimates of one quantity, and this package
never combines them into one. Two of the rows above are the whole reason both exist:

- **ScanMatch below the sequence score** means the regions and their order agree and the *dwell* does not. The
  doubled-dwell row is the extreme case: a prediction that looks in exactly the right order but lingers twice as long
  scores `0.5` on ScanMatch and `1` on the sequence score. If a fit (#90) ever moves ScanMatch while the sequence
  score stands still, it has changed the engine's fixation durations and not its order of attention.
- **ScanMatch above the sequence score** means a near miss: the prediction's fixations are close to the humans'
  without landing in the same regions. The 30 px row is that case — one region out of three replaced by its
  neighbour costs the sequence score a third of its scale and ScanMatch four hundredths.

A figure quoted alone is therefore ambiguous in a way the pair is not, which is why #88 carries both.

## Several humans per record

A UEyes record has many participants, so one predicted scanpath is scored against several human scanpaths.

**The aggregation is the mean over humans.** `scoreScanpathAgainstHumans` scores the prediction against each
participant's scanpath and averages. Not against one representative human, which would throw away the disagreement
between participants, and **not** at the best-matching human, which would report `1` for a prediction that happens to
resemble one participant out of sixty-two.

**The ceiling travels with the figure.** The same call returns the **human-to-human agreement**: both metrics over
every distinct pair of participants, averaged. A model at `0.5` means something different when the humans agree at
`0.55` than when they agree at `0.9`, and the second number is what makes the first readable. The counts behind both
(`humans`, `humanPairs`) are returned too, so a report can say how much either figure rests on.

For a record with **one** participant there is no pair of humans to agree, so `humanToHuman` is `null`. Reporting `1`
or `0` there would be a claim the record does not make. On the committed corpus,
`mobile-single-fixation` is that record, and `desktop-two-panels` has two participants who walk its panels in
different orders — they agree at `0.705882` on ScanMatch and `1/3` on the sequence score, which is the ceiling a
prediction on that record is read against, not `1`.

## Chance, measured

Neither metric's chance level is a property of the metric alone, so it is stated for one setup, committed as
`SCANPATH_CHANCE`, and asserted: a human who walks between a region on the left and a region on the right of a
320 × 240 image, eight fixations at 300 ms, against eight fixations drawn uniformly over the image from
`createSeededRandom`, over seeds `1 … 32`.

| Metric | Documented level | Tolerance | Measured mean | Range over the 32 seeds |
| --- | --- | --- | --- | --- |
| ScanMatch | `0.4` | `0.05` | `0.3951` | `0.284 … 0.521` |
| Sequence score | `0.01` | `0.03` | `0.0078` | `0 … 0.125` |

**ScanMatch's chance level is high, and that is the metric working as designed.** Its matrix pays for a near miss,
and with 96 regions a random fixation is near *something*, so an unrelated scanpath collects about four tenths of the
scale. A ScanMatch figure is therefore meaningless without the baseline beside it — which is why #87 exists and why
#88 reports a margin over the random baseline rather than a bare score. The sequence score has no such floor: a
random fixation has to land in the very region the human visited to score anything at all, so chance is within a
whisker of zero.

## Degenerate inputs: a documented value, or a named error

| Input | What happens |
| --- | --- |
| a scanpath with **no fixation** | `ScanpathMetricError`, "has no fixation, so there is no order to measure" — nothing is ordered, and the normalisation would divide by zero |
| a **single** fixation | ordinary, not degenerate: `1` against itself, and against the three-region human above, `1/3` on both metrics |
| a fixation **outside the image** | `ScanpathMetricError` naming its position in the scanpath and its coordinates |
| a fixation **exactly on the right or bottom edge** | the last region, by `fixationEdgeRule` |
| a dwell **shorter than half a temporal bin** | kept, as one letter — see the departures below |
| a dwell of `0` ms | one letter; the scanpath keeps its shape |
| a **negative or non-finite** dwell, or a non-finite coordinate | `ScanpathMetricError`, "not a dwell" / "not a point in the image" |
| fixations **out of order** | `ScanpathMetricError` naming the position and the participant |
| an image of **zero or non-finite** size | `ScanpathMetricError`, "not an image a region can be found in" |
| a record with **no human scanpath** | `ScanpathMetricError` from `scoreScanpathAgainstHumans` |

**No `NaN` and no `Infinity` escapes either metric.** Every figure is finite and inside `[0, 1]`, and the test asserts
it over every pair of the degenerate inputs that are scored at all rather than refused.

## Where this departs from the published toolbox

Two departures, both named at the code they affect and asserted in the test:

1. **Distance in normalised image space, not in region indices.** `ScanMatch_CreateSubMatrix` measures the distance
   between two bins in *bin indices*, which calls the neighbour to the right and the neighbour below equally far. A
   region of a 12 × 8 grid is wider than it is tall, so they are not: on the unit square the neighbour below is
   `1/8` away and the neighbour to the right `1/12`. This implementation measures in image space, so a vertical
   displacement is correctly the larger one. The consequence is a slightly stricter metric for vertical scanning,
   which is what UI reading mostly is.
2. **A fixation shorter than half a temporal bin is kept.** The published code rounds the repeat count, so a 20 ms
   fixation becomes no letter at all and vanishes from the scanpath. Here every fixation contributes at least one
   letter (`minimumLettersPerFixation`), because a dropped fixation is a changed scanpath and these metrics are about
   the sequence.

Neither departure introduces randomness. Determinism is a hard requirement of this step — it is what lets #90 replay
a fit — and the whole module is pure: no clock, no randomness, no filesystem, no network, no API key.

## The parameters, and who may change them

Every number and rule these metrics are decided by is committed data on `SCANPATH_METRIC_PARAMETERS`, frozen, with
its reason in the code beside it:

| Parameter | Value | Why that value |
| --- | --- | --- |
| `gridWidth`, `gridHeight` | `12`, `8` | the toolbox's own default; at a normal viewing distance a region of a UI screenshot is about 2° of visual angle, the scale at which two fixations are one look |
| `durationBinMs` | `50` | the toolbox's temporal bin, below the shortest plausible fixation (~100 ms), so an ordinary 300 ms dwell is six letters and the weighting is proportional |
| `minimumLettersPerFixation` | `1` | a fixation is never rounded away |
| `substitutionDistance` | `normalised-image-space-euclidean` | departure 1 above |
| `substitutionZeroFraction` | `0.5` | the matrix crosses zero at half the grid's diagonal, so a distant pairing is penalised rather than rewarded |
| `substitutionMaximum` | `1` | a unit, not a knob: it cancels out of the normalised figure while `gapPenalty` is 0 |
| `gapPenalty` | `0` | the toolbox's default; with the matrix above it means a pairing further apart than half the image is simply not made |
| `tracebackPreference` | `diagonal-then-gap-in-b-then-gap-in-a` | changes no figure; makes the printed alignment reproducible |
| `scanMatchNormalisation` | `max-length-times-substitution-maximum` | puts the figure in `[0, 1]` with `1` only for an identical sequence |
| `sequenceScoreAlphabet` | `the-same-grid-as-scanmatch` | one grid, so the two figures differ only in what they credit |
| `sequenceScoreRepeats` | `collapse-consecutive` | a refixation in place is a dwell, which this metric does not read |
| `sequenceScoreCosts` | `unit-insert-delete-substitute` | no distance credit, no near misses |
| `sequenceScoreNormalisation` | `one-minus-edit-distance-over-max-length` | puts it in `[0, 1]` beside ScanMatch |
| `humanAggregation` | `mean-over-humans` | #84's stated aggregation |
| `humanToHumanAggregation` | `mean-over-distinct-pairs` | the ceiling the prediction is read against |
| `fixationEdgeRule` | `inclusive-upper-edge` | the saliency metrics' own rule |
| `emptyScanpathRule` | `reject` | nothing is ordered |

That object is the surface #88 carries as provenance, so no figure is quoted without saying what produced it. It is
**fixed**: it is **not** part of any fitting search space, because the auto-decision on #11 commits the project to
fitting the engine and never the ruler. #90's search space is `EngineConfig` and nothing else. The test asserts all
three halves of that claim — the parameters are frozen and a write throws, no scoring entry point accepts a
parameter of the caller's own, and no name on this surface appears as a field of the engine's fittable configuration.

## Published references

- Cristino, Mathôt, Theeuwes and Gilchrist, *ScanMatch: a novel method for comparing fixation sequences*, Behavior
  Research Methods 42(3):692–700, 2010, with the MATLAB toolbox published alongside it (`ScanMatch.m`,
  `ScanMatch_CreateSubMatrix.m`). The method, its grid, its temporal binning and its gap value of 0.
- Needleman and Wunsch, *A general method applicable to the search for similarities in the amino acid sequence of two
  proteins*, Journal of Molecular Biology 48(3):443–453, 1970. The alignment ScanMatch borrows from bioinformatics.
- The string-edit tradition ScanMatch generalises — scanpaths coded as region sequences and compared by a normalised
  Levenshtein distance — which the sequence score here implements in its plainest form, deliberately: see the
  reasoning under [The sequence score](#the-sequence-score).

## Cost

Pure and deterministic: no clock, no randomness, no filesystem, no network, no API key. The same inputs give the
identical number twice, down to the last bit, and the inputs are never mutated — the test asserts all three.

**The measured budget**, on 2026-10-27: the 46 tests of `test/metrics-scanpath.test.ts` run in **120–127 ms** of
vitest-reported duration (of which about 27 ms is the tests themselves), or **0.38–0.40 s** of wall clock including
process start, over three consecutive runs. Measured on an **Apple M4 Pro, 14 cores, Node 22.20.0, macOS (Darwin
27.0.0)**.

Both metrics are `O(n · m)` in the two letter counts: the Needleman–Wunsch table is kept whole for the traceback, and
the edit distance keeps one row. A seven-second UEyes scanpath of twenty fixations is about 120 letters, so the
table is 120 × 120 — microseconds. The 96 × 96 substitution matrix is built once, when the module loads. If a longer
corpus ever makes the table matter, Hirschberg's linear-space variant computes the same alignment.
