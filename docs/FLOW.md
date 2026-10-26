# PersonaVision — flow contract

This file and `docs/design/prototype.html` are the design contract for the whole project.
Every ticket that touches a screen, a route, a number or a word the user reads builds against them.
`docs/design/tokens.css` is the single source of visual truth; screens import it instead of restating values.

**Source of the answers.** The flow questions were asked on issue #1 (comment marked `stroika:flow-questions`).
The owner did not reply before this session ran, so **all seven answers below are the recommendations I made, taken as written**.
Every one is tagged **(auto)** and can be overridden by the owner: change it here first, then the prototype, then the tickets that depend on it.

| # | Question | Answer taken | |
|---|---|---|---|
| 1 | Who opens it, and what do they open? | A designer or front-end engineer on the team shipping the change, on their own machine: a local web app plus an identical CLI | (auto) |
| 2 | First thirty seconds | A committed example run of the demo shop, already rendered | (auto) |
| 3 | Which screens exist | Comparison, Attention, Sessions, Session replay | (auto) |
| 4 | The main object in a list | A session; clicking it opens the replay | (auto) |
| 5 | The headline number | Friction score, 0–100 per variant × task, higher is worse | (auto) |
| 6 | Findings in words or numbers only | In words: a ranked list of sentences with their evidence | (auto) |
| 7 | What is on screen at the end of the demo | The Comparison screen | (auto) |

---

## 1. The primary user, and what they are doing (auto)

A **product designer or front-end engineer on the team that is about to ship a front-end change** — a new checkout,
a moved pricing card, a redesigned onboarding. They have two versions of a page and no idea which one is harder to use.
A real A/B test costs weeks of traffic and risks real customers, so they want a cheap first pass this afternoon.

They run PersonaVision **on their own machine**:

- `personavision open` starts a local web app on `localhost` that reads and writes runs under `./runs/`.
- `personavision run --url … --task …` produces the identical run directory, for CI or a script.

No accounts, no hosting, no multi-tenancy, no database: a run is a directory on disk, and the web app is a viewer and
launcher over that directory. The UI is the product; the CLI writes the same artifact.

What they are trying to come away with, in their words: *"B is worse, here is why, and here are the three things to fix."*

**What this rules out for every worker:** no auth, no job queue, no server-side user model, no cloud storage.
A run directory is the contract between the pipeline and the screens.

## 2. The journey, opening the product to the moment it has done its job (auto)

1. **Open.** `personavision open`. The app opens on the **Comparison** screen of the most recent run.
   On a clean checkout that is the **committed example run of the demo shop** (`northwind-demo`, checkout A vs B),
   a real run artifact in the repository and not mock data. It was produced by the offline deterministic engine,
   so it renders with no API key and no network.
   If `./runs/` is genuinely empty, the **No runs** state offers the example run and a New run button.
2. **Read the verdict.** Two friction scores side by side with their spread, and one sentence saying which variant is
   harder and by how much.
3. **Read the findings.** A ranked list of sentences: what is wrong, with the evidence under each.
4. **Check one finding.** Clicking a finding opens **Attention** on the variant, step and area of interest it concerns:
   heatmap, scanpath and area-of-interest metrics over the page as the agents saw it.
5. **Check one agent.** From an area of interest or from **Sessions**, open a **Session replay**: one persona's gaze,
   scrolling, clicks, stated intent per screen, and the outcome with product-versus-automation attribution.
6. **Done.** They know which variant to ship, which three things to fix first, and which numbers they do not trust.
   Typical path: two clicks to the verdict, four to the evidence behind any single claim.

A **New run** is the same journey started one step earlier: form → running → Comparison.

## 3. The screens, and the one question each answers (auto)

| Screen | The one question it answers | Route |
|---|---|---|
| **Comparison** | Which variant is easier, and why? | `/runs/:runId` (and `/` → latest run) |
| **Attention** | Where did attention go on this variant? | `/runs/:runId/attention/:variant/:step?aoi=` |
| **Sessions** | What happened to each agent? | `/runs/:runId/sessions?variant=&outcome=&aoi=` |
| **Session replay** | What did this one agent see, think and do? | `/runs/:runId/sessions/:sessionId?fix=` |
| New run | What do I want tested? | `/new` |
| Running | How far along is it, and can I look yet? | `/runs/:runId` while the run is open |

Supporting states, all built in the prototype: **No runs**, **New run with invalid input**, **Run failed to start**,
**Sessions with no match**, and an **area of interest that no agent ever fixated**.

The "how human-like is this" score is a **persistent badge in the header** (`Simulated · UEyes similarity 0.68`),
not a screen of its own. It carries the UEyes saliency and scanpath metrics in its tooltip.
The word *Simulated* is in that badge on every screen, and every results screen ends with a line saying the numbers
rank variants and do not estimate conversion lift.

**Screen by screen**

- **Comparison** — run metadata; a banner for any automation failures excluded from the scores; two score cards
  (friction score, spread, the four weighted components, outcome counts); the verdict line with the gap and whether it
  survived repeated runs; the ranked findings; task outcomes per persona segment.
- **Attention** — variant switch, a step filmstrip (cart, payment, review, confirmation) showing how many sessions
  reached each step, the page with heatmap / scanpath / areas-of-interest overlays toggled independently, a fold marker,
  and the area-of-interest metrics table: time to first fixation, first-fixation duration, total dwell, fixation count,
  revisits, and the share of agents who looked at it at all. Clicking a row isolates that area. An area nobody fixated
  reads `never` and `0%`, and isolating it says so in words — that is a result, not missing data.
- **Sessions** — one row per persona × variant × seed: outcome, time, fixation count, attribution, and where it ended.
  Filters by variant, outcome and "fixated this area". Automation failures are listed but marked excluded.
- **Session replay** — the page at the agent's current screen with fixations numbered **continuously across the session**,
  a scrubber that moves gaze, scrolling, clicks and typing together, the agent's stated intent per screen in its own
  words, the event log, and an outcome card naming the finding it supports and confirming automation integrity.

## 4. The main object, and what clicking it shows (auto)

The main object is a **session**: one persona, one variant, one task attempt, one seed. `S-01 … S-24`.

Clicking a session anywhere opens its **replay**. Clicking an **area of interest** anywhere filters Sessions to the
agents that fixated it. Clicking a **finding** opens the evidence behind it — the attention view for an attention claim,
the filtered session list for an outcome claim.

A session is reproducible: same persona, same seed, same page, same session.

## 5. The headline number (auto)

**Friction score** — one number per variant × task, **0 to 100, higher is worse**.

In words:

> Friction is a weighted blend of four things that go wrong, each first expressed as a fraction between 0 and 1,
> then weighted, summed and multiplied by 100:
>
> - **Task failure rate**, weight **30%** — sessions that ended with the task not done and the product at fault,
>   divided by the scored sessions.
> - **Abandonment**, weight **20%** — sessions where the agent gave up voluntarily, divided by the scored sessions.
> - **Time to first fixation on the primary action**, weight **35%** — on the step where it is worst, the median seconds
>   before an agent first looks at the control that advances the task, divided by six seconds and capped at one.
>   **Never fixated counts as a full 1.0**: a control nobody ever sees is the worst case, not a missing value.
> - **Dead-end revisits**, weight **15%** — the median number of returns per session to an area that does not advance
>   the task, divided by five and capped at one.
>
> **Scored sessions exclude automation failures.** A selector timeout or a page our own browsing misread is a weakness
> of the simulation and is never counted against a variant.
>
> The score is reported as the median across seed groups with **± one standard deviation**, and is **never shown
> without that spread**.

**What it must read.** On the demo shop, with four personas × three seeds per variant:

| Input | Required reading | Example run |
|---|---|---|
| Clean variant (current checkout) | **≤ 25** | **22 ± 3** (seed groups 19–25) |
| Variant with the three planted defects | **≥ 60** | **67 ± 4** (seed groups 63–71) |
| Both together | gap ≥ 30 points, and the ± 1σ bands must not overlap across at least three seed groups | gap 45, bands disjoint |

That table is the acceptance test for the whole pipeline. A build that cannot separate the clean checkout from the
defective one by this margin has not worked, whatever the individual subsystems do.

Task success rate sits beside the score on the card but is not the headline.

## 6. A run states its findings in words (auto)

A run produces a **ranked list of findings**, not only metrics. Each finding is:

- a **claim**: one sentence a person could say out loud ("Nobody ever looked at the button that completes the order on variant B.");
- its **evidence**: the numbers behind the claim, in a second sentence;
- a **severity**: critical, high, medium, low, info;
- the **area of interest** and **step** it concerns;
- the **sessions** behind it, as a count and as a link to those sessions;
- an **attribution**: product at fault, or automation at fault and excluded from every score.

Findings are ordered by severity, then by the number of sessions behind them.
**Planted-defect precision and recall are measured against this list**, so it is a real subsystem with its own
data shape and its own ticket — not a label generated in the viewer.

## 7. The demo, beat by beat (auto)

Cold start: a fresh clone, no API key, no network, the offline deterministic engine.

1. **`personavision open`.** The Comparison screen of the committed example run is already on screen. Nothing was crawled,
   nothing was paid for. *(Beat: the product opens finished.)*
2. **The two numbers.** Current checkout **22 ± 3**. Redesign candidate **67 ± 4**. One line: *"Variant B is harder.
   The gap held in all 3 seed groups — the bands do not overlap."* *(Beat: a verdict, with its uncertainty, in one look.)*
3. **The findings.** The top three are the three planted defects, in the words a designer would use: the button nobody
   saw, the fee that appears after the card is entered, the promo banner that takes the first fixation.
4. **Click finding #1.** Attention opens on variant B, review step. The heatmap burns over the service fee and the total;
   the fold line sits above "Confirm purchase"; the scanpath never goes there.
5. **Click the "Confirm purchase" row in the areas-of-interest table.** It reads `never` and `0%`, and the page says it
   in words: *"No fixation ever landed in 'complete' on variant B. 0 of 9 agents who reached this step looked at it."*
   **← This is the moment that has to land.** The thing the team shipped was never seen, and the product says so
   plainly rather than leaving it in a table for the viewer to notice.
6. **Open one agent.** `S-15`, the rushed buyer on mobile: *"Pay as fast as possible, the card is saved."* The scrubber
   walks the gaze, the click on a button that says "Place order", the total jumping from $129.00 to $147.95, three
   revisits to the total, and the exit. The outcome card says **product at fault — no selector failures**.
7. **Back to Comparison.** The closing screen is the one the demo ends on: both variants, both scores with their spread,
   the three findings with their evidence, the outcomes per persona segment, and the header badge
   `Simulated · UEyes similarity 0.68`. The last words are that every number is simulated and none of it is a
   conversion-lift estimate.

Two clicks from a cold start to beat 2, four to beat 5.

## 8. What this contract fixes for the workers

- **Run artifact.** A run is a directory: `runs/<YYYY-MM-DD-HHMM-name>/` containing `run.json` (task, variants,
  personas, seeds, engine, device mix), `findings.json`, `sessions/S-NN.json` and `screenshots/`. Simulated and real
  sessions share the session shape: fixations, saccades, areas of interest, actions, outcome, attribution, viewport,
  device, persona or participant. Every screen above reads this and nothing else. **(auto)**
- **Routes** are listed in section 3 and are not to be invented per ticket.
- **Severity, outcome, attribution and score-band vocabulary** come from `docs/design/tokens.css`
  (`--sev-*`, `--outcome-*`, `--attr-*`, `--score-*`), including the band thresholds `--score-threshold-good: 25`
  and `--score-threshold-bad: 60`. The prototype reads those thresholds from the tokens rather than hard-coding them;
  so should the app.
- **Wording.** The product's language is fixation, saccade, dwell, area of interest, time to first fixation, revisit,
  scanpath, heatmap, persona, seed, session, variant, friction score, finding, attribution, simulated. A session is
  *abandoned* when the agent gave up, *failed* when it ended with the task not done, and an *automation failure* when
  our own browsing broke. Those three are never merged.
- **The fold** is drawn on every page screenshot. A control below it is a finding waiting to happen.
- **Every screen states that the numbers are simulated**, and no screen implies a conversion lift.

## 9. Deliberately not decided here

Native mobile apps, the closed loop where a model proposes a UI change and the swarm retests it, importing Tobii Pro
exports, and webcam sessions with real participants. They reuse the session shape and the Sessions and Replay screens;
when they arrive they get their own flow pass. Nothing in this contract should make them a rewrite.
