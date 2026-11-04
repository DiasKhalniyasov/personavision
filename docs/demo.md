# Walking path 2 from a cold start

**Path 2 is the closed loop**: after a test, PersonaVision decides one targeted change from its
own recommendations, writes it, opens a pull request on the repository you connected, finds the
URL the changed version is served at, re-runs the same people on the same seeds plus a holdout,
and posts the before/after as one comment on the pull request. **It never merges. You do.**

This document is that loop, walked beat by beat on a **fresh clone, with no credential and no
network**, so that a person can sit down at a clean checkout and watch it happen. Everything it
needs is already in git.

Path 1 — the seven beats of the existing demo, from sign-in to the Verdict — is
`docs/FLOW.md` section 7, walked by `tests/acceptance/demo-walkthrough.test.ts`; the shop both
paths run against is `demo/README.md`. This document is path 2's half, and
`docs/FLOW.md` section 15 is the contract it follows.

## What to run

```sh
pnpm build                                        # once: the walk drives the built application
pnpm test tests/path2-cold-start.test.ts          # the screens, in a real browser
pnpm test packages/improve/tests/walkthrough      # the loop, and the comment, in full
```

The first command is the only one that takes a minute. Neither walk needs a GitHub App, a token,
a network or a model: the repository is a **recorded** one — the same recording every test in
this step runs over — Muse Wonder is the offline provider, and the path-1 run is the example run
committed under `runs/2026-10-24-1402-northwind-demo`.

To **click through it** instead of reading assertions, give the walk somewhere to leave what it
staged:

```sh
PERSONAVISION_PATH2_DIR=/tmp/path2 pnpm test tests/path2-cold-start.test.ts
cd /tmp/path2/confirmed && personavision open      # then open /runs/<run>/improve
```

Three directories appear — `confirmed`, `not-confirmed` and `no-preview` — each a runs root with
one path-2 run in it, and the walk prints the `personavision open` line for each.

## The beats

### 1. A finished path-1 run, and its recommendations

The walk starts from the run a fresh clone already has:
`runs/2026-10-24-1402-northwind-demo` — twenty-four sessions over the northwind demo shop, and
its own `recommendations.json`. Nothing is re-run: path 1 is already written down, and path 2
begins where it ended.

**What to see.** The top-ranked recommendation is the one the change answers. In the committed
run it is **R-03** — _"Make the Payment step easier to get past, where 12 people of this run ran
into trouble."_

### 2. One change, opened as a pull request

Muse Wonder decides **one** change from those recommendations, over the files the connected
repository handed in, and the loop opens it as a pull request on `clipforge/web`:

```
Step 1 of 5 — deciding one change from 5 recommendations, over 1 file.
  app/checkout/page.tsx, answering R-03: Make the Payment step easier to get past, …
Step 2 of 5 — opening the change as a pull request on clipforge/web.
  Pull request #482 is open: https://github.com/clipforge/web/pull/482
```

**What to see.** The pull request's title is the recommendation's own sentence, and its body
states the recommendation, the evidence that recommendation cites, and that every number behind
it is **simulated**. Five calls open it — two reads, a branch, a file and the pull request — and
the branch is this run's own, never the branch it was cut from.

### 3. The preview the repository publishes

```
Step 3 of 5 — resolving the preview for pull request #482.
  The change is served at https://clipforge-web-git-pv.preview.example/cart — …
```

**PersonaVision never runs your build.** The URL comes from the deployment statuses the
repository itself published for that pull request — the owner's answer on #232. A repository
that publishes none stops the loop here, with the sentence that says so — beat 6 below.

### 4. Both versions, the same seeds, and a holdout

```
Step 4 of 5 — driving Baseline at http://127.0.0.1:4173/b/cart.html and The change at
https://clipforge-web-git-pv.preview.example/cart, on the same people and seeds, plus the holdout.
```

The baseline and the change are driven on the **same audience and the same three seed groups**,
plus a **holdout of twenty people** generated from that same audience on a seed the change was
never chosen against. The run that comes out carries the change, the pull request, the preview,
the holdout and the before/after, and `personavision validate` accepts it.

> **One substitution, stated.** A cold-start walk launches no browser, so the sessions are the
> committed run's own with its two versions re-labelled: its _redesign candidate_ — the version
> the recommendations are about, where the three planted defects are — is the **baseline**, and
> its _current checkout_ is **the change**. Every figure printed below is a figure that run
> really measured; what is substituted is which of the two versions is called the baseline. The
> alternative is a second browser run of a repaired shop, which is the acceptance gate's job
> (`tests/acceptance/pipeline.test.ts`), not a cold start's.

### 5. The before and after, on the Improve screen

`/runs/<run>/improve` — **Have the first change written for you.** Four faces, and the walk
drives all four against the **built** application in Chromium, because a green jsdom run does
not answer layout, stacking or the minified stylesheet.

| Face              | What the screen says                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **locked**        | _Not connected yet._ — what connecting gives, the permissions (read the code, write pull requests, **nothing else and no merge permission**), and one _Connect GitHub_ control to `/settings/github`.          |
| **loading**       | The heading, the lede and the lock are already on the page while the connection is read, and nothing moves when the answer arrives.                                                                           |
| **connected**     | The pull request box — title, `clipforge/web #482 · open`, the recommendation, the diff, the preview, _Tested with_ — and _Before and after_ with its three figures.                                           |
| **no preview**    | The pull request, _No preview, so the changed version could not be reached_ with the reason, and **no before/after at all**.                                                                                   |

The lede is on every one of them, in bold, and is never softened: **PersonaVision never merges
it.** You do.

**The three figures, confirmed.** Baseline **0%** (0 of 11 people), with the change **92%**
(11 of 12), holdout **100%** (20 of 20, seeds never used to choose the change). They are about
three sets of people and are never pooled. The notice reads:

> **Confirmed on the holdout.** Outdoor-gear shoppers buy one item quickly on B, not on A.
> Confirmed on the holdout: the 20 people the change was never chosen against did the same.

**The same walk, not confirmed.** The gain on the original seeds is identical — 0% against 92% —
and the twenty went the other way: holdout **100%** on the baseline and **0%** on the change. The
notice is no longer the quiet one, and the sentence **replaces** the headline rather than
qualifying it:

> **Not confirmed on the holdout.** Outdoor-gear shoppers buy one item quickly more easily on B
> than on A, but the 20 people the change was never chosen against did not move with them: this
> gain is not confirmed.

Nothing on that screen reads as a win: there is no _the one to ship_, no arrow and no computed
lift, whatever the holdout said. That face is the one this product exists to be honest about,
which is why the walk asserts its sentence and not only its figures.

### 6. The comment the pull request receives

```
Step 5 of 5 — the comment on pull request #482.
  The comment was posted: https://github.com/clipforge/web/pull/482#issuecomment-55501
```

One comment, updated rather than repeated. The walk asserts it **in full** — every line of it:

```markdown
<!-- personavision:run-comment -->

### Before and after, simulated for Outdoor-gear shoppers

**Confirmed on the holdout.** Outdoor-gear shoppers buy one item quickly on B, not on A. Confirmed on the holdout: the 20 people the change was never chosen against did the same. (simulated)

- **Baseline** — 0% completed the task (simulated), 0 of 11 people
- **With the change** — 92% completed the task (simulated), 11 of 12 people
- **Holdout** — 100% completed the task (simulated), 20 of 20 people, on seeds this change was never chosen against

**Why**

- Nobody ever looked at the button that completes the order on variant A.
- The holdout moved with them, so the gain is the change and not the swarm agreeing with itself.

[See this run on PersonaVision](https://app.personavision.example/runs/2026-10-24-1402-northwind-demo-improve)

Simulated for Outdoor-gear shoppers. It says this change helps these people; it does not estimate what it will do to your conversion rate. Merging is yours.
```

Every line that states a number says it is simulated, and the one thing it links to is the run.
A not-confirmed run leads with **Not confirmed on the holdout.** in that same first line, where a
reader who stops after two lines still sees it.

### A step that says no

Each step can stop the loop, and **what was already done stays done.** The walk-through takes the
stop a real repository is likeliest to hit — no preview deployment:

```
Stopped at the preview step: Path 2 needs a preview deployment: pull request #482 of
clipforge/web has none, so there is no running version of the change to test. PersonaVision
never runs your build — add a per-pull-request preview deployment to the repository and test the
change again.
```

The pull request stays **open** and nothing about it is undone, no comment is posted, and the run
on disk records which step stopped it and why.

## What never happens

Three claims, asserted over the walk's own recorded transcript rather than described here:

- **No merge, no close, no write to the default branch.** The four writes a whole successful loop
  makes are the branch, the file, the pull request and the comment — and the client has no merge,
  close, delete or push call to misuse.
- **No token in anything.** Not in the run, not in a session file, not in a progress line, not in
  the comment, and not in anything the server serves.
- **Nothing off this machine.** The commands are given an environment holding a path and a home
  and nothing else, and every request the page makes to anywhere but the loopback port it started
  is aborted and reported.

## In CI

Both walks run in the `check` job's `pnpm test`, which is where `tests/cold-start.test.ts` runs —
so a change that quietly breaks path 2 fails the build rather than being noticed on a screen.
That job installs Chromium before `pnpm test`, so the browser half is never silently skipped;
on a developer's machine without the browser it is skipped, with the reason in the suite's name.

## What still needs the owner

- **#231 — the GitHub App is not registered.** Nobody can connect a repository until it is, so
  the locked face says exactly that: _"PersonaVision's GitHub App is not registered yet, so there
  is no repository to connect today. Test my site needs nothing from GitHub: start a test there,
  and this path unlocks once the app is live."_ The walk drives that face too, because it is what
  every user sees today. When the App exists, its credentials arrive in the platform's
  environment (#319) and the same screen's other locked wording takes over: _"Install the
  PersonaVision GitHub App on the one repository that deploys …"_.
- **#232 — a repository with no preview of its own.** Answered and closed: **we never run a
  customer's build.** Their build script, their dependencies and their secrets stay on their own
  infrastructure, so path 2 uses the repository's own per-pull-request preview deployment and
  nothing else. A repository that publishes none is told so plainly, in the stop above and on the
  screen's no-preview face, and there is no flag that turns a build runner on.

## What the walk found, and what is left

- **A path-2 run's id is `<run>-improve`**, not `improve-<run>`. A run directory's name is the
  run's id and `listRunDirs` recognises a run directory by its date-and-time prefix, so the
  earlier name was one this product could neither list nor serve: `personavision open` reported
  no test under `./runs` and the Improve screen of a real path-2 run was a 404. Found by this
  walk and fixed in `packages/improve/src/loop.ts`.
- **The run now records the diff, the recommendation's sentence and the pull request's state** —
  which the Improve screen draws, the contract has always carried, and decision 116's option A
  is the screen that was built. Until this walk drove that screen against a run the loop actually
  wrote, none of the three was ever filled, so the box fell back to _"This test recorded no
  patch, so the change itself is on the pull request"_ for every real run.
- **A run that carries its change and a preview that is a stated nothing is not a run this loop
  writes.** A loop stopped at the preview step records a _failed_ run with no change at all, so
  the screen's no-preview face is walked from an artifact staged by hand. The face is right and
  the contract holds it; what is missing is the loop writing one, which is worth a ticket of its
  own.
- **The verdict's sentence names versions by their ids** — _"on B, not on A"_ — and that sentence
  is quoted verbatim into the comment on a customer's pull request. `docs/FLOW.md` section 16
  asks for the user's words, _baseline_ and _the change_; the sentence is
  `@personavision/scoring`'s and is left alone here.
