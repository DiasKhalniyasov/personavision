# PersonaVision — flow contract

This file and `docs/design/prototype.html` are the design contract for the whole project.
Every ticket that touches a screen, a route, a number or a word the user reads builds against them.
`docs/design/tokens.css` is the single source of visual truth; screens import it instead of restating values.

**Section numbers in this file are stable.** Tickets cite them (`section 3` for the routes, `section 5` for the
friction score and its acceptance table, `section 6` for findings, `section 7` for the demo beats, `section 8` for the
vocabulary, `section 9` for what is deferred, `section 11` for the two product paths, `section 12` for the audience and
the generated goal, `section 13` for onboarding, the ownership verification and the caps, `section 14` for the results
page, `section 15` for the closed loop on a connected repository, `section 16` for what this revision fixes and
`section 17` for what needs the owner). A revision adds sections at the end rather than renumbering.

## Where the answers come from

The flow questions were asked on issue #1 (comment marked `stroika:flow-questions`) and answered **(auto)** when the
owner had not yet replied. On 2026-10-26 the owner replied on #1 and **overrode answers 1, 2, 3, 5 and 7, and set the
visual direction**. Those five are now tagged **(owner)** and are not a worker's to reconsider. Answers 4 and 6 stand as
taken and remain **(auto)**, overridable the same way: change this file first, then the prototype, then the tickets.

On **2026-11-03** the owner set a second direction: **two product paths, a real onboarding, and a results page for
100-agent runs**. It is **sections 11 to 17**, it is **(owner)** throughout, and where it conflicts with anything in
sections 1 to 10 **it overrides it**. The answers in the table below are unchanged except as those sections say.

| #   | Question                                  | Answer                                                                                                                                                          |             |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | Who opens it, and what do they open?      | A business decision-maker — the CEO or owner of the website or app — signing in to a **hosted web platform**. Not a designer or front-end engineer.              | **(owner)** |
| 2   | First thirty seconds                      | They sign in and land on the **Verdict** for their audience, already rendered. The audience is the thing they set up first, before any test.                     | **(owner)** |
| 3   | Which screens exist                       | Sign in · Audience · New test · **Verdict** (the lead) · and, one click deeper, Score breakdown, Attention, Sessions, Session replay                             | **(owner)** |
| 4   | The main object in a list                 | A session; clicking it opens the replay                                                                                                                         | (auto)      |
| 5   | The headline                              | One plain verdict for the chosen audience: which variant their audience completes, and the one or two reasons why. The 0–100 friction score is one click deeper. | **(owner)** |
| 6   | Findings in words or numbers only         | In words: a ranked list of sentences with their evidence. At most three reach the Verdict screen.                                                                | (auto)      |
| 7   | What is on screen at the end of the demo  | The **Verdict** screen                                                                                                                                          | **(owner)** |
| —   | Visual direction                          | The styling of optimizely.com — its colours, type roles, radii and motion — with PersonaVision's own name, logo, wording and images. shadcn/ui for the app, Aceternity UI for the animated moments — see section 10 | **(owner)** |

---

## 1. Who it is for, and the audience they set up (owner)

### The person

A **business decision-maker**: the CEO or the owner of the website or app, the person who decides which change ships.
They have two versions of a page — the current checkout and a redesign somebody has proposed — and a meeting on Thursday
where they have to say yes or no. A real A/B test costs weeks of traffic and risks real customers.

They are **not a designer and not a front-end engineer.** They do not know what a saccade is, they will not read an
area-of-interest table, and a screen of eight metrics tells them nothing. What they want is one sentence they can repeat
to their team, and enough evidence under it that they believe it.

What they come away with, in their words: *"Ship A. My customers never find the button on B, and the fee scares them off."*

### What they open

**A hosted web platform they sign in to.** An account, a workspace, their audiences and their tests, in a browser, on a
laptop they did not have to configure. Not a local app, not a file on disk they have to find.

The **CLI stays as an internal tool**: `personavision run`, `validate` and `open` are how the team regenerates fixtures,
runs the pipeline in CI and debugs an artifact. They are documented as internal and are not the product's entry point.

**What this means for every worker:** there is now a server, an account, a signed-in session and workspace-scoped
storage — the first auto-decision on #1 ("no auth, no job queue, no server-side user model") is **overridden**. What does
*not* change: **a run is still a directory**, written and read through `packages/contract`, served over the documented
read-only paths. The platform scopes who may read which run directory; it does not reshape the artifact, and no
account id, workspace id or credential is ever written into a run artifact. A run directory stays portable.

The platform runs **self-hosted and offline-capable by default** (`personavision serve`, a file-backed store, a seeded
demo workspace), so the whole project builds, tests and demos with no cloud account and no API key. Deploying it to a
managed host with a managed database is its own ticket and needs the owner.

### The audience comes first

Before a test exists, the user sets up **the audience their business actually serves**. That is the product's first-class
object, and it is what the swarm is generated from. Not "pick four stock personas": describe your customers, and
PersonaVision builds the simulated people from that description.

An **audience** is:

```ts
{ id, name,                              // "Outdoor-gear shoppers"
  ageRange: { min, max },                // 25–45
  roles: string[],                       // "first-time buyer", "returning customer"
  regions: string[],                     // "United Kingdom", "Ireland"
  goals: string[],                       // "buy one item quickly", "compare prices first"
  devices: [{ name, viewport: { width, height }, deviceScaleFactor, touch, share }],
  techSavviness: number,                 // 0..1
  priceSensitivity: number,              // 0..1
  size: number,                          // how many simulated people to generate
  generatedFrom: { seed: number, generatorVersion: string } }
```

**Personas are generated from it, deterministically and from a seed.** `generatePersonas(audience, { seed })` returns
`size` personas, each with the six traits the run artifact already declares, a device drawn from the mix by share, a
name, and the two fields that let every screen speak in the user's terms: `audienceId` and `segment` (a short label such
as `mobile · price-sensitive`). Same audience and same seed, same personas — a result is reproducible and a test re-run
next month compares like with like.

The mapping from audience to traits is published by the engine step and is fixed here in outline, so that no ticket
invents its own:

| Audience field     | What it moves                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `techSavviness`    | `interfaceFamiliarity` directly; higher also means more scanning and less reading         |
| `priceSensitivity` | `detailOrientation` on price and total areas; inversely, patience once a price changes    |
| `ageRange`         | `patience` (older skews higher) and `scanningVsReading` (younger skews to scanning)       |
| `goals`            | the engine's top-down goal relevance per area — the existing relevance input, unchanged   |
| `devices`          | the device mix, drawn by `share`; a touch device implies the mobile viewport and fold     |
| `roles`            | the persona's name and its `segment` label                                                |
| `size`             | how many personas are generated, and therefore how many sessions a run has                |

**Every result is framed as the audience's behaviour.** Not "6 of 11 agents abandoned" but "6 in 10 of your audience gave
up at this step". The engineering vocabulary in section 8 is unchanged and still governs code, tests and the screens one
click deeper; what changes is the words on the Verdict screen, which are the user's, not ours.

A workspace may hold several audiences. A test names the audience it used, and the Verdict screen states it above the
answer, because the answer is only true of that audience.

## 2. The journey, from signing in to the moment it has done its job (owner)

1. **Sign in.** Email and password against their workspace. A fresh install has a seeded **demo workspace** whose latest
   test is the committed example run of the demo shop (`northwind-demo`, checkout A vs B) — a real run artifact in the
   repository, produced by the offline deterministic engine, so it renders with no API key and no network.
2. **Land on the Verdict.** Not a list, not a form: the answer for their audience, already rendered.
   One headline sentence, the two completion figures, the one or two reasons, one heatmap as the evidence, and at most
   three findings. If the workspace has no test yet, the **No tests** state offers the example run and a New test button;
   if it has no audience yet, it asks for the audience first, because a test cannot be run without one.
3. **Believe it.** The headline is a sentence; under it, the share of their audience that completed the task on each
   variant, and the single heatmap that shows why. That is the whole screen. It is readable in under a minute.
4. **Go one click deeper, if they want to.** Four doors, all optional, none on the lead screen:
   **Score breakdown** (the friction score, its four weighted components, the spread across seed groups, and outcomes by
   audience segment), **Attention** (heatmap, scanpath and the area-of-interest table over the page as their audience saw
   it), **Sessions** (one row per simulated person), **Session replay** (one person's gaze, intent, actions and outcome).
5. **Done.** They know which variant to ship and the one or two things to fix first. Typical path: **zero clicks to the
   verdict**, one to the evidence behind it, two to any number underneath.

A **New test** is the same journey one step earlier: choose the audience → the two URLs and the task → running → Verdict.

## 3. The screens, and the one question each answers (owner)

| Screen              | The one question it answers                 | Route                                                    |
| ------------------- | ------------------------------------------- | -------------------------------------------------------- |
| **Verdict**         | Which change should I ship, for my audience?| `/runs/:runId` (and `/` → latest test)                   |
| Sign in             | —                                           | `/signin`                                                |
| Audiences           | Who does my business serve?                 | `/audiences`, `/audiences/new`, `/audiences/:audienceId` |
| New test            | What do I want tested, and for whom?        | `/new`                                                   |
| **Score breakdown** | How sure is that, and what drove it?        | `/runs/:runId/breakdown`                                 |
| **Attention**       | Where did my audience look on this variant? | `/runs/:runId/attention/:variant/:step?aoi=`             |
| **Sessions**        | What happened to each person?               | `/runs/:runId/sessions?variant=&outcome=&aoi=`           |
| **Session replay**  | What did this one person see, think and do? | `/runs/:runId/sessions/:sessionId?fix=`                  |
| Running             | How far along is it, and can I look yet?    | `/runs/:runId` while the test is open                    |
| Landing             | What is this, and why would I trust it?     | `/` when nobody is signed in                             |
| Demo                | Show me, without signing up.                | `/demo`                                                  |

The route family is still `/runs/:runId` and the artifact is still a run: *run* is the internal word for a test, and the
contract, the CLI and the directory layout keep it. The user-facing word is **test**.

The last two are **public**: everything above them is behind sign-in. **Landing** is what `/` renders when nobody is
signed in — the product's own page, which replaces the straight redirect to `/signin`; it states what PersonaVision
does, shows the verdict it produces, and its only actions are *See the demo* and *Sign in*. **Demo** is the committed
example run's Verdict, read-only, with no account: the same components as the signed-in Verdict over the same artifact,
every figure labelled simulated, and one action back to sign-in. Neither page invents a number: both read the committed
example run. They are the two pages section 10 gives the Aceternity moments to, and they are specified in their own
tickets rather than in the prototype, which covers the signed-in product.

Supporting states, all built in the prototype: **Signed out**, **No audience yet**, **No tests yet**, **New test with
invalid input**, **Test failed to start**, **Sessions with no match**, and **an area of interest nobody looked at**.
**No tests yet** keeps its two actions — the committed example run and a new test — and offers **the five example tests**
of section 13 below them, from the same file the first New test screen reads them from.

The "how human-like is this" figure is a **persistent badge in the header** (`Simulated audience · gaze similarity 0.68`),
not a screen of its own, and it carries the UEyes saliency and scanpath metrics in its tooltip. The word *Simulated* is
in that badge on every screen, and every results screen ends with a line saying the numbers rank variants for this
audience and do not estimate conversion lift.

**Screen by screen**

- **Verdict** — the audience it is about and the task; one headline sentence naming the variant their audience completes;
  the two completion figures side by side with the number of simulated people behind each; the one or two reasons, in
  plain words; **one heatmap** of the moment that explains the verdict, framed in neutral space, with a caption and a
  link into Attention; at most **three findings**, each a claim plus its evidence; a banner when sessions were excluded
  because our own automation broke; and the doors to the detail. Nothing else. No area-of-interest table, no scanpath,
  no component bars, no session list, no friction score.
- **Score breakdown** — where everything the old Comparison screen led with now lives: two score cards with the friction
  index, its band, the spread band drawn on the 0–100 scale, the four weighted components with their weights and raw
  readings, the outcome counts, the verdict line with the gap in points and whether the ±1σ bands overlapped across seed
  groups, and task outcomes by audience segment.
- **Attention** — variant switch, a step filmstrip (cart, payment, review, confirmation) showing how many sessions
  reached each step, the page with heatmap / scanpath / area-of-interest overlays toggled independently, a fold marker,
  and the area-of-interest metrics table: time to first fixation, first-fixation duration, total dwell, fixation count,
  revisits, and the share of the audience who looked at it at all. Clicking a row isolates that area. An area nobody
  fixated reads `never` and `0%`, and isolating it says so in words — that is a result, not missing data.
- **Sessions** — one row per generated person × variant × seed: outcome, time, fixation count, attribution, and where it
  ended. Filters by variant, outcome and "looked at this area". Automation failures are listed but marked excluded.
- **Session replay** — the page at that person's current screen with fixations numbered **continuously across the
  session**, a scrubber that moves gaze, scrolling, clicks and typing together, their stated intent per screen in their
  own words, the event log, and an outcome card naming the finding it supports and confirming automation integrity.

## 4. The main object, and what clicking it shows (auto)

The main object is a **session**: one generated person, one variant, one task attempt, one seed. `S-01 … S-24`.

Clicking a session anywhere opens its **replay**. Clicking an **area of interest** anywhere filters Sessions to the
people who looked at it. Clicking a **finding** opens the evidence behind it — the attention view for an attention claim,
the filtered session list for an outcome claim.

A session is reproducible: same audience, same persona, same seed, same page, same session.

## 5. What the product leads with, and the friction score behind it (owner)

### What the Verdict screen leads with

**A sentence, then two figures.**

> **Your audience completes the purchase on the current checkout, not on the redesign.**
> 8 in 10 finished on A. 2 in 10 finished on B.
> Why: the button that completes the order was never seen on B, and a $9.95 fee appears only after the card is entered.

- **The headline sentence** names the variant the audience completes or prefers, in the user's words, and nothing else.
- **The completion figure** per variant — the share of the audience that finished the task, as a fraction of the scored
  sessions, shown as *N in 10* and as a percentage, always with the number of people behind it. Its band comes from
  `--completion-threshold-good` and `--completion-threshold-bad` in the tokens.
- **One or two reasons**, each a short clause drawn from the top findings. Never three, never a list of eight.
- **One heatmap** as the evidence, of the step and variant the verdict turns on.

These are **stored, not computed in the browser**: `scores[].completionRate`, and on the verdict
`preferredVariant`, `audienceSentence`, `reasons` (one or two), `headlineFindingIds` (at most three) and
`heroEvidence: { variant, step, aoiId }`. The screens format; they do not calculate.

### The friction score — one click deeper, unchanged

The 0–100 **friction score** per variant × task, higher is worse, is **no longer the headline**. It moves to the Score
breakdown screen, where it is the honest ranking number for whoever wants it, and it remains **the pipeline's one
acceptance test**. Its formula, weights and exclusion rule are unchanged:

> Friction is a weighted blend of four things that go wrong, each first expressed as a fraction between 0 and 1,
> then weighted, summed and multiplied by 100:
>
> - **Task failure rate**, weight **30%** — sessions that ended with the task not done and the product at fault,
>   divided by the scored sessions.
> - **Abandonment**, weight **20%** — sessions where the person gave up voluntarily, divided by the scored sessions.
> - **Time to first fixation on the primary action**, weight **35%** — on the step where it is worst, the median seconds
>   before someone first looks at the control that advances the task, divided by six seconds and capped at one.
>   **Never fixated counts as a full 1.0**: a control nobody ever sees is the worst case, not a missing value.
> - **Dead-end revisits**, weight **15%** — the median number of returns per session to an area that does not advance
>   the task, divided by five and capped at one.
>
> **Scored sessions exclude automation failures.** A selector timeout or a page our own browsing misread is a weakness
> of the simulation and is never counted against a variant.
>
> The index is reported as the median across seed groups with **± one standard deviation**, and is **never shown
> without that spread**.

**What it must read.** On the demo shop, with the demo audience's four generated personas × three seeds per variant:

| Input                                  | Required reading                                                                            | Example run                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------ |
| Clean variant (current checkout)       | **≤ 25**                                                                                    | **22 ± 3** (seed groups 19–25) |
| Variant with the three planted defects | **≥ 60**                                                                                    | **67 ± 4** (seed groups 63–71) |
| Both together                          | gap ≥ 30 points, and the ± 1σ bands must not overlap across at least three seed groups      | gap 45, bands disjoint         |
| The completion figures                 | clean ≥ 0.6 of scored sessions, defective ≤ 0.3, and the preferred variant is the clean one | A 9/11 = 0.82, B 2/11 = 0.18   |

That table is the acceptance test for the whole pipeline. A build that cannot separate the clean checkout from the
defective one by this margin has not worked, whatever the individual subsystems do.

## 6. A run states its findings in words (auto)

A run produces a **ranked list of findings**, not only metrics. Each finding is:

- a **claim**: one sentence the user could say out loud, about their audience ("Nobody in your audience ever looked at
  the button that completes the order on the redesign.");
- its **evidence**: the numbers behind the claim, in a second sentence;
- a **severity**: critical, high, medium, low, info;
- the **area of interest** and **step** it concerns;
- the **sessions** behind it, as a count and as a link to those sessions;
- an **attribution**: product at fault, or our simulation at fault and excluded from every score.

Findings are ordered by severity, then by the number of sessions behind them.
**At most the top three are shown on the Verdict screen**; the rest are one click deeper, with the whole list reachable
from there. The cap is presentation: the artifact carries every finding, and `verdict.headlineFindingIds` names the ones
the Verdict screen shows, so the pipeline decides and the screen does not re-rank.

Claims are worded for a business reader: the thing on the page, what their audience did about it, and the consequence.
No jargon in a claim sentence; the evidence sentence may carry a number and a unit.
**Planted-defect precision and recall are measured against this list**, so it is a real subsystem with its own
data shape and its own ticket — not a label generated in the viewer.

## 7. The demo, beat by beat (owner)

Cold start: a fresh clone, no API key, no network, the offline deterministic engine, the platform served locally with its
seeded demo workspace.

1. **Sign in.** `personavision serve`, the sign-in screen, the demo workspace's credentials. One screen, one action.
   _(Beat: a product, not a script.)_
2. **The verdict is already there.** No list, no form. _"Your audience completes the purchase on the current checkout,
   not on the redesign."_ Beneath it: **8 in 10** on A, **2 in 10** on B, and the audience it is about —
   _Outdoor-gear shoppers, 25–45, mostly mobile, price-aware_. _(Beat: an answer in one look, for my customers.)_
3. **The two reasons, and the heatmap.** _"The button that completes the order was never seen"_ and _"a $9.95 fee appears
   only after the card is entered"_ — and one heatmap of variant B's review step, framed in neutral space, burning over
   the fee and the total, with the fold line above "Confirm purchase" and nothing at all on the button.
   _(Beat: the evidence is one image, and it is obvious.)_
4. **The three findings.** The three planted defects, in the words an owner would use, each with its evidence sentence.
   Nothing else on the screen. _(Beat: here is what to fix.)_
5. **Click the heatmap's caption.** Attention opens on variant B, review step, with the completing action isolated. The
   area-of-interest row reads `never` and `0%`, and the page says it in words: _"No fixation ever landed in 'complete' on
   variant B. 0 of 9 people in your audience who reached this step looked at it."_
   **← This is the moment that has to land.** The thing the team was about to ship was never seen, and the product says
   so plainly rather than leaving it in a table for the viewer to notice.
6. **One person.** `S-15`, the rushed buyer on mobile: _"Pay as fast as possible, the card is saved."_ The scrubber walks
   the gaze, the click on a button that says "Place order", the total jumping from $129.00 to $147.95, three revisits to
   the total, and the exit. The outcome card says **product at fault — no selector failures**.
7. **Back to the Verdict.** The closing screen is the one the demo ends on: the headline sentence, the two completion
   figures, the reasons, the one heatmap, the three findings, the audience it is about, and the header badge
   `Simulated audience · gaze similarity 0.68`. The last words are that every number is simulated for this audience and
   none of it is a conversion-lift estimate.

**Zero clicks from sign-in to beat 2**, one to beat 5. The detail screens are reachable but the demo does not need them
to make its point — that is the change from the previous script, where the verdict took two clicks and the screen was
full of tables.

## 8. What this contract fixes for the workers

- **Run artifact.** A run is a directory: `runs/<YYYY-MM-DD-HHMM-name>/` containing `run.json` (task, audience,
  variants, generated personas, seeds, engine, device mix), `findings.json`, `sessions/S-NN.json` and `screenshots/`.
  Simulated and real sessions share the session shape: fixations, saccades, areas of interest, actions, outcome,
  attribution, viewport, device, persona or participant. Every screen above reads this and nothing else. **(auto)**
- **The artifact stays portable.** No account id, workspace id, email, password or token is ever written into a run
  artifact. The platform decides who may read a run directory; the directory does not know who owns it.
- **Routes** are listed in section 3 and are not to be invented per ticket.
- **Severity, outcome, attribution, completion and score-band vocabulary** come from `docs/design/tokens.css`
  (`--sev-*`, `--outcome-*`, `--attr-*`, `--completion-*`, `--score-*`), including the band thresholds
  `--score-threshold-good: 25`, `--score-threshold-bad: 60`, `--completion-threshold-good: 0.6` and
  `--completion-threshold-bad: 0.3`. The prototype reads those thresholds from the tokens rather than hard-coding them;
  so should the app.
- **Wording.** The product's internal language is unchanged: fixation, saccade, dwell, area of interest, time to first
  fixation, revisit, scanpath, heatmap, persona, seed, session, variant, friction score, finding, attribution, simulated.
  A session is _abandoned_ when the person gave up, _failed_ when it ended with the task not done, and an _automation
  failure_ when our own browsing broke. Those three are never merged. A session stopped by its own action budget is
  _failed_ and says so — its reason names the budget and the step it was on — never _abandoned_: the agent had more to
  try and we stopped it.
  **Two words are new and are the user's:** an **audience** is what the user describes and personas are generated from,
  and a **test** is what the user calls a run. On the Verdict screen the words are the user's; one click deeper the
  product may use its own.
- **The fold** is drawn on every page screenshot. A control below it is a finding waiting to happen.
- **Every screen states that the numbers are simulated** for the named audience, and no screen implies a conversion lift.
- **One heatmap on the Verdict screen, and no more.** Any ticket that adds a second chart, a table or a metric row to
  that screen is working against this contract: the whole point of the owner's direction is that this screen is quiet.

## 9. Deliberately not decided here

Native mobile apps, the closed loop where a model proposes a UI change and the swarm retests it, importing Tobii Pro
exports, and webcam sessions with real participants. They reuse the session shape and the Sessions and Replay screens;
when they arrive they get their own flow pass. Nothing in this contract should make them a rewrite.

Also deferred, now that the product is hosted: billing and plans, inviting teammates into a workspace, roles and
permissions beyond "a member of this workspace", SSO, and audience import from an analytics tool. The workspace model is
built so that each is additive — a workspace has members, and a run directory belongs to a workspace — but none is in
scope, and no ticket should build toward one speculatively.

## 10. Visual direction (owner)

**The styling of optimizely.com, carrying PersonaVision's own name, logo, wording and images.** The colours, the type
roles, the radii and the motion are copied exactly, from that site's own CSS; the brand is not. No logo, wordmark,
illustration, photograph, line of copy or **font file** is taken from them, no page of this product reproduces a page of
theirs, and nothing here should read as published by Optimizely.

Every value below lives in `docs/design/tokens.css` and nowhere else. A screen references the custom property; a
component never carries a colour, a radius or a duration of its own. That is what makes the next direction change one
edit to one file.

### Components

- **shadcn/ui (Radix + Tailwind) for the app.** Every control is a shadcn primitive — button, input, select, dialog,
  dropdown, tabs, table, tooltip, badge, skeleton, toast — styled by the tokens through the Tailwind theme. A screen
  ticket that needs a control takes the shadcn one and restyles nothing; a bespoke control is written only where no
  primitive exists (the heatmap, the scanpath, the scrubber, the step filmstrip), and then it still reads its values
  from the tokens. Radix is what gives the keyboard and screen-reader behaviour the accessibility rules below demand.
- **Aceternity UI (Motion-based) for the animated moments, and only for these:**
  1. **The Verdict reveal** — a number ticker on the two completion figures, a spotlight on the winning version, and an
     animated beam from the chosen audience to the two versions.
  2. **The heatmap warming up** where the audience looked, once, as the evidence appears.
  3. **The landing and demo pages.**
- Nowhere else moves. A results screen one click deeper (Score breakdown, Attention, Sessions, Session replay) has the
  base transition and the pulse, and no entrance animation at all: a number a user is reading must not be moving.

### Colour

Taken from optimizely.com's CSS. The names on the left are the tokens.

| Role | Token | Value |
| --- | --- | --- |
| Headlines, dark sections, gaze marks | `--color-heading`, `--color-canvas-dark` | dark fir `#08251a` |
| The deepest band | `--color-canvas-dark-strong` | fir-800 `#061c14` |
| A panel inside a dark band | `--color-canvas-dark-mid` | mid fir `#0d3a29` |
| Body copy | `--color-text` | `#101828` |
| **Primary action** | `--color-accent` / `--color-on-accent` | lime `#abff44` with dark fir text |
| Primary action, hover and pressed | `--color-accent-strong`, `--color-accent-grass` | lime-100 `#92ec41`, grass `#7ddd3d` |
| Tinted section | `--color-canvas-alt` | pale green `#e4f0da` |
| Form fields, soft panels, screenshot mats | `--color-surface-sunken`, `--color-accent-soft` | `#eff6e9` |
| Borders and dividers | `--color-border`, `--color-border-strong` | `#d8e4cb`, `#c3ceaf` |
| Links | `--color-link`, `--color-link-hover` | teal `#007b79`, `#00514f` |
| Success, and a clean outcome | `--outcome-success`, `--score-good` | deep greens `#227d47`, `#2e8c45`, `#3ab533` |
| Caution, abandonment, the losing band | `--completion-warn`, `--outcome-abandoned` | pinks `#ff99b6`, `#c96384`, `#8f4764` |
| Information | `--sev-info` | teals `#00514f`, `#2f9b99`; light blue `#91dbda` |
| Errors | `--sev-critical`, `--sev-high` | `#c80808`, `#f13030` |

Rules that outlive the values:

- **Lime is the action colour and nothing else.** Primary buttons, the pressed segment, the active tab's underline. It
  never carries meaning — severity, outcome, attribution and gaze colours are semantic — and it is never text on white,
  because it cannot be read there. That is why links are teal.
- **Dark fir for headlines, `#101828` for body copy.** Black is not used.
- **White sections, one pale-green tinted section for rhythm, one dark fir band** (sign-in, the landing and demo pages'
  closing band). Never more than one tinted and one dark band per screen.
- Where the palette has no mid-grey, the two muted text tokens are fir mixed with white and are marked `(derived)` in
  the tokens file. Every other value above is the site's own.
- Dark mode is a colour override in the tokens file; sizes, spacing and motion are shared. The lime accent is unchanged
  in dark mode and the greens invert to the lighter grass and lime.
- A colour is never the only carrier of meaning: severity, outcome and attribution always have their word beside them.

### Type

Four roles, each one token:

| Role | Licensed family | Free stand-in used until the licences are bought | Token |
| --- | --- | --- | --- |
| Headlines | VC Nudge (400, 600, 800) | **Bricolage Grotesque** | `--font-display` |
| Body, buttons, forms | Die Grotesk B (400, 500, 700) | **Schibsted Grotesk** | `--font-sans` |
| Uppercase overline labels | Roboto Mono | Roboto Mono itself | `--font-mono` |
| Occasional editorial headline | VC Henrietta Condensed | **Instrument Serif** | `--font-editorial` |

- VC Nudge, Die Grotesk B and VC Henrietta Condensed are **commercial fonts**. No font file is ever copied from
  optimizely.com. Until the owner buys the licences every role renders in the free Google Fonts match above, and the day
  a licence exists the swap is one edit per token: put the licensed family first in the stack and vendor its files.
  `--font-display-licensed`, `--font-sans-licensed` and `--font-editorial-licensed` record the names meanwhile.
- The stand-ins are **self-hosted from the repository** (the `@fontsource` packages, OFL-licensed), not fetched from a
  CDN: the platform must still render with no network, which is also what keeps the offline demo honest. The static
  design prototype is the one exception and links Google Fonts directly, because it is opened as a file.
- Display weights are 400 / 600 / 800; body, buttons and forms use 400 / 500 / 700. A body face is never set to 600.
- Overline labels are uppercase, in the mono family, at `--tracking-wide`.
- Headlines are large, bold and tightly tracked: the Verdict screen's sentence is `--text-display` at weight 800 with
  `--tracking-tighter`, and it is the biggest thing on the page by a wide margin. Generous whitespace, not rules,
  separates sections (`--section-pad-y` 64px, `--section-pad-y-lg` 96px); a dense Verdict screen is a bug.
- Numbers are tabular (`font-variant-numeric: tabular-nums`) wherever they are compared, and a figure never appears
  without the population behind it.

### Radius

`--radius-xl` 20px for cards and large panels, then `--radius-lg` 16px, `--radius-md` 12px (inputs, selects),
`--radius-sm` 8px and `--radius-xs` 4px. **Every button, chip and tag is fully rounded** (`--radius-full`). Shadows are
soft and low-contrast (`--shadow-sm`, `--shadow-md`); a hard-edged drop shadow is never used. A page screenshot is never
flush against the layout: it sits on a mat of `--color-surface-sunken` with `--frame-mat-pad` around it, rounded, with
the device and viewport labelled.

### Motion

- **The base transition is 150ms `cubic-bezier(.4, 0, .2, 1)`** — `--duration-base` and `--ease` — on hover and on state
  changes. It is the only transition most of the product has.
- **A soft pulse for live or loading states**: the `pv-pulse` keyframes in the tokens file, `--pulse-duration` 2s. The
  progress bar of a running test and the live badge use it; nothing else does.
- The Aceternity moments listed above come on top, with their durations in the tokens file
  (`--moment-ticker-duration`, `--moment-spotlight-duration`, `--moment-beam-duration`, `--moment-heat-duration`,
  `--moment-stagger`). A component never writes its own duration.
- **Every animation respects `prefers-reduced-motion`.** Under it the transitions and the moment durations become 0ms in
  the tokens file and the pulse flattens; a component that animates in JavaScript checks the same query (Motion's
  `useReducedMotion`) and **renders the finished state immediately** — never a shortened animation, never a
  number mid-count. A test asserts the Verdict screen's figures are the final figures on first paint under that query.

### Accessibility is part of the direction, not a later pass

Every screen is operable by keyboard; focus is always visible at `--border-width-strong` in `--color-focus`, which is
dark fir on light and lime on dark so that it reads on white, on a pale panel and on a lime button alike. The
area-of-interest table is the accessible representation of the heatmap. Radix supplies the roles, labels and focus
management, and a bespoke control copies that behaviour rather than inventing it. Text contrast is checked against the
tokens, not by eye: lime is never a text colour on white, and the pink and teal semantic colours are the darkest of
their family for exactly that reason.

## 11. Two product paths (owner)

On **2026-11-03** the owner set the direction in sections 11 to 17. **Where it conflicts with sections 1 to 10 it
overrides them**; everything it does not mention stands unchanged, and nothing above is renumbered or rewritten. What
sections 1 to 10 fix about the audience, the vocabulary, the one-heatmap rule on the lead screen, the attribution split
and the visual direction still governs every screen below.

What changes: the product is no longer only an A/B comparison of two URLs a user pastes in. It has **two paths**, and the
A/B comparison of sections 2 to 5 is what the second path ends in.

| Path  | Name               | What the user brings                                                               | What they get                                                                                                          |
| ----- | ------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **1** | **Test my site**   | one URL, and in plain words the feature whose experience they want tested          | up to 100 simulated people attempt that feature; the aggregate, the session videos, the heatmaps and ranked recommendations |
| **2** | **Improve my site**| the same, plus a **connected GitHub repository**                                   | all of path 1, then one targeted change written as a pull request, and the before/after Verdict of sections 2 to 5      |

**Path 2 is shown and locked** without a connected repository, with the reason beside the lock in the user's words —
_Connect a GitHub repository and PersonaVision can write the change and open the pull request for you._ It is never
hidden: a user has to be able to see what they do not have yet, and why.

**A test is still a run, and a run is still a directory.** A path-1 test is a run with **one variant**; a path-2 test is
a run with **two** — the baseline and the pull request's preview — which is exactly what sections 2 to 5 already
describe. Nothing about the artifact, the routes or the vocabulary forks per path, and no screen exists twice.

### What a path-1 test is made of

1. **A site.** A URL added to the workspace, with **ownership verified** before it can be tested at scale (section 13).
2. **The feature, in the user's words.** _"generating a video on this site"_, _"checking out with a promo code"_. One
   free-text field, and it is the user's sentence that is stored, not a normalised version of it.
3. **The audience.** Section 12: structured, or free text turned into the same structured object. **100 participants by
   default.**
4. **The goal, written by Muse Wonder.** From the URL and the feature description: the task the agents attempt and what
   counts as success — _"generate a video on this site; success = a video preview is visible"_. The user reads it and
   edits it **before** launch (section 12).
5. **The run.** Up to 100 agents in parallel, each a person generated from the audience, each in its own browser, each
   **recording a video** of the interaction alongside the clicks, scrolls, typing, gaze, timing and outcome.
6. **The aggregate, and Muse Wonder's recommendations** (section 14).

**Attribution does not move.** _Abandoned_, _failed_ and _automation failure_ stay the three things section 8 says they
are; an automation failure is excluded from every figure, and **no recommendation may rest on an excluded session**. A
run whose automation failures are more than a fifth of its sessions says so above its own summary, because at that point
the aggregate is about our harness and not about the site.

## 12. The audience two ways, and the goal a model writes (owner)

### The audience object is extended, never forked

`audienceSchema` (section 1) is the one audience. Two fields are added to it and nothing is taken away:

- **a gender split** — the share of the audience that is male and the share that is female, a distribution like
  `devices[].share`, summing to one;
- **age groups** — the brackets a user actually thinks in (`18–24`, `25–34`, `35–44`, `45–54`, `55–64`, `65+`), each with
  a share, with `ageRange` derived from the groups that carry one and held consistent with them.

`size` defaults to **100** for a test started on the platform. `regions`, `languages`, `devices`, `roles`, `goals`,
`techSavviness`, `priceSensitivity` and `generatedFrom` are unchanged; a **language** list joins `regions`, because
"Almaty" and "in Russian" are two different facts about the same audience and the agents read the page in one of them.

The persona generator's mapping table in section 1 gains three rows and loses none: the gender split and the age-group
shares are drawn the way the device mix already is, and `languages` picks the language a persona reads and types in.

### Two ways to describe it, one object

- **Structured.** The fields above, on the Audience form of section 3, extended: gender split, age groups, participants
  (default 100), region and language, device mix.
- **Free text.** One box: _"busy parents in Almaty who shop on their phones"_. **Muse Wonder turns it into the same
  structured audience**, and **the user is shown the result and can edit every field before anything launches.**

The free-text box is **an input to the form, not an alternative to it**: it fills the form, the form is what is saved,
and what is saved is one `Audience`. A free-text audience that launches without having been shown to the user is a bug
and not a shortcut — the user has to be able to see that _"busy parents"_ became 100 people, 72% on phones, 28 to 44,
Almaty, Russian and Kazakh, and to disagree with any of it.

### The goal Muse Wonder writes

From the site's URL and the feature description, Wonder writes two sentences:

- **the task** — what the agents attempt, in the words a person would use;
- **the success criterion** — what has to be **observable in the page** for an attempt to count as a success: a visible
  element, a URL, a piece of text. Not a judgement, and not a feeling. A criterion Wonder cannot state that way is sent
  back for one it can.

Both are shown on one screen before launch, both are editable, and **the edited text is what the run records**. A run
always records the goal it ran and **who last wrote it** — the model or the user — because a completion rate is only as
meaningful as the criterion behind it, and a reader a month later has to be able to see which of the two wrote it.

### Where the criterion is read

The success criterion is read **against the address the page is at**: on every captured screen, and again after
every action, against the position the driver reports the action reached. And a screen **records the address it
was captured at**, so that a reader of a finished run can say which page a screen was on, and a session already
written can be re-read against a criterion without being walked again. A screen that recorded no address says
so rather than claiming the run's URL — the field is optional with no default, like a session's video.

A **single-page application** is the shape of site that needs this, and the product's own front end is one of
them: one URL, one derived step that matches every view of it, every view starting at the top, and the address
the only thing that moves. A client-side navigation — `history.pushState`, a framework route, a consent bounce
— asks the network for nothing, so an address carried along from the last action never sees it, and nothing
else in the session contradicts it. Two consequences, both of them about the same click: the address an action
reports is the one the click **reached**, waited for the same bounded way a document load is; and a click that
moved the address is a click that **got the agent somewhere**, on a run where neither the step nor the scroll
position can move to say so.

Every Wonder use — the audience from free text, the goal, the analysis, the change decision — goes through
`@personavision/provider` with an offline deterministic implementation behind the same interface. **Tests make no network
call and need no key**, exactly as today.

## 13. Onboarding, screen by screen (owner)

Sign up → workspace → **add a site** → describe the audience → describe the feature → **review the generated goal** →
see a **cost and time estimate** for N agents → launch → a live **Running** screen with sessions finishing → **Results**.

| Screen             | The one question it answers                        | Route                                     |
| ------------------ | -------------------------------------------------- | ----------------------------------------- |
| Sign up            | —                                                  | `/signup`                                 |
| Sites              | Which of my sites can I test, and which are proved mine? | `/sites`                            |
| Add a site         | What is the URL, and how do I prove it is mine?    | `/sites/new`, `/sites/:siteId`            |
| New test           | What do I want tested, for whom, and on which path?| `/new` (steps: `?step=audience\|feature\|goal\|estimate`) |
| GitHub connection  | Where would the pull request go?                   | `/settings/github`                        |

The route family of section 3 is otherwise untouched: `/new` is the same screen with more steps, and `/runs/:runId` is
still where a test lands. The steps of `/new` are **one screen with a step in the query**, not five routes: a user who
reloads, or who is sent a link, lands where they were.

### The five example tests

A first visit has nothing to test yet, and inventing a site, a feature, a task and a success criterion before seeing a
single result is four decisions in a row. So the product ships **five example tests** on real public sites, none of them
behind a login — the owner's own five (the input of **2026-11-04**): Stripe's docs (testing payments), Vercel (starting
from a template), IKEA (furniture take-back), Canva (short social videos) and Apple (trading in an old phone).

**Two surfaces show them**, from one file and with no screen spelling a template: the first New test screen
(`/new?step=path`, under the two path cards) and the **No tests** state of section 3. A card states the site's host, the
feature, the task, the audience it suggests, and has **one control** — *Try this test*.

**The rule they exist to demonstrate.** Each task names a need **in everyday words and never the site's own label for
the feature** — *"a way to get rid of your old furniture"*, not *"the take-back service"* — because the product's claim
is that people with different personalities look for the same thing differently. A task in the site's own vocabulary
would be testing whether somebody can read a menu we already read for them. The **success criterion** is held to the
same rule every criterion is: it names something observable on the page, so a template's run is decided by what a
session saw rather than being a failure by construction.

**Choosing one fills four fields and launches nothing.** A workspace site whose URL matches is reused, otherwise the
template is added through `POST /sites` with the refusals the Add-a-site form already has; then the site, the feature and
the goal are written into the New test draft, the audience **sentence** is carried into the audience step's box, and the
user lands on `?step=audience` with every one of them editable. The goal is recorded as **the user's** — they chose it
and can edit it, and no model wrote it — so there are still two goal authorships and not three. The audience is still
read by that step's own control, the estimate and the caps are whatever they are for a typed test, and nothing starts
until the user presses Launch.

### Ownership verification

A site is **unverified** until one of these passes, and **the platform checks it itself** — a user ticking a box is not
verification:

| Method                    | What the user does                                                                          | What the platform checks                                     |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **DNS TXT record**        | adds `personavision-site-verification=<token>` as a TXT record on the site's domain          | resolves TXT for the domain and finds the token               |
| **Meta tag**              | adds `<meta name="personavision-site-verification" content="<token>">` to the page's `<head>` | fetches the URL once and parses the tag                      |
| **File**                  | serves `/.well-known/personavision-site-verification.txt` containing the token               | fetches that path and compares the contents                   |
| **Connected repository**  | installs the GitHub App on the repository that deploys the site                               | the installation exists and the connection names this site    |

The token is per site, generated by the platform, and shown with the exact line to copy. A check that fails says **which
check ran, what it found and what it expected**, and offers to run again; it never says "something went wrong".

**Verification gates nothing about testing.** The owner's answer of **2026-11-03** settled decision 71 as _no gate on
testing_: an unverified site runs under exactly the same caps as a verified one, because the caps protect **the site
being driven** rather than the person who asked, and a hundred browsers on a small site is a load test whoever owns it.
What verification unlocks is **Improve my site**, which writes to a repository and so does need proof of control. The
screen states the numbers rather than the word, for every site: _100 agents per run allowed_ and _4 runs an hour · 10
browsers at a time_, and an unverified site's card adds _Verify it to unlock **Improve my site**_.

### The caps, enforced by the platform

| Cap                                   | Value                              | Why                                                                     |
| ------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| agents per run                        | the audience's `size`, **max 100** | the owner's figure; above it nothing is promised                         |
| concurrent sessions per site          | **10**                             | a hundred browsers at once on one small site is a load test nobody asked for |
| runs per site per hour                | **4**                              | a person exploring cannot accidentally hammer a site                     |
| requests and actions per session       | the existing session budget        | unchanged (`SessionBudget`)                                              |

**Verification is not among the inputs.** There is no smaller cap for an unverified site and no verification check on
the launch path. A run records what was true of its site at launch (`site.verifiedAtLaunch`) and no cap reads it.

These numbers live in **one place** in `packages/platform` and are stated on the screen that is bound by them. A refused
launch names the cap that refused it, in words, and when it can be tried again. The caps apply to the offline engine too:
they are about the site being driven, not about what it costs us.

### The estimate

On the launch screen, above the button: **how many agents, how long it will take and what it will cost**, computed from
the run's own inputs — sessions × the median session wall clock ÷ the concurrency, and the model tokens a session has
historically used × the prices in `docs/meta-model-api.md`, plus the disk the videos will take. It is **a range, labelled
as a range**, with the one line of arithmetic under it. An offline run costs nothing and says so rather than showing
`$0.00` as if it had been priced.

## 14. The results page for a hundred-agent run (owner)

Five sections, in this order. **The first is the lead and is the whole answer**; the other four are the evidence, each
reachable from the tab bar of section 3.

**The one-heatmap rule of section 8 still binds the lead.** It does not bind the Heatmaps section — that is where
heatmaps belong.

**These are the same tabs, not a second set.** A path-1 run leads with Summary on the tab an A/B run leads with its
Verdict on, and Heatmaps is the Attention tab with its three overlays and its two filters; **Funnel and timing**,
**Analysis** and **Improve** are the three tabs this revision adds. _Score breakdown_ is shown only for a run with two
variants, because a run with one has nothing to compare.

| Section               | The one question it answers                            | Route                                                                   |
| --------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| **Summary** (lead)    | What should I change, and how did my audience do?      | `/runs/:runId`                                                          |
| **Sessions**          | What happened to each person, and can I watch them?    | `/runs/:runId/sessions?variant=&outcome=&aoi=&segment=&step=`            |
| **Session replay**    | What did this one person see, think and do?            | `/runs/:runId/sessions/:sessionId?fix=&t=`                              |
| **Heatmaps**          | Where did they look, click and scroll on this screen?  | `/runs/:runId/attention/:variant/:step?aoi=&overlay=&segment=&outcome=` |
| **Funnel and timing** | Where did they drop out, and what took them so long?   | `/runs/:runId/funnel?segment=&step=`                                    |
| **Analysis**          | What does the model make of all of it?                 | `/runs/:runId/analysis`                                                 |

1. **Summary — the lead.** Wonder's **top recommendations** and the headline numbers: completion rate, median time to
   complete, and the top failure point. For a **path-2** test the lead is instead the **before/after Verdict** of
   sections 2 to 5, unchanged — the sentence, the two completion figures, the reasons, the one heatmap — with the
   recommendations under it. Nothing else on this screen; the quietness rule of section 8 holds.
2. **Sessions.** A **grid of video thumbnails**, one per session, filterable by **outcome, segment and failure step**.
   Each tile carries the person, their segment and device, the outcome tag, the duration, and the step it ended on. The
   list of section 3 stays available as a view of the same data for whoever wants the numbers in rows; the grid is the
   default. Automation failures appear, marked excluded, and are never silently dropped.
3. **Session replay.** Clicking a tile opens the replay of section 3, with the video as its stage: **the video with a
   synced action timeline**, the gaze and click overlay on top of it, and the agent's **stated intent per step** beside
   it. The scrubber moves the video, the gaze, the timeline and the event log together. A recommendation deep-links to
   **the exact timestamp** (`?t=`), and a link with a timestamp opens paused on that frame.
4. **Heatmaps.** Per screen and step, **three overlays**: **clicks**, **attention** and **scroll depth**, each
   toggleable, over the page screenshot with the fold drawn. Filterable by **segment and outcome** — _"where the agents
   who failed clicked"_ is one choice on this screen, not a different screen. The area-of-interest table of section 3
   stays beneath, obeying the same filters, and an area nobody looked at still reads `never` and `0%` in words.
5. **Funnel and timing.** Where agents dropped out, **by screen and step**, as a funnel: reached, completed, abandoned,
   failed, each as a count and a share, with the reason beside the biggest drop. Then the **time-per-step
   distribution** — a distribution, not a mean: median, the 25th and 75th, the 90th, and the slowest sessions listed by
   name with a link to each replay. Filterable by segment.
6. **Analysis.** Wonder's **full write-up**, with **every claim linked to its evidence**: the session ids with the video
   timestamp, the heatmap region, and the funnel step. A claim with no evidence link is not published — the write-up is
   generated from the recommendation objects, which carry their citations, and the screen renders citations rather than
   inventing them.

**The recommendations.** Ranked, each **one plain sentence** a site owner could act on, each citing its evidence:
session ids with the video timestamp, the heatmap region, and the funnel step. They are the same subsystem as the
findings of section 6 — a finding states what happened, a recommendation states what to do about it, and a
recommendation names the findings it rests on. **Every number on every one of these screens is labelled simulated**, and
no screen implies a conversion lift (section 8).

## 15. Path 2: the closed loop on a connected repository (owner)

Everything in path 1, and then:

1. **Connect GitHub.** Onboarding offers it; `/settings/github` is where it lives afterwards. A **GitHub App installed on
   one repository**. Without it, path 2 is shown and locked with the reason (section 11). A connected repository also
   counts as ownership verification for the site it deploys (section 13).
2. **Wonder decides one change.** After a path-1 run, Wonder picks **one targeted change** from its own recommendations —
   not a list, one — writes the code change, and **opens a pull request** on the connected repository. The pull request
   body states the recommendation it comes from, the evidence it cites, and that the numbers behind it are simulated.
   **It never merges. The owner merges.**
3. **The changed version gets a URL.** The repository's own preview deployment for that pull request where it has one;
   otherwise a build we run. **How this works is an open decision and needs the owner** (section 17).
4. **The same audience, the same seeds, plus a holdout.** The baseline and the pull request's version are run with the
   **same audience and the same seeds**, so the comparison is like for like, **plus a holdout set of personas generated
   from the same audience with seeds the change was never chosen against**. The holdout is what keeps the swarm from
   overfitting to itself: a change that wins on the original seeds and not on the holdout is reported as **not
   confirmed**, and says so in the sentence.
5. **The result is the existing A/B Verdict** of sections 2 to 5: did it get better, by how much, and why — with the
   holdout line beside it.
6. **It shows on the platform and is posted as a comment on the pull request.** One comment, updated rather than
   repeated, carrying the before/after figures, the holdout line, the link to the run on the platform, and the
   _simulated_ label on every number.

## 16. What this revision fixes for the workers

- **The artifact is extended, in `packages/contract` and nowhere else.** The additions this direction needs, named here
  so that no two steps invent two spellings: a run's **site** and **goal** (the task sentence, the observable success
  criterion, and who last wrote it), a session's **video** (its run-directory-relative path, duration, and the
  millisecond offset of each screen and action into it), the **aggregate** (funnel by step, the time-per-step
  distribution, click and scroll-depth bins per step, the common paths) and the **recommendations** (ranked, one
  sentence each, with citations into sessions, timestamps, heatmap regions and funnel steps). A run with none of them
  still parses: every addition is optional with no default, and an absent block is a run that recorded none rather than
  a zero somebody measured.
- **One run directory, more files.** `videos/S-NN.webm` and the aggregate and recommendation files sit beside
  `run.json`, `findings.json`, `sessions/` and `screenshots/`, declared by `packages/contract`'s paths module like every
  other path in the directory. The read-only HTTP mount of `CONTEXT.md` gains them by the same rule: the on-disk layout,
  mirrored, with no server-side computation.
- **A step may be a whole page, and such a step declares no primary action.** A step's primary action is the control
  that advances it, named by selector, and a test of **one URL** has none to name: the one step it derives stands for
  the whole site, and nobody designed a control on the site under test. So the declaration is absent rather than stood
  in for, no selector is probed, and every element of such a screen is `isPrimaryAction: false` — the honest statement
  that nobody named a control, and the same thing a page on no step already gets. A task that declares its own steps is
  unchanged: it names its real controls, and a declared control that cannot be resolved is still our automation
  failure.

- **A navigation during a capture is waited out, not an automation failure.** A site that navigates while we read it —
  a redirect, a locale bounce, a framework taking over the first paint, a consent flow replacing the document — is an
  ordinary event on the real web, so the capture waits for the new document and composes the screen once more, and what
  is written is the page the session ended on. It happens inside the capture, below the session budget, so it costs none
  of the session's retries and the `integrity` counters the artifact reports do not move; it happens at most once per
  capture, and a second navigation under the same capture is the automation failure it is today.

- **A model reply that is not JSON is asked again, once, with the parse error fed back.** One malformed reply on one
  screen used to throw away every screen before it, because an unreadable body was the one failure we paid for and did
  not retry. The same question is asked again in the same conversation, carrying the model's own unreadable reply and
  the parse error that names where it broke; the correction is in that one request and never in the session's prefix, so
  no later screen re-sends or re-pays for it. Both calls are billed into the screen's usage and both reach the
  trajectory, so a run's cost still agrees with what was spent. A second unreadable reply is the automation failure it
  is today, with the second reading's detail in its reason. An answer whose envelope carried no reply at all keeps the
  second ask it has always had, with no correction to carry — there is nothing to quote back. Nothing else is asked
  twice: a refusal, an answer our own output cap cut off, a non-2xx status and a timeout are each asked once, as is a
  JSON object the interface rejects, which a model asked twice sends twice.

- **The success criterion is read against the page's own address.** A capture records where it was — read from
  the page, so a `pushState`, a framework route, a redirect or a consent bounce that happened while nobody was
  acting is seen too — and the walk reads the criterion against that address on every screen, and after every
  action against the position the action reached. A same-document navigation is waited for the same bounded
  way a document load already is, within the cap that exists; and on a one-URL run a click that moved the
  address is a click that got the agent somewhere, because neither the step nor the scroll position can move
  to say so. `sessionSchema.screens[]` records the address, **optional with no default**: every session
  written before this revision carries none, and a screen that recorded none says so rather than claiming the
  run's variant URL.

- **The evidence-link parameter list is closed and grows here.** Section 14's routes add `segment`, `step`, `overlay`
  and `t`; they are added to the contract's closed parameter list in the same change, or a deep link cannot be built.
- **The browser is CloakBrowser**, behind `packages/browser`'s existing interface. It is a binary that is downloaded
  like Playwright's own browsers — **never from a `postinstall`** — and a test that needs it **skips visibly, with the
  reason in its name**, when it is absent. How it installs and runs is written down in `packages/browser/README.md` by
  the first ticket that touches it. Video recording survives the swap; that is the one behaviour that is not optional.
- **Muse Wonder goes through `@personavision/provider`**, like every other model call, with an offline deterministic
  implementation behind the same interface. The first Wonder ticket **calls it live on the owner's key
  (`MODEL_API_KEY`)** and documents the model id, the request and response shape and the cost in
  `docs/meta-model-api.md`, exactly as Muse Spark was. The credential rule of `CONTEXT.md` is unchanged: only
  `packages/provider` reads a key, at call time, and never writes it anywhere.
- **Everything keeps working locally first.** File-backed storage, local concurrency, the seeded demo workspace: a fresh
  clone installs, type-checks, lints, tests, builds and demos **with no cloud account, no credential and no network**.
  Anything that needs an account, a credential, a paid resource or a third-party app registration is a
  `stroika:needs-human` ticket (section 17) and blocks nothing else.
- **The words.** Section 8's vocabulary is unchanged and gains these, which are the user's: a **site** (a URL in a
  workspace, verified or not), **verification**, the **goal** (task plus success criterion), **participants** (how many
  simulated people), a **video**, a **recommendation**, the **funnel**, a **segment filter**, the **holdout**, the
  **preview** (the pull request's URL), and **baseline** and **change** for the two versions of a path-2 test.
  _Variant_ stays the internal word the artifact uses for both.

## 17. What this revision needs the owner for

These need an account, a credential, a paid resource or a third-party registration. Each is one ticket labelled
`stroika:needs-human` saying exactly what to create and why. **None of them blocks anything else**, because the local
path is the default everywhere:

1. **Where a hundred concurrent browsers run** — the owner's machine, or managed jobs. Local concurrency is the default
   and is what the caps in section 13 are tuned for.
2. **Storage for session videos** — local disk inside the run directory is the default; an object store is the
   alternative when the platform is hosted.
3. **Hosting the platform** — still deferred by the owner's decision of 2026-10-27. `personavision serve` is the product.
4. **Registering the GitHub App** — path 2 cannot connect a repository without it, and path 1 is unaffected.
5. **A preview build for repositories with no preview deployment of their own** — where the changed version's URL comes
   from when the repository has no Vercel- or Netlify-style preview.
