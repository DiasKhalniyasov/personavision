# Scoring a predictor over a corpus

A human-likeness figure is produced in exactly one place in this project: `score()` in
[`../src/score/score.ts`](../src/score/score.ts) (#88). The fit (#90) maximises what it returns, the committed
report (#89) prints it, and the badge the product shows on every screen quotes it by way of the engine's
configuration. So a figure that left here without saying what was compared would be a number nobody can check —
which is why provenance is not optional and a result cannot be built without it.

```ts
import { committedCorpus, enginePredictor, score } from '@personavision/calibration';

const result = await score({
  predictor: enginePredictor(), // the engine's own `predict`, with its version and kernel
  corpus: committedCorpus(), // the four committed synthetic records (#82)
  seed: 1,
  onProgress: ({ message }) => console.log(message), // engine: 1 of 4 records — webpage-bright-hero
  // The counts are per predictor, so a run with two baselines prints three sequences of 1 … 4.
  // A printer that throws — a closed pipe — does not discard figures already measured.
});
```

The predictor under test and both baselines (#87) are scored over the same records through the same `Predictor`
seam, so a reported margin is a margin between comparable numbers.

## What comes back

| Level | Where | What it carries |
| --- | --- | --- |
| Per record | `result.predictor.records` | The six metrics, the humans and human pairs behind them, the human-to-human ceiling, the seed, the display the prediction was made at |
| Per category | `result.predictor.categories.webpage` … | The six metrics averaged, `records`, the ceiling and `ceilingRecords` — or `null` where the corpus holds no record of that category |
| Overall | `result.predictor.overall` | The same, over every scored record, with `records` saying how many |
| Baselines | `result.baselines` | One of the above per baseline, scored on the same records |
| Margins | `result.margins` | The predictor minus each baseline, per category and overall |
| Provenance | `result.provenance` | The corpus identity, the seed, the metric parameters, and the map kernel each predictor drew with |

**A category with no records reports no figure.** `null`, never a zero: no figure and a figure of zero are
different claims, and a zero in a report would be read as a measurement. The overall figure always says how many
records it covers.

**The web category is never folded away.** `webpage` is a category of its own at every level. Webpages are what
this product is for, so a good average over desktop, mobile and poster records cannot hide a bad web result (#11,
user story 8).

**A declared kernel is checked against the map that came back.** A predictor states its normalisation up front —
it is a property of its code, not of one answer — and `score()` compares that statement with every map it
receives. A disagreement stops the run by name: KLD reads a map as a distribution and is not invariant to a
rescaling, so a figure quoted with a kernel that misstates it would be wrong in a way no metric can see. More
generally, a `ScoreError` from inside a sweep is the *run* being wrong and stops it; anything else is one record
being wrong and lands in `failures`.

**A margin is only taken between comparable figures.** Each side of a margin is re-averaged over the records
**both** of them scored, and `records`, `predictorRecords` and `baselineRecords` travel with it; where the two
share no record there is no margin at all, which is `null` rather than a difference between two means over
different material.

**A record that cannot be predicted is named.** `predict` raises rather than degrading on a failure (#68), so a
record whose bytes will not decode, or whose prediction a metric refuses, lands in
`result.predictor.failures` with the reason — and every other record is still scored. The counts then rest on
what was actually measured: a category total that quietly lost a record would be worse than one that says it did.

**The human-to-human ceiling travels with the figures.** It is the same two scanpath metrics over every distinct
pair of participants of a record (#84), reported for every record with more than one human scanpath and `null`
where there is only one. A prediction at 0.22 means something different when the humans agree at 0.72 than when
they agree at 0.09 — and on this corpus both are true, of different records.

## Provenance: no figure without its account of itself

`ScoreResult.provenance` carries the corpus identity (and whether its records are **synthetic**), the seed, the
frozen metric parameters of #83 and #84, and the map kernel of every predictor. Each predictor carries its own
version and, for the engine, whether its resolved configuration was calibrated — `true` since #90 committed
`packages/engine/config/calibrated.json`, and never a fabricated number.

`score()` refuses a predictor or a corpus that does not carry these, by name, at run time as well as in the type:
`test/score.test.ts` asserts that a predictor with no provenance, no version, no calibrated flag or a kernel with
no spread scores nothing at all.

### The kernels differ, and the result says so

Every saliency metric is sensitive to the blur of the map it reads. The engine and the random-fixation baseline
draw at the same kernel — three per cent of the map's longer side, truncated at 3σ, dwell-weighted — so the
engine's margin over the floor is a difference in *where* each one looked. The centre-bias prior is one broad
kernel at a point, a quarter of the image's shorter side and untruncated, because that is what the prior is.

That difference is reported rather than averaged away: `provenance.mapKernelDivergences` names the predictors and
the fields, and on the committed corpus it says

```
engine vs centre-bias-prior: drawnFrom, sigmaShare, sigmaRelativeTo, truncationSigmas, dwellWeightExponent
```

#87 measured what the blur alone is worth (a blur-matched random baseline reaches CC 0.265 on the web record
against 0.590 for the prior), so a sentence about *placement* quotes that column of
[`baselines.md`](./baselines.md) rather than the plain margin below.

## The figures on the committed corpus

> **These are the figures of the engine's *uncalibrated* defaults.** Since #90 committed
> `packages/engine/config/calibrated.json`, `enginePredictor()` resolves the fitted configuration, so a run of
> `score()` today reports the fitted figures — web CC 0.897 and ScanMatch 0.414, overall CC 0.687. The table below
> is kept as the defaults' figures, which is what the fit was measured against;
> [`fitting.md`](./fitting.md) carries the fitted ones and the comparison.

Measured at **seed 1** over the four committed synthetic records. **These records are synthetic** — generated
rectangles and blobs in UEyes shape (#82) — so a figure here is a figure about four pictures and **not a
published UEyes score**. A comparable number comes from a local run against the downloaded dataset (#85, #86).

| Predictor | Scope | Records | CC | NSS | KLD | AUC-Judd | ScanMatch | Sequence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Engine | webpage | 1 | 0.889 | 2.644 | 2.480 | 0.975 | 0.222 | 0.167 |
| Engine | desktop | 1 | 0.718 | 3.296 | 5.474 | 0.964 | 0.247 | 0.150 |
| Engine | mobile | 1 | 0.924 | 3.822 | 0.974 | 0.969 | 0.138 | 0.111 |
| Engine | poster | 1 | 0.142 | −0.246 | 14.556 | 0.444 | 0.128 | 0.050 |
| **Engine** | **overall** | **4** | **0.668** | **2.379** | **5.871** | **0.838** | **0.184** | **0.119** |
| Centre-bias prior | overall | 4 | 0.560 | 1.043 | 0.843 | 0.746 | 0.146 | 0.000 |
| Random fixations | overall | 4 | −0.058 | −0.372 | 18.320 | 0.406 | 0.144 | 0.000 |
| Human-to-human ceiling | overall | 3 | — | — | — | — | 0.504 | 0.222 |

### Margins, whichever way they fall

| Baseline | Scope | CC | NSS | KLD | AUC-Judd | ScanMatch | Sequence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Random fixations | webpage | +0.923 | +3.009 | −10.767 | +0.406 | +0.028 | +0.167 |
| Random fixations | overall | +0.726 | +2.750 | −12.449 | +0.432 | +0.040 | +0.119 |
| Centre-bias prior | webpage | +0.298 | +0.938 | +1.511 | +0.083 | +0.041 | +0.167 |
| Centre-bias prior | poster | **−0.719** | −0.154 | +14.122 | −0.012 | +0.022 | +0.050 |
| Centre-bias prior | overall | +0.108 | +1.336 | +5.028 | +0.092 | +0.038 | +0.119 |

A **positive** margin is better for CC, NSS, AUC-Judd, ScanMatch and the sequence score; a **negative** one is
better for KLD, which is lower-is-better. Three things in that table are worth reading rather than averaging:

- **The floor is cleared on both of the metrics #88 names.** The engine beats uniform noise on CC and on
  ScanMatch in every category and overall. That is a floor, not a result (#87).
- **The prior wins on the poster record, by a lot.** `poster-uniform-field` is a diffuse human map over a flat
  field, and a broad centre blob fits it better than anything the engine finds there: CC −0.719. A negative margin
  is a reported result and not a test failure, and the per-category counts are what keep it from disappearing into
  the overall +0.108.
- **The engine is worse than the prior on KLD, overall.** +5.028 where lower is better. KLD reads both maps as
  distributions and punishes a confident map for the mass it put where the humans put none — the engine's map is
  ten tight blobs and the prior's is one broad field. It is the metric the fit (#90) should watch while it raises
  CC, and it is the reason the six figures are reported side by side rather than summarised into one.
- **ScanMatch is near chance for everything on this corpus.** #84 measured chance at about 0.40 for its own
  documented setup and the baselines sit at 0.146 here; the ceiling is 0.504. The engine's 0.184 is above both
  baselines and well under the humans, which is the honest reading. The sequence score separates them more
  cleanly: 0.119 against 0.000 for both baselines, because neither baseline has any order logic at all.

## Reproducibility

The same corpus, predictor and seed produce identical figures — in the same process and in another one.
`score()` reads no clock for a figure, draws no number of its own and opens no socket; the seed reaches `predict`
unchanged, and `comparableFigures(result)` is the result as text with the wall-clock timings left out, which is
what the determinism test compares. [`score.child.ts`](../test/score.child.ts) is the second process.

A different seed moves what a seed decides: the random baseline's fixations, and the engine's sampled scanpath.

## The time budget

`SCORING_BUDGET` is committed data, so #90 can estimate the cost of a search from it rather than guessing.

| | |
| --- | --- |
| Full run: the engine and both baselines over the four committed records | **41 ms** (median of fifteen on a loaded machine; 24 ms on a quiet one, 19 ms at the fastest, 282 ms on a process's first run, which pays `sharp`'s warm-up) |
| One engine pass over the corpus, without the baselines | **34 ms** (18 ms at the fastest) |
| Machine | Apple M4 Pro, 14 cores, Node 22.20.0, macOS (Darwin 27), with several other agent sessions running |
| Asserted bound | `limitMs` 4 000 ms — about a hundred times the measurement |

The spread between 19 ms and 41 ms is machine load, not the code, which is why the bound is a hundred times the
figure rather than twice it: the suite runs beside several others, and a tight figure would be a test about the
machine. What it still catches is a change of a different order — an image decoded once per metric, or a predictor
called once per human.

**What this means for the fit.** A search of `n` candidates costs about `n × 34 ms` over this corpus, so two
hundred candidates is about seven seconds of scoring. Over the full downloaded dataset (1,980 screenshots) the
same arithmetic puts one pass in the tens of seconds, which is the order #90 should plan its search against —
measured there rather than extrapolated, since a real screenshot is far larger than a 320 × 240 synthetic one.

To repeat the measurement:

```sh
pnpm --filter @personavision/calibration exec vitest run test/score.test.ts
```

The run prints nothing by itself; `onProgress` is what a person reads during a longer one, and #91's CLI passes a
printer to it.

## What this does not do

- **It does not average the two scanpath metrics**, or any two metrics. #84 explains what their disagreement
  means; a single blended figure would throw that away.
- **It does not average over seeds.** One seed, named in the provenance, so two runs can be compared character
  for character. #87's own table is a mean over the seeds 1–8; a caller who wants that averages several runs.
- **It does not choose an objective.** The web category's CC plus ScanMatch is #90's objective, recorded with its
  weights where the fit lives — the scoring reports every figure and takes no view of which one matters.
- **It does not fit the ruler.** `SALIENCY_METRIC_PARAMETERS` and `SCANPATH_METRIC_PARAMETERS` travel as
  provenance and are frozen; the engine is what gets fitted (#11).
