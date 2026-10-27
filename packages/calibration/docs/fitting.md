# Fitting the engine's configuration

The engine's weights are **fitted rather than chosen** (#90). This is the routine that fits them, the objective it
maximises, and the committed file that is its result.

```sh
pnpm --filter @personavision/calibration run fit
```

That one command reproduces `packages/engine/config/calibrated.json` byte for byte. `--check` reports whether the
committed file is that fit without writing anything, and `--seed` / `--candidates` explore without committing.

## The search

A **seeded, bounded random search** over the engine's own configuration object (#56), scored through `score()`
(#88). Not gradient-based — #11 settled that, and there is no gradient to take: the objective runs through a
sampled scanpath and a heuristic segmenter, so a finite-difference estimate would cost more engine passes than the
whole search. Random rather than a grid because the twelve bounded parameters below, at their documented steps,
make **15,378,171,494,400** grid points: a full grid is not a long search but an impossible one, and a
one-parameter-at-a-time sweep is a grid that cannot see an interaction between the softmax weights and the
inhibition terms, which is exactly where one would be expected.

| Parameter | Range | Step | Engine's default |
| --- | --- | --- | --- |
| `alpha` | 0.2 … 3 | 0.2 | 1 |
| `beta` | 0 … 3 | 0.2 | 1 |
| `gamma` | 0 … 3 | 0.2 | 1 |
| `fixationDuration.medianMs` | 150 … 400 | 10 | 250 |
| `fixationDuration.logSigma` | 0.2 … 0.8 | 0.05 | 0.45 |
| `fixationDuration.minMs` | 60 … 140 | 10 | 80 |
| `fixationDuration.maxMs` | 600 … 1600 | 100 | 1200 |
| `inhibitionOfReturn.penalty` | 0 … 4 | 0.25 | 1.5 |
| `inhibitionOfReturn.decayPerFixation` | 0 … 0.95 | 0.05 | 0.5 |
| `inhibitionOfReturn.immediateRepeatAllowance` | 0 … 3 | 1 | 1 |
| `inhibitionOfReturn.deliberateReturnAfterFixations` | 1 … 8 | 1 | 3 |
| `inhibitionOfReturn.deliberateReturnRelevance` | 0 … 1 | 0.1 | 0.6 |

Each parameter's bounds carry their reason in `SEARCH_SPACE` ([`../src/fit/search.ts`](../src/fit/search.ts)), and
every **default is read from `defaultEngineConfig`** rather than restated — a search space that drifted from the
object it searches is refused before the first engine pass. The space is the engine's configuration and nothing
else: no metric parameter and no corpus parameter is reachable from it, which `test/fit.test.ts` asserts in both
directions. Fitting the ruler is not fitting the engine.

**One seed.** It seeds the candidate draw *and* is the prediction seed every candidate is scored at, so "the same
seed and search space" is one statement. The prediction seed is constant across candidates on purpose: two
candidates scored at different seeds would differ by the draw as much as by the configuration.

**Candidate 0 is the engine's defaults**, scored in the same run at the same seed, so the figure the fit had to
beat is measured rather than quoted. A tie keeps the earlier candidate, so a search that finds nothing better
returns the defaults.

## The objective

**The web category's CC plus ScanMatch, equally weighted** — `0.5 · CC + 0.5 · ScanMatch` over the `webpage`
records, never the overall mean. Webpages are what this product is for (#11, user story 8); CC says the predicted
map lands where the humans looked, ScanMatch says it does so in their order. Equal weights because neither is
worth less than the other; #90 allows a different split with a reason, and there is no reason here.

The two figures are not commensurable — CC reaches 1 on this corpus while ScanMatch sits near its chance level of
about 0.4 (#84) — so **the objective is a direction to climb and never a score to quote**. The badge quotes CC, NSS
and ScanMatch themselves (#12, #92). All six metrics travel with the objective at every candidate, so a climb that
cost KLD would be visible rather than hidden inside its own number.

## The committed fit

Seed **1**, **128 drawn candidates** beside the defaults, over the four committed synthetic records (#82).

| | Objective | Web CC | Web ScanMatch |
| --- | --- | --- | --- |
| The engine's defaults | 0.5552 | 0.8887 | 0.2217 |
| **The committed fit** | **0.6555** | **0.8965** | **0.4144** |
| Improvement | **+0.1003** | +0.0078 | +0.1927 |

The best candidate was number 19 of 128; a run at 256 candidates reaches the same value.

### The lower bound binds, and it was honoured over the objective

Two committed values sit on the edge of their range — `fixationDuration.medianMs` at its minimum of 150 and
`fixationDuration.minMs` at its minimum of 60 — so **the bound chose them, not the data**. The file records that
under `fit.atBound`, the command prints it, and `test/fit.test.ts` asserts it, because a search space's edge
passing for a fit would be the quietest way to mislead a reader of this document.

The objective is still climbing when the box stops it. Scored at seed 1 on this corpus, with everything else at the
committed values:

| `fixationDuration.medianMs` | 150 (committed) | 120 | 100 | 80 |
| --- | --- | --- | --- | --- |
| Objective | 0.6555 | 0.7043 | 0.7456 | **0.8056** |

The forgone gain is half again larger than the whole committed improvement. It is forgone deliberately. ScanMatch
is dwell-weighted (#84): a fixation contributes `max(1, round(durationMs / 50))` letters, so shortening every
fixation shortens the predicted letter sequence toward the human one and the figure keeps rising all the way down
to dwells no eye performs. **The objective is degenerate downward**, and the bound is the only thing between it and
a physiologically impossible engine. 150 ms is the lowest median any free-viewing study reports — already below the
published 200–300 ms region — so the committed value is the lowest defensible one rather than the best-scoring one.

Widening the bound downward would be fitting the metric's temporal binning, not the engine. The honest repairs are
elsewhere and belong to later tickets: an objective that is not monotone in dwell, or the real dataset, where a
screenshot's many areas give the search something other than duration to move.

### What moved, and what was handed back

Only three of the twelve searched parameters are committed away from the engine's default:

| Parameter | Default | Fitted |
| --- | --- | --- |
| `fixationDuration.medianMs` | 250 | **150** |
| `fixationDuration.logSigma` | 0.45 | **0.25** |
| `fixationDuration.minMs` | 80 | **60** |

The other nine were **handed back to the engine's default**, because the objective could not tell their drawn value
from it. That is measured, not assumed: after the search, each parameter whose drawn value differs from the default
is returned to the default one at a time and the candidate re-scored; where the objective is *exactly* unchanged,
the default stays. The file records them under `fit.pinnedToDefault`.

This matters for more than tidiness. `beta` is the softmax weight on relevance, and `predict` scores a bare
screenshot with relevance held at the neutral trait (#68), so **no value of `beta` can move this objective** — but
`beta` is very much alive in a goal-driven session. Committing the drawn 2.0 would have changed every run with a
task in it on the strength of a figure that never measured it.

### Why so much of the space is inert on this corpus

On all four committed records the engine's `predict` finds a **single area**, and the scanpath is ten landing
points inside it. With one area to choose from, the softmax weights (`alpha`, `beta`, `gamma`) and every inhibition
term are arithmetically irrelevant — there is nothing to choose between and nothing to inhibit — which is why the
whole improvement comes from the fixation durations. Two things follow, and both are recorded on #90 and #11:

- **A figure fitted here is a figure about four generated pictures.** The real fit is over the downloaded UEyes
  dataset (#85, #86), where a screenshot has many areas and the softmax weights can move.
- **The landing parameters (`landing.spreadShare`, `landing.minInsetPx`) are the ones this corpus could still
  move**, and #90's documented space does not include them. Widening the space is a later ticket's call, not a
  silent change here.

### The figures behind the badge

Measured at seed 1 over the committed synthetic corpus. **These records are synthetic** (#82) — a figure here is
not a published UEyes score.

| Scope | Records | CC | NSS | KLD | AUC-Judd | ScanMatch | Sequence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **webpage** (the objective's scope) | 1 | **0.897** | **2.734** | 2.468 | 0.975 | **0.414** | 0.167 |
| desktop | 1 | 0.753 | 3.348 | 5.391 | 0.969 | 0.424 | 0.150 |
| mobile | 1 | 0.932 | 4.342 | 0.944 | 0.979 | 0.258 | 0.111 |
| poster | 1 | 0.166 | −0.255 | 14.498 | 0.445 | 0.216 | 0.050 |
| overall | 4 | 0.687 | 2.542 | 5.825 | 0.842 | 0.328 | 0.119 |

Against the defaults' own figures ([`scoring.md`](./scoring.md)), **every category improved on every saliency
metric and on ScanMatch**, and KLD fell overall (5.871 → 5.825), which is the direction that metric reads in. The
fit did not buy its web figure at another category's expense.

**Two honest caveats a reader should carry.**

1. **The sequence score did not move** — 0.167 on the web record before and after, and 0.119 overall. #84 says
   what that means: ScanMatch pays for a near miss and for dwell, the sequence score reads order alone. So the fit
   bought its ScanMatch with *dwell*, by shortening fixations, and not by looking at things in a better order. The
   engine is no better at the order of attention than it was.
2. **ScanMatch 0.414 is about chance.** #84 measured chance at 0.3951 for its own documented setup. Against the
   baselines on this corpus the web margins are +0.220 over random fixations and +0.234 over the centre-bias prior,
   which is the number worth reading — not the 0.414 itself.

## The file

`packages/engine/config/calibrated.json` is the seam #56 declared, imported by `packages/engine/src/config.ts` at
**build time**: the engine reads no file and opens no socket at run time. The fitted values and the figures that
earned them live in **one file**, so the badge's number and the configuration behind it can never disagree.

| Field | What it carries |
| --- | --- |
| `weights` | The fitted values, as the engine's own override layer |
| `metrics` | The figures: scope, corpus (with `synthetic`), seed, CC, NSS, KLD, AUC-Judd, ScanMatch, sequence score, and the objective's value |
| `engine.version` | The engine the fit was measured against |
| `fit.space` | Every parameter with its range, step, reason and the engine's default |
| `fit.seed`, `fit.kind`, `fit.candidates` | The search, enough to repeat it |
| `fit.objective` | The objective with its terms and weights |
| `fit.defaults`, `fit.improvement` | What the defaults scored in the same run, and the gain |
| `fit.pinnedToDefault` | The parameters the objective could not see |
| `fit.atBound` | Committed values sitting on the edge of their range, with which bound |
| `fit.enginePasses` | Engine passes the fit made in all, the pin phase included |
| `fit.defaults.overall` | What the defaults scored over the whole corpus, beside `fit.overall` |
| `fit.command` | The one command above |

No timings are written into it: a wall-clock figure would be a fact about a machine and would make every re-fit a
diff. `resolveEngineConfig()` then reports `calibrated: true` with those metrics, and `calibrated: false` with no
metrics at all when the file is absent — the honest source for `docs/FLOW.md`'s "not calibrated" badge state.

## The cost

| | |
| --- | --- |
| The committed fit | **0.78 s** (median of three: 788, 730, 787 ms) for **142** engine passes over the four committed records — 129 candidates and 13 in the pin phase, as `fit.enginePasses` records |
| One engine pass over the corpus | 5–6 ms here; #88 measured 34 ms under parallel load, which is what `SEARCH_COST.estimatedMs` budgets from |
| Machine | Apple M4 Pro, 14 cores, Node 22.20.0, macOS (Darwin 27) |
| Asserted bound | `SEARCH_COST.limitMs` 30 000 ms, about forty times the measurement |

No network and no API key: `test/fit.test.ts` runs a full fit with `fetch` replaced by a throw and every
`*_API_KEY` and `*_TOKEN` removed from the environment.

Over the full downloaded dataset (1,980 screenshots) the same arithmetic puts one pass in the tens of seconds, so a
128-candidate search there is an hour's order rather than a second's — measured there rather than extrapolated,
since a real screenshot is far larger than a 320 × 240 synthetic one.

## Reproducing it

```sh
pnpm --filter @personavision/calibration run fit -- --check   # is the committed file this fit?
# --check takes no --seed or --candidates: it reports on the committed fit and nothing else.
pnpm --filter @personavision/calibration exec vitest run test/fit.test.ts
```

The same seed and search space produce an identical best configuration and objective value — in the same process
and in another one. [`fit.child.ts`](../test/fit.child.ts) is the second process, and `comparableFit(result)` is
the fit as text with the wall-clock timings left out, which is what the determinism tests compare.

## What this does not do

- **It does not fit the metrics.** `SALIENCY_METRIC_PARAMETERS` and `SCANPATH_METRIC_PARAMETERS` are frozen
  committed data and unreachable from the search space (#83, #84).
- **It does not search every leaf of `EngineConfig`.** The salience term weights, the segmenter thresholds, the
  landing parameters and the persona table are fittable in principle; #90's space is the softmax weights, the
  fixation durations and the inhibition terms, and the persona table cannot move this objective at all because
  `predict` has no persona.
- **It does not average over seeds.** One seed, recorded in the file, so two fits can be compared character for
  character.
- **It does not touch the report or the badge.** #89 prints the figures and #92 writes the run artifact's
  calibration block from the surface this file feeds.
