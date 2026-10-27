# The northwind demo shop

A small static shop with a checkout, served from disk. It is the **system under test**, not
part of the product: it is what the agents browse, and it appears inside PersonaVision only
as a screenshot.

Plain HTML and CSS. No framework, no build step, no JavaScript, and no third-party
dependency — the pages depend on nothing at all. The package depends on two workspace
siblings, and a `workspace:*` range installs nothing: `@personavision/scoring`, for the shape
[the ground truth](#the-planted-defect-ground-truth) is typed against, and
`@personavision/browser`, for the type [the task](#democonfigts-the-task-and-the-step-rules)
is declared with. Driving the shop in a real browser is a test-only concern, so `playwright`
is a dev dependency. The whole task — cart to confirmation — can be completed in a
browser with **JavaScript disabled**, because every step advances by an ordinary link or an
ordinary `GET` form submit.

> **Visual values are owned here.** `demo/northwind/shared/shop.css` does not import
> `docs/design/tokens.css` and copies nothing from it. The product's visual language belongs
> to the product; a demo target that inherited it would make every screenshot look like
> PersonaVision instead of like a customer's checkout.

The markup is a transcription of `docs/design/prototype.html`'s `PAGES` constant: variant A
takes the `only-a` branches, variant B takes both. **Every `data-aoi` value is reproduced
exactly.** Those ids are the areas
of interest the Attention screen names, the findings quote and the ground truth points at, so
renaming one here silently breaks three other tickets. A test asserts that the ids on the
pages are exactly the variant-A ids the prototype declares, and that they are the ids this
file claims.

## The committed example run

One command regenerates `runs/2026-10-24-1402-northwind-demo/` — the example run this
repository ships, and the one every screen opens on a fresh clone:

```sh
pnpm demo:run
```

It serves this shop on **port 4173**, drives twenty-four sessions through Chromium and writes
the whole run directory through `@personavision/contract`. Nothing is written by hand.

|                |                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Command        | `pnpm demo:run`                                                                                                              |
| Seeds          | `20261051`, `20261052`, `20261053` — three seed groups, four generated people, two versions                                  |
| People         | `generatePersonas(OUTDOOR_GEAR_SHOPPERS, { seed: 20261024 })`, the audience's own seed                                       |
| Engine         | `@personavision/engine` 0.0.0, offline deterministic, calibration `null`                                                     |
| Decision layer | `offline-deterministic`; no API key is read and nothing but loopback is reached                                              |
| Wall clock     | about **20 seconds** for the swarm on a laptop, plus the workspace build the command runs first — call it a minute from cold |
| Port           | 4173, and the run stops rather than writing an artifact served from somewhere else                                           |

Two things worth knowing before running it:

- **It builds first.** The script is `pnpm -r build && tsx scripts/generate-demo-run.ts`, with
  no `--conditions=development`. Under that condition the workspace resolves to its
  TypeScript sources and esbuild's `keepNames` injects a `__name` helper into the functions
  the browser step hands to `page.evaluate` — which are serialised into the page, where no
  such helper exists. Every session then comes back as `ReferenceError: __name is not defined`
  and an automation failure.
- **Two runs leave the directory byte-identical.** Every draw is seeded and the artifact's
  timestamps are the run's own rather than the host clock's, so a re-commit is a reviewable
  diff. To check:

  ```sh
  pnpm demo:run && find runs/2026-10-24-1402-northwind-demo -type f | sort | xargs shasum > /tmp/a
  pnpm demo:run && find runs/2026-10-24-1402-northwind-demo -type f | sort | xargs shasum > /tmp/b
  diff /tmp/a /tmp/b
  ```

What the committed run reads as, and the numbers behind it, are on issues #78 and #10;
`tests/demo-run.test.ts` holds it to the shape, the size budget and the acceptance table of
`docs/FLOW.md` section 5.

### The acceptance gate

`tests/acceptance/pipeline.test.ts` is the project's gate: it runs `pnpm demo:run`'s own
script again, into a **temporary** directory, and holds the result to the table above, to the
completion figures, to determinism — including the whole directory being byte-identical twice
over — and to planted-defect precision and recall against `defects.json`. It is tagged,
because it is three browser runs long, so the ordinary `pnpm test` collects it and runs
nothing in it. The command that does run it:

```sh
pnpm build && pnpm test:acceptance
```

CI runs the same two commands as a job of its own after `check`. One difference from
`pnpm demo:run` is worth knowing: under vitest the workspace resolves to its TypeScript
sources rather than to `dist`, so the gate measures the pipeline but not the built output —
which is why the command above still builds first, and why the `keepNames` hazard described
earlier is `pnpm demo:run`'s to catch. The suite writes nothing
into `runs/2026-10-24-1402-northwind-demo/` — it fingerprints that directory before the first
regeneration and compares it after the last one — and the run it produces is offline, names
no model and costs nothing, which it asserts off the artifact.

One of its tests is the gate's own proof: it copies the three served directories of this
shop, deletes the `pushdown` spacer that plants [defect 1](#variant-b-the-three-planted-defects)
from the copy's `b/review.html`, runs the pipeline over that, and requires recall to fall
through the floor the gate asserts. A gate that could not tell a defective shop from a
repaired one would be worth nothing.

## Variants

| Variant | Where               | What it is                                                                                                                                                |
| ------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A**   | `demo/northwind/a/` | The current checkout: clean, conventional, the baseline that has to score ≤ 25.                                                                           |
| **B**   | `demo/northwind/b/` | The redesign candidate: A's pages copied, with the three planted defects and nothing else changed. See [Variant B](#variant-b-the-three-planted-defects). |

Shared chrome — the `NORTHWIND` bar with its cart badge, the summary block, the trust strip
with its "Need help?" link — is styled by one stylesheet under `demo/northwind/shared/`, so
that B differs from A only where a defect is planted.

## URL layout

Served by `serveDemoShop()` from `demo/northwind/`, so a URL path is a file path.

| URL                       | File                     | Step                                                           |
| ------------------------- | ------------------------ | -------------------------------------------------------------- |
| `/`                       | —                        | `302` to `/a/cart.html`                                        |
| `/a/cart.html`            | `a/cart.html`            | 1. Cart                                                        |
| `/a/payment.html`         | `a/payment.html`         | 2. Payment                                                     |
| `/a/review.html`          | `a/review.html`          | 3. Review                                                      |
| `/a/confirmation.html`    | `a/confirmation.html`    | 4. Confirmation                                                |
| `/b/cart.html`            | `b/cart.html`            | 1. Cart, variant B                                             |
| `/b/payment.html`         | `b/payment.html`         | 2. Payment, variant B                                          |
| `/b/review.html`          | `b/review.html`          | 3. Review, variant B                                           |
| `/b/confirmation.html`    | `b/confirmation.html`    | 4. Confirmation, variant B                                     |
| `/shared/shop.css`        | `shared/shop.css`        | the shop's stylesheet                                          |
| `/shared/card-frame.html` | `shared/card-frame.html` | the card-number field, embedded by the payment step            |
| `/shared/help.html`       | `shared/help.html`       | where "Need help?" goes: a real page and a deliberate dead end |

The step pages reach each other in order, and nothing else does. The links and forms are the
same plumbing on both variants — only the wording of the controls differs:

- **Cart → Payment** — the `Checkout` link, `href="payment.html"`.
- **Payment → Review** — `<form method="get" action="review.html">`, submitted by `Continue to review` on A and by `Place order · $129.00` on B.
- **Review → Confirmation** — `<form method="get" action="confirmation.html">`, submitted by `Place order · $137.95` on A and by `Confirm purchase · $147.95` on B.

Relative `href`s, so each variant stays inside its own directory. The one exception is
inherited: `shared/help.html`'s "Back to your cart" link points at `/a/cart.html`, so an
agent that follows it out of variant B lands on variant A. The page tells a reader to use
the back button instead, and the run ticket should treat it as the dead end it is.

`Keep shopping` on the cart returns to the cart, and `Need help?` on the payment and review
steps opens `shared/help.html`. The shop has no catalogue and no support flow, so both are
dead ends on purpose: an area that costs attention without advancing the task is what the
friction score's dead-end-revisit term measures.

## The order

One product, one quantity, all the way through. Variant A states shipping up front, so the
total never changes between steps; variant B defers it and then adds a fee, which is
[defect 2](#variant-b-the-three-planted-defects).

| Line                                   | Value      |
| -------------------------------------- | ---------- |
| Ridgeline hiking boots, size 43, brown | `$129.00`  |
| Shipping                               | `$8.95`    |
| Total                                  | `$137.95`  |
| Order number, on the confirmation page | `NW-20418` |

`$129.00`, `$8.95` and `$137.95` all appear on all four steps of **variant A**. The cart
labels the first row `Subtotal` and the confirmation labels the total row `Paid`; the amounts
are the same.

## Areas of interest, per page

The `data-aoi` ids each page carries. Each appears **exactly once** on the page that declares
it. `cart-badge` is chrome and so appears on every step.

| Page                   | `data-aoi` ids                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `/a/cart.html`         | `cart-badge`, `cart-line`, `cart-total`, `cart-checkout`, `keep-shopping`                |
| `/a/payment.html`      | `cart-badge`, `email`, `card`, `expiry`, `cvc`, `primary`, `summary`, `trust`, `support` |
| `/a/review.html`       | `cart-badge`, `ship-to`, `pay-with`, `complete`, `summary`, `trust`, `support`           |
| `/a/confirmation.html` | `cart-badge`, `confirm`, `order-number`, `summary`                                       |

The ids a variant-B branch of the prototype declares — `promo`, `shipping-row`, `fee-row` —
are absent from variant A by design. Variant B carries them **in addition** to everything in
this table; its own list is in [Variant B](#variant-b-the-three-planted-defects).

## The primary action, per page

The one control that advances the task. On variant A it is **above the fold at both
viewports** on every step. Variant B's are in
[Variant B](#variant-b-the-three-planted-defects), where one of them is not.

| Page                   | Primary action          | Selector                     | Element                                               |
| ---------------------- | ----------------------- | ---------------------------- | ----------------------------------------------------- |
| `/a/cart.html`         | "Checkout"              | `[data-aoi="cart-checkout"]` | `<a>` to `payment.html`                               |
| `/a/payment.html`      | "Continue to review"    | `[data-aoi="primary"]`       | `<button type="submit">`                              |
| `/a/review.html`       | "Place order · $137.95" | `[data-aoi="complete"]`      | `<button type="submit">`, the only button on the step |
| `/a/confirmation.html` | —                       | —                            | a terminal step; nothing advances from it             |

The review step has **exactly one** `<button>`, so "the completing action" is unambiguous for
a driver and for a finding.

## Viewports

| Name    | Size         | Touch | Layout      |
| ------- | ------------ | ----- | ----------- |
| mobile  | `390 × 844`  | yes   | one column  |
| desktop | `1440 × 900` | no    | two columns |

`shop.css` switches `.body` to two columns at `min-width: 768px`, matching the prototype's
mobile rule. The fields-and-action column comes first in document order, so when the layout
stacks, the primary action still precedes the order summary.

Measured in Chrome with device emulation at both viewports, no page scrolls horizontally
(`scrollWidth === clientWidth`) and every primary action on variant A sits well inside the
fold. Variant B's are measured the same way: the promo banner pushes each one down by its own
height, and on the review step the spacer pushes the completing action out of sight entirely.

| Variant | Step    | Primary action               | Bottom edge | Fold         |
| ------- | ------- | ---------------------------- | ----------- | ------------ |
| A       | Cart    | "Checkout"                   | 356 px      | 844 / 900 px |
| A       | Payment | "Continue to review"         | 403 px      | 844 / 900 px |
| A       | Review  | "Place order · $137.95"      | 308 px      | 844 / 900 px |
| B       | Cart    | "Checkout"                   | 442 px      | 844 / 900 px |
| B       | Payment | "Place order · $129.00"      | 488 px      | 844 / 900 px |
| B       | Review  | "Confirm purchase · $147.95" | **1077 px** | 844 / 900 px |

The numbers are the same at both viewports, because the column that carries the action is
first either way. Nothing is absolutely positioned, so no scroll offset can move it. The one
row above the fold on neither viewport is the planted defect; its arithmetic is written out
in [Variant B](#variant-b-the-three-planted-defects).

## The planted-defect ground truth

`demo/northwind/defects.json` is the declared answer: which of variant B's defects were
planted on purpose, so that "the swarm found the planted defects" is computed rather than
remembered. It is read through `demo/northwind/defects.ts`, which validates it against the
`PlantedDefect` shape `@personavision/scoring` exports and is the only thing that parses it.
The file documents, in its own prose, the one real defect it deliberately leaves out and
what that costs in measured precision.

## Variant B: the three planted defects

The redesign candidate. It is `a/*.html` **copied**, with only the regions named below
changed: a test applies the list of edits to variant A's served markup and requires the
result to be variant B's, byte for byte. So B cannot drift from A by accident, and a fourth
defect cannot arrive unannounced. The shared chrome, the page titles and every relative link
are variant A's, untouched. What variant B adds to `shared/shop.css` is the five rules in
that file's last section and the four custom properties they use; no rule between the top of
that file and that section applies to one variant and not the other.

**The task is still completable.** All three defects cost attention and trust; none breaks the
flow, and an agent who scrolls can buy the boots. A broken flow would be a bug rather than a
usability defect, and would make the A/B comparison meaningless.

| #     | Defect                               | Step and page                                                                 | Region                                          | What it does                                                                                                                                                                                                                                                                   |
| ----- | ------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | The completing action nobody sees    | Review, `/b/review.html`                                                      | `complete`                                      | Reads "Confirm purchase · $147.95", sits below a 1400 px spacer that puts it more than one scroll under the fold at both viewports, and wears the shop's weaker button treatment — the same control as variant A's "Place order", demoted. Nothing above it advances the task. |
| **2** | The fee that arrives after the card  | Review, `/b/review.html`; begins on `/b/cart.html`                            | `fee-row`, with `cart-total` and `shipping-row` | A $9.95 service fee appears for the first time **after** payment details are entered. The cart and payment totals read $129.00 with shipping "calculated later" and "calculated at next step"; the review total reads $147.95.                                                 |
| **3** | The banner that takes the first look | Cart, payment and review: `/b/cart.html`, `/b/payment.html`, `/b/review.html` | `promo`                                         | A "SPRING SALE −20% · code SPRING20 · today only" banner sits above the content, so it is first in the reading order and competes with the primary action for the first fixation. It is absent from the confirmation step.                                                     |

### Also carried over, and deliberately not a declared defect

On `/b/payment.html` the primary action reads **"Place order · $129.00"** although it only
advances to the review step. `docs/design/prototype.html` draws it that way and reports it as
a finding of its own, so it stays — the prototype wins. It is **not one of the three** planted
defects, and the cost of that is in the measured precision rather than in the markup: a
scoring run that reports this as a fourth product defect is right about variant B and wrong
about the ground truth, so ground-truth precision against the three declared defects is at
best 3/4 whenever an agent stops at the review step believing it has bought the boots. The
test suite pins it as an edit with defect number `0` so that nobody later mistakes it for a
fourth planted defect or for drift.

### The order, on variant B

| Line                                   | Cart and payment                               | Review and confirmation |
| -------------------------------------- | ---------------------------------------------- | ----------------------- |
| Ridgeline hiking boots, size 43, brown | `$129.00`                                      | `$129.00`               |
| Shipping                               | "calculated later" / "calculated at next step" | `$8.95`                 |
| Service fee                            | —                                              | `$9.95`                 |
| Total, and `Paid` on the confirmation  | `$129.00`                                      | `$147.95`               |

`$137.95` — variant A's total — appears nowhere on variant B. The confirmation's copy of the
service-fee row is a plain row, not an alarmed one: the alarm colour belongs to the step where
the fee first appears, and the confirmation is only a receipt.

### Two things this markup cannot promise

Both are inherited from `docs/design/prototype.html` and are written down here so that a
ticket which scores a run is not surprised by them.

1. **A `fee-row` rect covers the label, not the amount.** The prototype puts
   `data-aoi="fee-row"` on the `<dt>`, and the summary is a two-column grid whose `<dt>` and
   `<dd>` are siblings, so a DOM-sourced rect for the region is the words "Service fee"
   (x 597–872 at `1440 × 900`) and not `$9.95` (x 884–945). A consumer that wants the row
   should union the `<dt>` with the `<dd>` that follows it; one that does not will read
   fixations on the amount as landing in `summary`. The same holds for `shipping-row` on
   `/b/payment.html`.
2. **The review total is five cents more than its own rows.** $129.00 + $8.95 + $9.95 is
   $147.90, and every one of those four figures is fixed by the prototype, by
   `AOI_METRICS` and by this ticket's acceptance criteria, so they are reproduced as given.
   An agent that checks the arithmetic has found something true that the ground truth has no
   entry for. Fixing it means changing the prototype — the fee to $10.00, or the total to
   $147.90 — which is a design-contract change and not this shop's to make.

### Areas of interest, per page

Variant B carries every id variant A carries, plus `promo` on three steps and `shipping-row`
and `fee-row` on one each. Each appears exactly once on the page that declares it.

| Page                   | `data-aoi` ids                                                                                                    | Primary action               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `/b/cart.html`         | `cart-badge`, `promo`, `cart-line`, `cart-total`, `cart-checkout`, `keep-shopping`                                | "Checkout"                   |
| `/b/payment.html`      | `cart-badge`, `promo`, `email`, `card`, `expiry`, `cvc`, `primary`, `summary`, `shipping-row`, `trust`, `support` | "Place order · $129.00"      |
| `/b/review.html`       | `cart-badge`, `promo`, `ship-to`, `pay-with`, `complete`, `summary`, `fee-row`, `trust`, `support`                | "Confirm purchase · $147.95" |
| `/b/confirmation.html` | `cart-badge`, `confirm`, `order-number`, `summary`                                                                | — a terminal step            |

`/b/review.html` has **exactly one** `<button>`, and it is the one marked `complete`, so "the
completing action" is as unambiguous for a driver and for a finding as it is on variant A.

### The spacer, and the fold arithmetic

`.pushdown` in `shared/shop.css` is **1400 px**. The value is measured, not guessed: the
prototype's own `.pushdown` is `height: 150px`, but it is sized for a 9 px thumbnail of a page
and does not transfer to a real browser.

It was 676 px until the first real run (#78). That put the control's top edge 180 px below the
mobile fold, which is below the fold and not out of sight: an agent that scrolls once —
0.75 of a viewport, which is what the decision loop's scroll does — brings it into view, looks
at it, and clicks it. Two of the three sessions that reached variant B's review step fixated
it, so the defect the demo leads with was not planted at all. The spacer now puts the control
past **one** scroll at both viewports: 1748 px against a band that ends at 1477 px on mobile
and 1575 px on desktop. Nobody who reaches the step sees it, which is the claim.

Measured in headless Chromium at both device-emulated viewports, on the top edge of
`[data-aoi="complete"]`:

| Measurement                                        | px   |
| -------------------------------------------------- | ---- |
| Top edge of the completing action, less the spacer | 348  |
| The .pushdown spacer                               | 1400 |
| Top edge of the completing action, as served       | 1748 |
| The fold at 390 x 844                              | 844  |
| Below the mobile fold                              | 904  |
| The fold at 1440 x 900                             | 900  |
| Below the desktop fold                             | 848  |

348 + 1400 = 1748, so the control's top edge is 904 px below the fold at `390 × 844` and 848 px
below it at `1440 × 900`. The first row is arithmetic, not a separate measurement: _deleting_
the spacer puts the top edge at 340 px rather than 348 px, because the button's 8 px top
margin then collapses with the field's 12 px bottom margin instead of stacking after the
spacer. 1748 px and 1400 px are the measured numbers; 348 is the difference between them.

The binding check is **one scroll**, not the fold: the decision loop scrolls by 0.75 of a
viewport, so after one scroll the page is visible to 1477 px on mobile and 1575 px on desktop,
and a control above either of those is found and clicked. 1748 px is past both. The page's
`scrollHeight` is 2057 px at `390 × 844` and 1873 px at `1440 × 900`, so the control is
reachable — two scrolls, or one keyboard End — rather than unreachable.

Those three numbers — 1748 px, and 904 px and 848 px below the two folds — are asserted
against a live browser in `test/drive.test.ts`, off the `belowFold` and `bbox` a capture of
the review step reports. The same test requires variant A's completing action to be above the
fold at both viewports.

One consequence of the figures being the same at both viewports is worth knowing before a run
is scored: at `390 × 844` the one-column stack puts the order summary **after** the completing action, so
the newly revealed fee row is at 1912 px — also below the fold, and below the button. At
`1440 × 900` the summary is in the right column with the fee row at 246 px, above the fold,
and only the completing action is below it. Defect 2 is therefore the one a desktop agent
meets first and a mobile agent meets second.

## The card-number field is in an iframe

On the payment step the card number is **not** in the step's form. It lives in
`shared/card-frame.html`, a same-origin document embedded inside the step's
`data-aoi="card"` region, the way a hosted payment field works. The visible "Card number"
wording stays in the step, as the prototype draws it; the input carries its own
visually-hidden `<label>` so it is labelled in its own document too.

This is not decoration. The committed example run's two automation failures are a selector
timeout on this frame, so the shop has to contain the thing that can time out.

## The stall switch

A request for `shared/card-frame.html` carrying **`?stall=1`** is accepted and **never
answered**: the connection is held open and no response is written.

```text
GET /shared/card-frame.html          -> 200, the card field
GET /shared/card-frame.html?stall=1  -> accepted, never answered
```

The pages have no JavaScript, so they cannot pass `?stall=1` on to the frame themselves. A
driver arms the switch one of two ways, both verified in a real browser:

- **Navigate to the frame's URL directly.** `GET /shared/card-frame.html?stall=1` never
  answers, so a wait for `#card-number` times out.
- **Repoint the frame.** Set the iframe's `src` to `../shared/card-frame.html?stall=1`. The
  frame's `load` never fires and the new document never arrives, so a wait for a selector
  _in the new document_ times out.

Either way the run ticket gets a genuine automation failure instead of hand-editing an
artifact.

It costs nothing else: the server keeps answering every other request while a stalled one is
open, and `close()` destroys open connections, so a stalled request cannot keep the port.

## `demo.config.ts`: the task and the step rules

```ts
import {
  NORTHWIND_DEVICE_MIX,
  NORTHWIND_TASK,
  northwindVariants,
} from '@personavision/northwind-demo/demo.config.ts';

const [variantA, variantB] = northwindVariants(shop.url);
// variantA.url -> "http://127.0.0.1:53412/a/cart.html"
```

`NORTHWIND_TASK` is one `TaskDefinition` of `@personavision/browser`'s own type — the
declaration its step detection and primary-action resolution consume. Its prompt is the task
sentence, verbatim: **"Buy the hiking boots and pay with the saved card."**

| Step id   | URL pattern                | Required element            | Primary action               |
| --------- | -------------------------- | --------------------------- | ---------------------------- |
| `cart`    | `/[ab]/cart\.html`         | `[data-aoi="cart-line"]`    | `[data-aoi="cart-checkout"]` |
| `payment` | `/[ab]/payment\.html`      | `[data-aoi="card"]`         | `[data-aoi="primary"]`       |
| `review`  | `/[ab]/review\.html`       | `[data-aoi="pay-with"]`     | `[data-aoi="complete"]`      |
| `confirm` | `/[ab]/confirmation\.html` | `[data-aoi="order-number"]` | `[data-aoi="order-number"]`  |

- **The ids are the prototype's `STEPS`.** `docs/FLOW.md` section 8 writes the fourth step as
  _confirmation_ and the page file keeps its ordinary name `confirmation.html`, but the **id**
  is `confirm`, because `@personavision/contract` leaves a step a free name and the prototype
  then decides. Recorded on #10, so the run artifact, the Attention filmstrip and the
  screenshot paths agree with the shop.
- **One task drives both variants.** The patterns match `/a/…` and `/b/…`, and the selectors
  are regions both variants carry. They match on the **path**: steps 3 and 4 are reached by a
  `GET` form submit, so the URL arrives carrying a query string.
- **The confirmation step is terminal and still names an element.** Nothing advances from it,
  so its "primary action" is the order number — what tells the person the task is done, and
  what attention on that screen is attributed to. A step naming nothing would raise
  `selector_not_found` on every session's last screen and exclude the run.
- **A page off the task carries no step label**, and no label is ever read from a page's
  words: `shared/help.html` shows the `Cart (1)` badge and `shared/card-frame.html` says
  "Card number", and both come back unlabelled.
- **Nothing hard-codes a port.** `northwindVariants(baseUrl)` derives both start URLs from
  whatever base `serveDemoShop()` reports.
- `NORTHWIND_DEVICE_MIX` is which device each of the prototype's four personas is on: the
  rushed buyer and the price-sensitive scanner on mobile (`390 × 844`, touch), the careful
  comparer and the first-time visitor on desktop (`1440 × 900`). The two devices carry the
  names `@personavision/personas` gives those classes — `iPhone 15` and `MacBook Air 13` — so a
  session driven off this mix records the device name a generated persona would carry.

`test/drive.test.ts` is the proof: both variants driven from the cart URL to
`/<variant>/confirmation.html` with the order number on screen, every screen labelled with
its own step id, exactly one element per screen carrying `isPrimaryAction`, and the completing
action on variant B scrolled to because it is below the fold. It starts the shop on a free
port, needs no key and reaches nothing but loopback.

## `serveDemoShop()`

```ts
import { serveDemoShop } from '@personavision/northwind-demo/serve.ts';

const shop = await serveDemoShop();
// shop.url  -> "http://127.0.0.1:53412" (no trailing slash)
// shop.port -> 53412
await fetch(`${shop.url}/a/cart.html`);
await shop.close();
```

- `node:http` and `node:fs` only. No dependency, and nothing reaches the network: it binds
  loopback.
- **A free port per instance.** `port` defaults to `0`, so the operating system picks one and
  two shops can run side by side without colliding.
- `close()` stops listening, destroys open connections and resolves once the port is free.
- Correct content types, from the file extension; unknown extensions are
  `application/octet-stream`.
- `GET` and `HEAD` only; anything else is `405`. A path that escapes the root is `403`.
  There is no directory listing and no index fallback.
- **A URL path is a file path.** A directory-shaped path is `404`, not the file above it:
  `/a/cart.html/` would otherwise answer with the cart page, whose relative links and
  stylesheet would then all resolve one level too deep — a page that looks to a driver like
  a success and cannot advance.
- **Only `a/`, `b/` and `shared/` are served.** The root also holds the package's own files,
  and a shop that served its own server's source would be a poor stand-in for a customer's
  site, so `/serve.ts`, `/package.json` and `/test/…` are all `404`.
- Options: `{ port, host, root }`. `root` defaults to `demo/northwind/`, and `b` is already
  in the served set, so variant B needs no change here. An IPv6 `host` comes back bracketed
  (`http://[::1]:53412`) so the origin parses.

Because the shop ships as source, `demo/northwind` emits no `dist/`: its `build` script is a
type-check, and `serve.ts` is run through Vitest or `tsx`.
