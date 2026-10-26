# PersonaVision — flow contract

This file and `docs/design/prototype.html` are the design contract for the whole project.
Every ticket that touches a screen, a route, a number or a word the user reads builds against them.
`docs/design/tokens.css` is the single source of visual truth; screens import it instead of restating values.

**Section numbers in this file are stable.** Tickets cite them (`section 3` for the routes, `section 5` for the
friction score and its acceptance table, `section 6` for findings, `section 7` for the demo beats, `section 8` for the
vocabulary, `section 9` for what is deferred). A revision adds sections at the end rather than renumbering.

## Where the answers come from

The flow questions were asked on issue #1 (comment marked `stroika:flow-questions`) and answered **(auto)** when the
owner had not yet replied. On 2026-10-26 the owner replied on #1 and **overrode answers 1, 2, 3, 5 and 7, and set the
visual direction**. Those five are now tagged **(owner)** and are not a worker's to reconsider. Answers 4 and 6 stand as
taken and remain **(auto)**, overridable the same way: change this file first, then the prototype, then the tickets.

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
  failure_ when our own browsing broke. Those three are never merged.
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
