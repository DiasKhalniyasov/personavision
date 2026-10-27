# Behaviour fixtures

Four pages and the capture set recorded from them: the substrate of the swarm's behavioural
acceptance suite (`../test/behaviour.test.ts`, ticket #55). Three scenarios, each a page
shaped to produce one behaviour, so that step #8's claims are checkable instead of asserted.

```
site/                       the pages, served from disk while recording
captures/capture-set.json   the index: one variant per scenario, with its device and steps
captures/captures/<v>/<s>   one capture per variant and step
captures/screenshots/<v>/<s>.png   the image beside it, which is what salience is read from
```

`pnpm -F @personavision/swarm record:fixtures` writes `captures/` from `site/`. It drives
Chromium through the module's own seams — `openSession`, `capture`, `act` — so a recorded
capture is a live capture and not a hand-written approximation of one. Re-running it over
unchanged pages rewrites identical files, so `.prettierignore` leaves the set alone: it is
recorded data.

**The suite itself starts no browser and opens no socket.** It replays these bytes with every
way of launching a process and every way of opening a socket broken, which is the project's
promise that a cold clone with no API key runs the whole of it.

## The task these pages are written for

`BEHAVIOUR_TASK` in `../test/fixtures.ts`: two steps, `list` then `done`, with the prompt
_"Place the order for the canvas tote bag."_ Every scenario page is on the `list` step — it
carries `#order-panel`, which the step requires, and `#order-submit`, the control the step
declares as its primary action. `done.html` is the `done` step and carries `#done-receipt`.

The prompt's five content words — _place, order, canvas, tote, bag_ — are what the attention
engine's relevance and the offline policy's scoring both read, so they are the one thing
every page below is written around:

- a **control** whose words answer two of the five is worth acting on as soon as the agent has
  looked at it;
- a **paragraph** whose words answer one of the five is worth reading and not worth acting on;
- anything whose words answer none of them is scenery.

## Scenarios

| variant       | page               | height | the page is                                                  |
| ------------- | ------------------ | ------ | ------------------------------------------------------------ |
| `tedious`     | `tedious.html`     | 2400   | long, with the control that finishes it small, grey and last |
| `mislabelled` | `mislabelled.html` | 1800   | loud about the task on a control that does nothing           |
| `vanishing`   | `vanishing.html`   | 1000   | a control that leaves the document under the pointer         |

One device for all three — 390x844 at one device pixel per CSS pixel, so the fold is at 844 —
because the same people walk every variant and a person has one device. A phone's three device
pixels would make the recorded image of a 2400-pixel page nine times the bytes, and the
salience the engine reads off these images is a statistic over the page.

Every landmark is absolutely positioned with its box written on the element, as on
`packages/browser/test/fixtures/site/`: a box is a stated fact rather than the outcome of a
layout, and it is the same box at every viewport.

### `tedious.html` — the task is reachable, and finding it takes looking

`#order-submit` is a 90x18 link in `#8a8a92` on white at the bottom of a 2400-pixel page,
reading _"Order"_ with an accessible name of _"Continue"_. The engine reads an area's
accessible name, so the eye has little reason to go there; the policy reads the visible words
too, so once the agent has looked at it, it is the thing to click. Nothing else on the page
answers the task in words, and four painted cards, five goal-free links and six paragraphs
are in the way.

So a person with no patience spends it on the scenery and leaves, and a person with all of it
keeps looking and finishes — not on every seed, which is why the suite's claim is a count over
a fixed band of eight seeds with a tolerance under it. On that band the rushed person gives up
on six and the dogged one finishes on six.

### `mislabelled.html` — the words are on the wrong element

`#mislabelled-decoy` is a 358x48 blue button reading _"Place the order for the canvas tote
bag"_ — every content word of the task — and it does nothing at all. `#order-submit`, which is
the control that advances the step, is the quiet grey link reading _"Gift options"_. The agent
reads the page, tries the loud control, tries it again, and the task is not done: `failed`,
`attribution: "product"`, counted in the scores. Nothing of ours broke.

### `vanishing.html` — the control is gone by the time the click lands

`#order-submit` reads _"Place the order"_ and its own script takes it out of the document the
moment a pointer goes down on it, which is what a remount under an agent's hands looks like:
the element the agent looked at is not there when the click arrives, and a live driver's
locator never resolves.

A capture is a reading of a page taken **before** the session acted on it, so a replay
resolves every id it holds — right for a page that stays put, and wrong for this one. The
suite's capture source therefore answers `selector_not_found` for the one control this page
takes away, and for nothing else (`behaviourSource` in `../test/fixtures.ts`). The page is
where the defect is declared; the replay is where it is replayed. Which is why this variant
records one step and not two: a recorder that walked through the control would be recording
the defect away.

## What the suite asserts

`../test/behaviour.test.ts`, on observable session behaviour only — the element clicked, the
outcome and the attribution reached, the fixations behind them. Nothing in it asserts a prompt
string or reaches into a provider.

| claim                                                                            | where                                           |
| -------------------------------------------------------------------------------- | ----------------------------------------------- |
| giving up is in character, over a fixed band of seeds with fixed tolerances      | `tedious`, both people                          |
| an abandonment and a success both name their step and their reason               | `tedious`, seed 23                              |
| no action targets an element absent from the fixations of the screen it acted on | every session the suite walks                   |
| a mislabelled primary action is the product's: `failed`, counted                 | `mislabelled`, the dogged person                |
| the same defect read by somebody with no patience is still the product's         | `mislabelled`, the rushed person                |
| our own breakage is ours: `automation_failure`, excluded from every score        | `vanishing`, both people                        |
| the run holding a broken session finishes, and writes the rest                   | a whole `runSwarm` over `vanishing` + `tedious` |
| every session re-runs identical from its persona, seed and page                  | one per scenario, on two seeds                  |

## Changing a page

A page and the capture set recorded from it are one thing: edit `site/` and re-record, or the
suite replays the page as it was. The behaviour the suite measures comes out of the pixels and
the words on these pages, so a change to either moves the counts — re-record, run the suite,
and move a tolerance only once the behaviour it describes has actually changed.
