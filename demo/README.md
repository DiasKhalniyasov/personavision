# The northwind demo shop

A small static shop with a checkout, served from disk. It is the **system under test**, not
part of the product: it is what the agents browse, and it appears inside PersonaVision only
as a screenshot.

Plain HTML and CSS. No framework, no build step, no JavaScript, no dependency. The whole
task — cart to confirmation — can be completed in a browser with **JavaScript disabled**,
because every step advances by an ordinary link or an ordinary `GET` form submit.

> **Visual values are owned here.** `demo/northwind/shared/shop.css` does not import
> `docs/design/tokens.css` and copies nothing from it. The product's visual language belongs
> to the product; a demo target that inherited it would make every screenshot look like
> PersonaVision instead of like a customer's checkout.

The markup is a transcription of `docs/design/prototype.html`'s `PAGES` constant, taking the
`only-a` branches. **Every `data-aoi` value is reproduced exactly.** Those ids are the areas
of interest the Attention screen names, the findings quote and the ground truth points at, so
renaming one here silently breaks three other tickets. A test asserts that the ids on the
pages are exactly the variant-A ids the prototype declares, and that they are the ids this
file claims.

## Variants

| Variant | Where               | What it is                                                                                                                         |
| ------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **A**   | `demo/northwind/a/` | The current checkout: clean, conventional, the baseline that has to score ≤ 25.                                                    |
| **B**   | `demo/northwind/b/` | The redesign candidate with the three planted defects. **Not built yet** — a later ticket adds it as an honest copy of A's chrome. |

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
| `/shared/shop.css`        | `shared/shop.css`        | the shop's stylesheet                                          |
| `/shared/card-frame.html` | `shared/card-frame.html` | the card-number field, embedded by the payment step            |
| `/shared/help.html`       | `shared/help.html`       | where "Need help?" goes: a real page and a deliberate dead end |

The step pages reach each other in order, and nothing else does:

- **Cart → Payment** — the `Checkout` link, `href="payment.html"`.
- **Payment → Review** — `<form method="get" action="review.html">`, submitted by `Continue to review`.
- **Review → Confirmation** — `<form method="get" action="confirmation.html">`, submitted by `Place order · $137.95`.

`Keep shopping` on the cart returns to the cart, and `Need help?` on the payment and review
steps opens `shared/help.html`. The shop has no catalogue and no support flow, so both are
dead ends on purpose: an area that costs attention without advancing the task is what the
friction score's dead-end-revisit term measures.

## The order

One product, one quantity, all the way through. Variant A states shipping up front, so the
total never changes between steps.

| Line                                   | Value      |
| -------------------------------------- | ---------- |
| Ridgeline hiking boots, size 43, brown | `$129.00`  |
| Shipping                               | `$8.95`    |
| Total                                  | `$137.95`  |
| Order number, on the confirmation page | `NW-20418` |

`$129.00`, `$8.95` and `$137.95` all appear on all four steps. The cart labels the first row
`Subtotal` and the confirmation labels the total row `Paid`; the amounts are the same.

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
are absent from variant A by design, and are the next ticket's.

## The primary action, per page

The one control that advances the task. On variant A it is **above the fold at both
viewports** on every step.

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
(`scrollWidth === clientWidth`) and every primary action's bottom edge sits well inside the
fold:

| Step    | Primary action          | Bottom edge | Fold         |
| ------- | ----------------------- | ----------- | ------------ |
| Cart    | "Checkout"              | 356 px      | 844 / 900 px |
| Payment | "Continue to review"    | 403 px      | 844 / 900 px |
| Review  | "Place order · $137.95" | 308 px      | 844 / 900 px |

The numbers are the same at both viewports, because the column that carries the action is
first either way. Nothing is absolutely positioned, so no scroll offset can move it.

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
