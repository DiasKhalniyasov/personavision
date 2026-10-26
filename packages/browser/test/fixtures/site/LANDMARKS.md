# Fixture site landmarks

The static site in this directory is the substrate the browser-driving step's tests run
against: six pages, a stylesheet and three images, served from disk by
`serveFixtureSite()` in `../../helpers/static-site.ts`.

**This file is the reference, not the pages.** A test that needs to know an id, a role, an
accessible name, a box or where the fold falls quotes this document and asserts against it;
it does not re-read the HTML to find out what is there. `../../fixture-site.test.ts` checks
every claim below against the served markup, so a page and this record cannot drift apart.

A ticket that needs a case this site does not have **adds it under its own fixtures
directory** rather than editing these pages. Six tickets share them; a new control here
changes what all six see.

Nothing here is user-visible. These pages are not the product and not the demo shop —
`demo/northwind/` is the shop the example run was recorded against, and it is meant to look
like a customer's checkout. This site is meant to be awkward.

## Viewports and the fold

Two viewports, the two the step's tests use:

| name    | viewport | `foldY` |
| ------- | -------- | ------- |
| mobile  | 390x844  | 844     |
| desktop | 1440x900 | 900     |

`foldY` is the viewport's bottom edge in page space at scroll 0, and an element is below the
fold when `y >= foldY` — the rule `belowFold` is computed with.

No page here is shorter than 900 pixels. A page shorter than the viewport reports the
_viewport's_ height as its scroll height, so its page height would differ between the two
viewports and could not be stated once; the heights in the table below are the heights a
browser reports at both.

Every landmark on these pages is absolutely positioned from the document origin, with its
`left`, `top`, `width` and `height` written on the element. So:

- a landmark's page-space box is **the same at both viewports** — nothing reflows, nothing
  centres, and a scrollbar moves nothing, because every box is anchored to the left edge;
- the only thing that differs between the two viewports is which side of the fold a box
  falls on;
- `x` and `y` below are page space. Where a landmark sits inside another, its box is the sum
  of the `left` and `top` values along the chain, which is what the table already records.

## Roles

The `role` columns below are **ARIA role names**: what a `role=` attribute would spell, and
what a role-based locator matches. Every one of them was read back out of Chromium's own
accessibility tree (Chrome 155) against these pages, and two are spelled differently there:

| ARIA name | Chromium's accessibility tree |
| --------- | ----------------------------- |
| `img`     | `image`                       |
| `iframe`  | `Iframe`                      |

`heading`, `paragraph`, `generic`, `region`, `form`, `textbox`, `combobox`, `button` and
`link` are spelled the same in both. An extractor that reads roles straight from the
DevTools protocol therefore sees `image` and `Iframe`; one that goes through ARIA role names
sees what this document says. A name recorded as — is empty in the accessibility tree, not
missing: Chromium reports no accessible name for the paragraphs or for the two regions the
DOM cannot explain.

## Pages

| page                | url                  | step           | page height |
| ------------------- | -------------------- | -------------- | ----------- |
| `cart.html`         | `/cart.html`         | `cart`         | 1400        |
| `payment.html`      | `/payment.html`      | `payment`      | 1200        |
| `review.html`       | `/review.html`       | `review`       | 1100        |
| `confirmation.html` | `/confirmation.html` | `confirmation` | 1000        |
| `no-control.html`   | `/no-control.html`   | none           | 1000        |
| `broken-frame.html` | `/broken-frame.html` | none           | 1000        |

The four step pages are reachable in order, with no script on any page: the cart's
`#cart-checkout` links to `payment.html`, the payment form submits to `review.html`, the
review's `#review-place-order` links to `confirmation.html`, and the confirmation's
`#confirmation-continue-shopping` returns to `cart.html`, so a session can be driven round
more than once.

## Step match rules

The task definition these pages are written for. A step is declared by a URL pattern **and**
a required element, and its primary action is the control that advances it — never inferred
from page text:

```json
[
  {
    "id": "cart",
    "urlPattern": "/cart\\.html",
    "requiredSelector": "#cart-items",
    "primaryAction": "#cart-checkout"
  },
  {
    "id": "payment",
    "urlPattern": "/(payment|no-control)\\.html",
    "requiredSelector": "#payment-form",
    "primaryAction": "#payment-submit"
  },
  {
    "id": "review",
    "urlPattern": "/review\\.html",
    "requiredSelector": "#review-summary",
    "primaryAction": "#review-place-order"
  },
  {
    "id": "confirmation",
    "urlPattern": "/confirmation\\.html",
    "requiredSelector": "#confirmation-receipt",
    "primaryAction": "#confirmation-continue-shopping"
  }
]
```

Two things about those patterns are deliberate, and a test that rewrites them loses the case
it was written for:

- **The payment pattern also matches `/no-control.html`.** That page carries no
  `#payment-form`, so it is the "URL matched, step did not" case: a step detector that
  labels it `payment` is reading the URL alone.
- **No pattern is anchored at its end.** The payment step's primary action is a `GET` form
  submit, so the review page is reached at `/review.html?card=...&expiry=...`. A pattern
  ending in `$` would stop recognising the review step the moment anything is typed.

## Page: cart.html

Carries the fold case, the two same-text controls, the `aria-label`-only control, and both
regions the DOM cannot explain.

### Landmarks

| id                    | element   | role        | accessible name                | visible text       | primary action |
| --------------------- | --------- | ----------- | ------------------------------ | ------------------ | -------------- |
| `cart-banner`         | `div`     | `generic`   | —                              | —                  | —              |
| `cart-heading`        | `h1`      | `heading`   | Your cart                      | Your cart          | —              |
| `cart-intro`          | `p`       | `paragraph` | —                              | —                  | —              |
| `cart-product-image`  | `img`     | `img`       | Canvas tote bag, natural       | —                  | —              |
| `cart-items`          | `section` | `region`    | Cart items                     | —                  | —              |
| `cart-item-tote-name` | `span`    | `generic`   | —                              | Canvas tote bag    | —              |
| `cart-remove-tote`    | `button`  | `button`    | Remove                         | Remove             | —              |
| `cart-save-tote`      | `button`  | `button`    | Save the canvas tote for later | Save               | —              |
| `cart-item-mug-name`  | `span`    | `generic`   | —                              | Enamel mug         | —              |
| `cart-remove-mug`     | `button`  | `button`    | Remove                         | Remove             | —              |
| `cart-upsell-card`    | `div`     | `generic`   | —                              | —                  | —              |
| `cart-checkout`       | `a`       | `link`      | Checkout                       | Checkout           | yes            |
| `cart-promo-apply`    | `button`  | `button`    | Apply a promo code             | Apply a promo code | —              |
| `cart-footer-note`    | `p`       | `paragraph` | —                              | —                  | —              |

- `cart-remove-tote` and `cart-remove-mug` are **the same words in two places**: both read
  `Remove`, both are buttons, and nothing but position tells them apart. A stable element id
  has to give them different ids.
- `cart-save-tote` is **named only by `aria-label`**: it reads `Save` and is named `Save the
canvas tote for later`. A DOM-sourced candidate and an accessibility-sourced candidate for
  this control therefore disagree about its name, which is how the two sources are told
  apart.
- `cart-items` is the cart step's required element; `cart-checkout` is its primary action.

### Geometry

| id                    |   x |    y | width | height | 390x844 | 1440x900 |
| --------------------- | --: | ---: | ----: | -----: | ------- | -------- |
| `cart-banner`         |  16 |   16 |   358 |     48 | above   | above    |
| `cart-heading`        |  16 |   80 |   358 |     40 | above   | above    |
| `cart-intro`          |  16 |  128 |   358 |     56 | above   | above    |
| `cart-product-image`  |  16 |  200 |   120 |    120 | above   | above    |
| `cart-items`          |  16 |  336 |   358 |    240 | above   | above    |
| `cart-item-tote-name` |  28 |  348 |   240 |     20 | above   | above    |
| `cart-remove-tote`    |  28 |  376 |   120 |     32 | above   | above    |
| `cart-save-tote`      | 156 |  376 |   206 |     32 | above   | above    |
| `cart-item-mug-name`  |  28 |  432 |   240 |     20 | above   | above    |
| `cart-remove-mug`     |  28 |  460 |   120 |     32 | above   | above    |
| `cart-upsell-card`    |  16 |  600 |   358 |    160 | above   | above    |
| `cart-checkout`       |  16 |  784 |   358 |     44 | above   | above    |
| `cart-promo-apply`    |  16 |  862 |   358 |     28 | below   | above    |
| `cart-footer-note`    |  16 | 1200 |   358 |     40 | below   | below    |

`cart-promo-apply` is **the control that changes side with the viewport**: it starts at
y 862, which is below a 844-tall viewport's fold and above a 900-tall one's. It is the reason
`belowFold` is worth asserting twice. `cart-checkout` ends at y 828, sixteen pixels above the
mobile fold, so the primary action stays reachable without scrolling at both viewports.

## Page: payment.html

Carries the labelled text input and the select.

### Landmarks

| id                     | element  | role        | accessible name | visible text | primary action |
| ---------------------- | -------- | ----------- | --------------- | ------------ | -------------- |
| `payment-heading`      | `h1`     | `heading`   | Payment         | Payment      | —              |
| `payment-intro`        | `p`      | `paragraph` | —               | —            | —              |
| `payment-card-image`   | `img`    | `img`       | A payment card  | —            | —              |
| `payment-form`         | `form`   | `form`      | Payment details | —            | —              |
| `payment-card-number`  | `input`  | `textbox`   | Card number     | —            | —              |
| `payment-expiry-month` | `select` | `combobox`  | Expiry month    | —            | —              |
| `payment-submit`       | `button` | `button`    | Review order    | Review order | yes            |
| `payment-footer-note`  | `p`      | `paragraph` | —               | —            | —              |

- `payment-card-number` is named by its `<label for>`, not by an `aria-label`, and takes
  text; `payment-expiry-month` is a `<select>` with three options named the same way.
- `payment-form` is the payment step's required element and submits to `review.html` by
  `GET`, which is why the review URL carries a query string.

### Geometry

| id                     |   x |    y | width | height | 390x844 | 1440x900 |
| ---------------------- | --: | ---: | ----: | -----: | ------- | -------- |
| `payment-heading`      |  16 |   16 |   358 |     40 | above   | above    |
| `payment-intro`        |  16 |   72 |   358 |     56 | above   | above    |
| `payment-card-image`   |  16 |  144 |   120 |    120 | above   | above    |
| `payment-form`         |  16 |  288 |   358 |    300 | above   | above    |
| `payment-card-number`  |  28 |  324 |   334 |     32 | above   | above    |
| `payment-expiry-month` |  28 |  396 |   334 |     32 | above   | above    |
| `payment-submit`       |  28 |  468 |   200 |     44 | above   | above    |
| `payment-footer-note`  |  16 | 1000 |   358 |     40 | below   | below    |

## Page: review.html

Carries the link back to the previous step.

### Landmarks

| id                     | element   | role        | accessible name          | visible text      | primary action |
| ---------------------- | --------- | ----------- | ------------------------ | ----------------- | -------------- |
| `review-heading`       | `h1`      | `heading`   | Review your order        | Review your order | —              |
| `review-intro`         | `p`       | `paragraph` | —                        | —                 | —              |
| `review-product-image` | `img`     | `img`       | Canvas tote bag, natural | —                 | —              |
| `review-summary`       | `section` | `region`    | Order summary            | —                 | —              |
| `review-total`         | `span`    | `generic`   | —                        | Total 48.00       | —              |
| `review-back`          | `a`       | `link`      | Back to payment          | Back to payment   | —              |
| `review-place-order`   | `a`       | `link`      | Place order              | Place order       | yes            |
| `review-footer-note`   | `p`       | `paragraph` | —                        | —                 | —              |

`review-back` is the link back to the previous step: it points at `payment.html`, so a back
action can be compared against a link that does the same thing.

### Geometry

| id                     |   x |    y | width | height | 390x844 | 1440x900 |
| ---------------------- | --: | ---: | ----: | -----: | ------- | -------- |
| `review-heading`       |  16 |   16 |   358 |     40 | above   | above    |
| `review-intro`         |  16 |   72 |   358 |     56 | above   | above    |
| `review-product-image` |  16 |  144 |   120 |    120 | above   | above    |
| `review-summary`       |  16 |  288 |   358 |    200 | above   | above    |
| `review-total`         |  28 |  300 |   334 |     24 | above   | above    |
| `review-back`          |  16 |  520 |   358 |     24 | above   | above    |
| `review-place-order`   |  16 |  600 |   358 |     44 | above   | above    |
| `review-footer-note`   |  16 | 1000 |   358 |     40 | below   | below    |

## Page: confirmation.html

### Landmarks

| id                               | element   | role        | accessible name   | visible text      | primary action |
| -------------------------------- | --------- | ----------- | ----------------- | ----------------- | -------------- |
| `confirmation-heading`           | `h1`      | `heading`   | Order confirmed   | Order confirmed   | —              |
| `confirmation-intro`             | `p`       | `paragraph` | —                 | —                 | —              |
| `confirmation-receipt-image`     | `img`     | `img`       | A printed receipt | —                 | —              |
| `confirmation-receipt`           | `section` | `region`    | Receipt           | —                 | —              |
| `confirmation-order-number`      | `span`    | `generic`   | —                 | Order FIX-1001    | —              |
| `confirmation-continue-shopping` | `a`       | `link`      | Continue shopping | Continue shopping | yes            |
| `confirmation-footer-note`       | `p`       | `paragraph` | —                 | —                 | —              |

The confirmation step is the last one, so its primary action is the control that starts the
task again rather than one that advances it.

### Geometry

| id                               |   x |   y | width | height | 390x844 | 1440x900 |
| -------------------------------- | --: | --: | ----: | -----: | ------- | -------- |
| `confirmation-heading`           |  16 |  16 |   358 |     40 | above   | above    |
| `confirmation-intro`             |  16 |  72 |   358 |     56 | above   | above    |
| `confirmation-receipt-image`     |  16 | 144 |   120 |    120 | above   | above    |
| `confirmation-receipt`           |  16 | 288 |   358 |    160 | above   | above    |
| `confirmation-order-number`      |  28 | 300 |   334 |     24 | above   | above    |
| `confirmation-continue-shopping` |  16 | 480 |   358 |     44 | above   | above    |
| `confirmation-footer-note`       |  16 | 940 |   358 |     40 | below   | below    |

## Page: no-control.html

The "URL matched, step did not" case. Its URL matches the payment step's pattern; it carries
no `#payment-form`, and no other step's required element either, so it is on no step. It is
otherwise an ordinary page — a heading, prose, an image and a link — so that a detector
cannot dismiss it as empty.

### Landmarks

| id                   | element | role        | accessible name     | visible text        | primary action |
| -------------------- | ------- | ----------- | ------------------- | ------------------- | -------------- |
| `no-control-heading` | `h1`    | `heading`   | Payment unavailable | Payment unavailable | —              |
| `no-control-intro`   | `p`     | `paragraph` | —                   | —                   | —              |
| `no-control-image`   | `img`   | `img`       | A payment card      | —                   | —              |
| `no-control-back`    | `a`     | `link`      | Back to cart        | Back to cart        | —              |

### Geometry

| id                   |   x |   y | width | height | 390x844 | 1440x900 |
| -------------------- | --: | --: | ----: | -----: | ------- | -------- |
| `no-control-heading` |  16 |  16 |   358 |     40 | above   | above    |
| `no-control-intro`   |  16 |  72 |   358 |     56 | above   | above    |
| `no-control-image`   |  16 | 144 |   120 |    120 | above   | above    |
| `no-control-back`    |  16 | 288 |   358 |     24 | above   | above    |

## Page: broken-frame.html

The frame-error case. Two frames, neither of which can ever load:

- `broken-frame-stalled` points at `/slow`, the route that accepts a connection and never
  answers. The frame stays pending until the driver's own timeout fires.
- `broken-frame-unresolvable` points at `http://frame.invalid/card.html`. `.invalid` is
  reserved and never resolves, so the frame fails at once and without a network.

**Waiting for this page's `load` event waits forever**, by design: the stalled frame never
finishes. A test that opens this page navigates with `domcontentloaded`, or with a timeout it
expects to expire.

### Landmarks

| id                          | element  | role        | accessible name                                    | visible text | primary action |
| --------------------------- | -------- | ----------- | -------------------------------------------------- | ------------ | -------------- |
| `broken-frame-heading`      | `h1`     | `heading`   | Card details                                       | Card details | —              |
| `broken-frame-intro`        | `p`      | `paragraph` | —                                                  | —            | —              |
| `broken-frame-stalled`      | `iframe` | `iframe`    | Card details, served by a route that never answers | —            | —              |
| `broken-frame-unresolvable` | `iframe` | `iframe`    | Card details, served by a host that cannot resolve | —            | —              |
| `broken-frame-submit`       | `button` | `button`    | Pay now                                            | Pay now      | —              |

### Geometry

| id                          |   x |   y | width | height | 390x844 | 1440x900 |
| --------------------------- | --: | --: | ----: | -----: | ------- | -------- |
| `broken-frame-heading`      |  16 |  16 |   358 |     40 | above   | above    |
| `broken-frame-intro`        |  16 |  72 |   358 |     56 | above   | above    |
| `broken-frame-stalled`      |  16 | 144 |   358 |    200 | above   | above    |
| `broken-frame-unresolvable` |  16 | 368 |   358 |    200 | above   | above    |
| `broken-frame-submit`       |  16 | 600 |   358 |     44 | above   | above    |

## Regions the DOM cannot explain

`cart-banner` (a banner) and `cart-upsell-card` (a card) are empty `div`s with a background:
no text, no role, no accessible name, nothing an extractor can read. They are the hand-off
case for segmentation — a DOM- or accessibility-sourced candidate can state their boxes and
nothing else, and the areas of interest inside them are what a later segmenter adds with
`source: "sam"`. Any test that expects a name for either of them is testing the wrong thing.

## Server routes

`serveFixtureSite()` exposes exactly these. Every other path under the site directory is
served as a file when its extension is one of `.html`, `.css`, `.js`, `.svg`, `.png` or
`.ico`, and is a 404 otherwise:

| route                    | method | status | content type                | behaviour                                         |
| ------------------------ | ------ | -----: | --------------------------- | ------------------------------------------------- |
| `/`                      | GET    |    302 | —                           | redirects to `/cart.html`                         |
| `/cart.html`             | GET    |    200 | `text/html; charset=utf-8`  | the cart step page                                |
| `/payment.html`          | GET    |    200 | `text/html; charset=utf-8`  | the payment step page                             |
| `/review.html`           | GET    |    200 | `text/html; charset=utf-8`  | the review step page                              |
| `/confirmation.html`     | GET    |    200 | `text/html; charset=utf-8`  | the confirmation step page                        |
| `/no-control.html`       | GET    |    200 | `text/html; charset=utf-8`  | matches the payment URL, lacks `#payment-form`    |
| `/broken-frame.html`     | GET    |    200 | `text/html; charset=utf-8`  | two frames that never load                        |
| `/fixture.css`           | GET    |    200 | `text/css; charset=utf-8`   | the shared styling and the page heights           |
| `/assets/tote.svg`       | GET    |    200 | `image/svg+xml`             | the cart and review product image                 |
| `/assets/card.svg`       | GET    |    200 | `image/svg+xml`             | the payment image                                 |
| `/assets/receipt.svg`    | GET    |    200 | `image/svg+xml`             | the confirmation image                            |
| `/slow`                  | GET    |      — | —                           | accepts the connection and never answers          |
| `/boom`                  | GET    |    500 | `text/plain; charset=utf-8` | a server error to navigate into                   |
| `/LANDMARKS.md`          | GET    |    404 | `text/plain; charset=utf-8` | not served: this record is not a page of the site |
| `/missing.html`          | GET    |    404 | `text/plain; charset=utf-8` | any file the site does not hold                   |
| `/%2e%2e%2fpackage.json` | GET    |    403 | `text/plain; charset=utf-8` | anything outside the site directory, once decoded |
| `/cart.html`             | POST   |    405 | `text/plain; charset=utf-8` | only GET and HEAD are answered                    |

A literal `/../package.json` never reaches the server: a browser and `fetch` both normalise
it away and ask for `/package.json`, which the site does not hold and whose extension it does
not serve, so that is a 404. The percent-encoded form in the table is the one that arrives,
and it is refused.

A **hard navigation failure** needs no route: point the driver at this site's origin after
`close()`, or at a port nothing listens on, and the navigation fails before any response.
`/boom` is the softer case — the navigation succeeds and the page is a 500.
