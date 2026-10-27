/**
 * The task the demo shop is driven with: the sentence, the two variants and the four steps.
 *
 * This file is the **declaration** that `@personavision/browser`'s step detection and
 * primary-action resolution consume (#47): a step is recognised by its URL pattern *and* a
 * required element, and the control that advances it is named by a selector. Nothing here is
 * inferred from a page's words, so a page the task does not cover carries no step label at
 * all — `shared/help.html` says "Cart (1)" in its chrome and is on no step.
 *
 * Three things are deliberate:
 *
 * 1. **Nothing hard-codes a port.** `serveDemoShop()` takes a free one, so the variants are
 *    derived from whatever base URL the shop reports.
 * 2. **One task drives both variants.** The patterns match `/a/…` and `/b/…`, and the
 *    selectors are the regions both variants carry — variant B is variant A plus three
 *    planted defects, and a task that needed its own spelling for B would not be comparing
 *    the same checkout. The patterns match on the **path**: steps 3 and 4 are reached by a
 *    GET form submit, so the URL arrives carrying a query string.
 * 3. **The step ids are the prototype's** — `cart`, `payment`, `review`, `confirm`, as
 *    `docs/design/prototype.html`'s `STEPS` gives them. `@personavision/contract` leaves a
 *    step a free name, so the prototype decides; the page file keeps its ordinary name
 *    `confirmation.html`. Recorded on #10 so the run artifact, the Attention filmstrip and
 *    the screenshot paths agree with the shop.
 *
 * Every shape is the browser package's, imported as a type: no field name is restated here.
 */

import type { Device, TaskDefinition, Variant } from '@personavision/browser';

/**
 * The devices the audience runs on, with the geometry `demo/README.md`'s Viewports table
 * measures the shop at and the scale factors `@personavision/personas` runs its classes on.
 */
const MOBILE: Device = {
  name: 'mobile',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  touch: true,
};

const DESKTOP: Device = {
  name: 'desktop',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  touch: false,
};

/**
 * The task, as the demo states it. The sentence is the user's and is quoted verbatim by the
 * Verdict screen and the run artifact, so it is one string and not assembled.
 */
export const NORTHWIND_TASK: TaskDefinition = {
  id: 'northwind-checkout',
  prompt: 'Buy the hiking boots and pay with the saved card.',
  steps: [
    {
      id: 'cart',
      label: 'Cart',
      // The cart line is what makes this the cart rather than any page under `/cart.html`.
      match: { urlPattern: '/[ab]/cart\\.html', requiredSelector: '[data-aoi="cart-line"]' },
      primaryAction: { selector: '[data-aoi="cart-checkout"]' },
    },
    {
      id: 'payment',
      label: 'Payment',
      // The card region, whose `#card-number` lives in a child frame — present in this
      // page's markup, which is all a required element has to be.
      match: { urlPattern: '/[ab]/payment\\.html', requiredSelector: '[data-aoi="card"]' },
      primaryAction: { selector: '[data-aoi="primary"]' },
    },
    {
      id: 'review',
      label: 'Review',
      match: { urlPattern: '/[ab]/review\\.html', requiredSelector: '[data-aoi="pay-with"]' },
      // The only `<button>` on the step, on both variants. On variant B it sits below the
      // fold at both viewports, which is planted defect 1 rather than a broken declaration.
      primaryAction: { selector: '[data-aoi="complete"]' },
    },
    {
      id: 'confirm',
      label: 'Confirmation',
      match: {
        urlPattern: '/[ab]/confirmation\\.html',
        requiredSelector: '[data-aoi="order-number"]',
      },
      // Nothing advances a terminal step, and a step must still name one element: the order
      // number is what tells the person the task is done, so it is what attention on this
      // screen is attributed to. Leaving it unnamed would raise `selector_not_found` on
      // every session's last screen and exclude the run.
      primaryAction: { selector: '[data-aoi="order-number"]' },
    },
  ],
};

/**
 * Where a session of each variant starts, against the base URL the shop reports — e.g.
 * `http://127.0.0.1:53412`, with no trailing slash. The ids are the run artifact's.
 */
export const northwindVariants = (baseUrl: string): Variant[] => [
  { id: 'a', url: `${baseUrl}/a/cart.html` },
  { id: 'b', url: `${baseUrl}/b/cart.html` },
];

/**
 * Which device each of the prototype's four personas is on: the rushed buyer and the
 * price-sensitive scanner on mobile, the careful comparer and the first-time visitor on
 * desktop. The keys are `PERSONAS`' own ids.
 */
export const NORTHWIND_DEVICE_MIX: Readonly<Record<string, Device>> = {
  rushed: MOBILE,
  careful: DESKTOP,
  firsttime: DESKTOP,
  price: MOBILE,
};
