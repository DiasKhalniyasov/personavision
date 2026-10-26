/**
 * Generates the committed seed example run at `runs/2026-10-24-1402-northwind-demo/`.
 *
 * The data is not invented. It is the representative run written into
 * `docs/design/prototype.html` — that file's `STEPS`, `PAGES`, `FIX`, `AOI_METRICS`,
 * `STEP_CAPTION`, `FINDINGS`, `PERSONAS`, `SESSIONS` and `REPLAY` constants, plus the
 * required reading of `docs/FLOW.md` section 5 — transcribed here and assembled into a
 * schema-valid run directory through `@personavision/contract`'s writer and path helpers.
 *
 * It is deterministic: every sample comes from the contract's seeded random helper, so
 * running it twice leaves the directory byte-identical and the committed artifact is
 * exactly what this script produces. Nothing here reaches the network or reads a
 * credential.
 *
 * The fixture is temporary in character and permanent in location: the offline engine's
 * genuine artifact replaces it in place, at this path and under this schema, so nothing
 * here says "this is fake" beyond `engine.version: "seed-fixture"`.
 *
 * The per-area numbers in `run.aoiMetrics` are not transcribed: they are computed from
 * this run's own session files by `@personavision/engine`'s `aggregate`, the one place in
 * the project where per-area numbers are made. So the committed artifact is exactly what
 * the engine produces from it, and the screens are calibrated on numbers the genuine
 * artifact will reproduce. The prototype's `AOI_METRICS` table still fixes every area's
 * label and source, and its readings are what the anchors below are shaped to approach.
 * One reading it prints cannot be reproduced: its time to first fixation counts from the
 * moment a step appeared, and a session carries no per-step onset, so `aggregate` counts
 * from the start of the session. #57 owns that.
 *
 * Two deliberate departures from a genuine run, both named on the ticket:
 *
 * - The screenshots are rendered placeholders rather than captures of the demo shop. They are
 *   drawn at one viewport, the mobile 390 x 844 the demo's replay session uses, because
 *   `run.json` records one screenshot per variant and step and the areas of interest have
 *   to register to that image. A desktop persona keeps its own device in the session file;
 *   its gaze is projected into the placeholder's coordinate space.
 * - Only the JSON is byte-stable across machines. The placeholder PNGs rasterise text, so
 *   their bytes depend on the fonts installed; re-running on another platform rewrites
 *   them without changing the data.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createSeededRandom, runDirName, runPaths, writeRun } from '@personavision/contract';
import { aggregate } from '@personavision/engine';
import type { Findings, Run, Session } from '@personavision/contract';

/* ===== the run's fixed shape =============================================== */

const CREATED_AT = new Date('2026-10-24T14:02:00Z');
const RUN_NAME = 'northwind-demo';

/** `2026-10-24-1402-northwind-demo` — the directory name and the run id. */
export const RUN_ID = runDirName(CREATED_AT, RUN_NAME);

/** The one coordinate space the placeholder screenshots and the areas of interest share. */
const VIEWPORT = { width: 390, height: 844 };

/** Every placeholder page is taller than the viewport, so each one has a fold to draw. */
const PAGE_MIN_HEIGHT = 980;
const FILLER_MIN_HEIGHT = 160;

/** "Confirm purchase" sits about 180 px below the fold on variant B's review step. */
const COMPLETE_BELOW_FOLD_BY = 180;

/** How far a session's gaze may wander before it must have scrolled to follow it. */
const SCROLL_SPAN = 760;
const SCROLL_MARGIN = 60;

const TASK = {
  id: 'buy-boots',
  prompt: 'Buy the hiking boots and pay with the saved card.',
};

type VariantId = 'A' | 'B';

/**
 * The two versions of the checkout, named as the Comparison screen names them. The urls
 * are the entry pages `demo/northwind/serve.ts` serves — it binds an ephemeral port and
 * prints it, so the port here is only a placeholder; variant B's pages arrive with #10.
 */
const VARIANTS: Array<{ id: VariantId; name: string; url: string }> = [
  { id: 'A', name: 'Current checkout', url: 'http://localhost:4173/a/cart.html' },
  { id: 'B', name: 'Redesign candidate', url: 'http://localhost:4173/b/cart.html' },
];

type StepId = 'cart' | 'payment' | 'review' | 'confirm';

const STEPS: Array<{ id: StepId; label: string }> = [
  { id: 'cart', label: 'Cart' },
  { id: 'payment', label: 'Payment' },
  { id: 'review', label: 'Review' },
  { id: 'confirm', label: 'Confirmation' },
];

const STEP_PATH: StepId[] = ['cart', 'payment', 'review', 'confirm'];

const SEED_GROUPS = [1, 2, 3];

/**
 * Sessions per variant that reached each step, from the prototype's `STEPS.reach`. The
 * sessions on disk agree with it; a test asserts that rather than this table being read.
 */
const REACH: Record<VariantId, Record<StepId, number>> = {
  A: { cart: 11, payment: 9, review: 9, confirm: 9 },
  B: { cart: 11, payment: 10, review: 9, confirm: 2 },
};

/* ===== personas ============================================================ */

type PersonaId = 'rushed' | 'careful' | 'firsttime' | 'price';

const MOBILE = {
  name: 'iPhone 15',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  touch: true,
};

const DESKTOP = {
  name: 'MacBook Air 13',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  touch: false,
};

const PERSONAS: Array<Run['personas'][number] & { id: PersonaId }> = [
  {
    id: 'rushed',
    name: 'Rushed buyer',
    traits: {
      persistence: 0.25,
      scanningVsReading: 0.9,
      detailOrientation: 0.2,
      interfaceFamiliarity: 0.75,
      patience: 0.15,
      riskTolerance: 0.7,
    },
    device: MOBILE,
  },
  {
    id: 'careful',
    name: 'Careful comparer',
    traits: {
      persistence: 0.85,
      scanningVsReading: 0.2,
      detailOrientation: 0.9,
      interfaceFamiliarity: 0.6,
      patience: 0.85,
      riskTolerance: 0.25,
    },
    device: DESKTOP,
  },
  {
    id: 'firsttime',
    name: 'First-time visitor',
    traits: {
      persistence: 0.5,
      scanningVsReading: 0.45,
      detailOrientation: 0.5,
      interfaceFamiliarity: 0.15,
      patience: 0.55,
      riskTolerance: 0.35,
    },
    device: DESKTOP,
  },
  {
    id: 'price',
    name: 'Price-sensitive scanner',
    traits: {
      persistence: 0.6,
      scanningVsReading: 0.8,
      detailOrientation: 0.7,
      interfaceFamiliarity: 0.5,
      patience: 0.4,
      riskTolerance: 0.3,
    },
    device: MOBILE,
  },
];

const personaById = (id: PersonaId): (typeof PERSONAS)[number] => {
  const persona = PERSONAS.find((candidate) => candidate.id === id);
  if (persona === undefined) throw new Error(`no persona ${id}`);
  return persona;
};

/** What the agent says it is doing, per persona and step. */
const INTENT: Record<PersonaId, Record<StepId, string>> = {
  rushed: {
    cart: 'See what the boots cost in total before I put a card in.',
    payment: 'Pay as fast as possible, the card is saved.',
    review: 'Confirm it and get out.',
    confirm: 'Check it actually went through.',
  },
  careful: {
    cart: 'Check the size and the shipping before I commit.',
    payment: 'Make sure the card and the email are right.',
    review: 'Read every line of the total before I pay.',
    confirm: 'Note the order number and the delivery date.',
  },
  firsttime: {
    cart: 'Work out whether this is the right page to pay on.',
    payment: 'Find where the card goes and what happens next.',
    review: 'Understand what I am agreeing to.',
    confirm: 'Make sure that was the end of it.',
  },
  price: {
    cart: 'See the real total with shipping before anything else.',
    payment: 'Check nothing has been added to the price.',
    review: 'Check the total has not moved since the cart.',
    confirm: 'Confirm what I was charged.',
  },
};

/** The one intent the prototype's replay states in the agent's own words, on variant B. */
const INTENT_ON_B: Partial<Record<PersonaId, Partial<Record<StepId, string>>>> = {
  rushed: { review: 'I thought I had paid. Why is the total higher than it was?' },
};

/* ===== the sessions, from the prototype's SESSIONS table =================== */

interface SessionRow {
  persona: PersonaId;
  variant: VariantId;
  seed: number;
  status: Session['outcome']['status'];
  seconds: number;
  fixations: number;
  endedAt: StepId;
  reason: string;
}

const PLACED = 'Order placed';
const BELIEVED_BOUGHT = 'Review — believed “Place order” had bought it; no order placed';
const SHIPPING_REREAD = 'Cart — re-read $8.95 shipping, then left';
const SELECTOR_TIMEOUT = 'Payment — selector timeout on the card iframe';

// prettier-ignore
const SESSION_ROWS: SessionRow[] = [
  { persona: 'rushed', variant: 'A', seed: 1, status: 'success', seconds: 22.4, fixations: 31, endedAt: 'confirm', reason: PLACED },
  { persona: 'rushed', variant: 'A', seed: 2, status: 'success', seconds: 24.1, fixations: 34, endedAt: 'confirm', reason: PLACED },
  { persona: 'rushed', variant: 'A', seed: 3, status: 'success', seconds: 21.8, fixations: 29, endedAt: 'confirm', reason: PLACED },
  { persona: 'careful', variant: 'A', seed: 1, status: 'success', seconds: 38.6, fixations: 52, endedAt: 'confirm', reason: PLACED },
  { persona: 'careful', variant: 'A', seed: 2, status: 'success', seconds: 41.2, fixations: 56, endedAt: 'confirm', reason: PLACED },
  { persona: 'careful', variant: 'A', seed: 3, status: 'success', seconds: 39.4, fixations: 54, endedAt: 'confirm', reason: PLACED },
  { persona: 'firsttime', variant: 'A', seed: 1, status: 'success', seconds: 28.7, fixations: 44, endedAt: 'confirm', reason: PLACED },
  { persona: 'firsttime', variant: 'A', seed: 2, status: 'success', seconds: 31.0, fixations: 47, endedAt: 'confirm', reason: PLACED },
  { persona: 'firsttime', variant: 'A', seed: 3, status: 'automation_failure', seconds: 12.2, fixations: 18, endedAt: 'payment', reason: SELECTOR_TIMEOUT },
  { persona: 'price', variant: 'A', seed: 1, status: 'success', seconds: 33.9, fixations: 49, endedAt: 'confirm', reason: PLACED },
  { persona: 'price', variant: 'A', seed: 2, status: 'abandoned', seconds: 19.5, fixations: 27, endedAt: 'cart', reason: SHIPPING_REREAD },
  { persona: 'price', variant: 'A', seed: 3, status: 'abandoned', seconds: 18.1, fixations: 25, endedAt: 'cart', reason: SHIPPING_REREAD },
  { persona: 'rushed', variant: 'B', seed: 1, status: 'failed', seconds: 26.3, fixations: 33, endedAt: 'review', reason: BELIEVED_BOUGHT },
  { persona: 'rushed', variant: 'B', seed: 2, status: 'failed', seconds: 25.8, fixations: 31, endedAt: 'review', reason: BELIEVED_BOUGHT },
  { persona: 'rushed', variant: 'B', seed: 3, status: 'abandoned', seconds: 38.0, fixations: 23, endedAt: 'review', reason: 'Review — service fee revealed, left without ordering' },
  { persona: 'careful', variant: 'B', seed: 1, status: 'success', seconds: 58.4, fixations: 71, endedAt: 'confirm', reason: PLACED },
  { persona: 'careful', variant: 'B', seed: 2, status: 'abandoned', seconds: 49.7, fixations: 63, endedAt: 'review', reason: 'Review — service fee revealed, 3 revisits, then left' },
  { persona: 'careful', variant: 'B', seed: 3, status: 'abandoned', seconds: 46.2, fixations: 59, endedAt: 'review', reason: 'Review — service fee revealed, then left' },
  { persona: 'firsttime', variant: 'B', seed: 1, status: 'failed', seconds: 44.1, fixations: 58, endedAt: 'review', reason: BELIEVED_BOUGHT },
  { persona: 'firsttime', variant: 'B', seed: 2, status: 'abandoned', seconds: 36.5, fixations: 41, endedAt: 'payment', reason: 'Payment — never fixated the primary action, gave up' },
  { persona: 'firsttime', variant: 'B', seed: 3, status: 'success', seconds: 52.8, fixations: 66, endedAt: 'confirm', reason: PLACED },
  { persona: 'price', variant: 'B', seed: 1, status: 'abandoned', seconds: 29.4, fixations: 37, endedAt: 'cart', reason: 'Cart — “calculated later” distrusted, left' },
  { persona: 'price', variant: 'B', seed: 2, status: 'automation_failure', seconds: 15.6, fixations: 21, endedAt: 'payment', reason: SELECTOR_TIMEOUT },
  { persona: 'price', variant: 'B', seed: 3, status: 'abandoned', seconds: 41.0, fixations: 52, endedAt: 'review', reason: 'Review — service fee revealed, left without ordering' },
];

const sessionIdOf = (index: number): string => `S-${String(index + 1).padStart(2, '0')}`;

/** `S-15`, the rushed buyer on mobile on variant B: the session the demo opens. */
const REPLAY_SESSION_ID = 'S-15';

/**
 * The prototype's replay pins `S-15` to the fixation and second it shows: 7 fixations over
 * the cart in the first 9 s, 12 over the payment step to 0:27, 4 over the review step to
 * the exit at 0:38.
 */
const REPLAY_STEPS: Array<{ step: StepId; fixations: number; fromMs: number; toMs: number }> = [
  { step: 'cart', fixations: 7, fromMs: 0, toMs: 9000 },
  { step: 'payment', fixations: 12, fromMs: 9000, toMs: 27000 },
  { step: 'review', fixations: 4, fromMs: 27000, toMs: 38000 },
];

/**
 * `S-20` is the one session of the ten that reached variant B's payment step that never
 * fixated the primary action — its outcome says so, and the 92% reach of the promo banner
 * and the primary action on that step is the same one session missing from both.
 */
const NEVER_FIXATED: Record<string, Partial<Record<StepId, string[]>>> = {
  'S-20': { payment: ['promo', 'primary'] },
};

/**
 * Areas the prototype's table reports as glanced at by a minority of sessions — the trust
 * badges, the "Need help?" link, the "Keep shopping" escape. They are off the canonical
 * scanpath, so a session looks at one only when its own draw falls under the share the
 * prototype prints. Without them the table would report attention nobody paid; with them
 * every non-zero reading has a fixation behind it, and `never` stays rare enough on
 * variant B's completing action to read as the finding it is.
 *
 * `share` is the share the prototype's table prints. It is the draw's threshold, not the
 * reading: what `run.json` ends up carrying is measured off the fixations like every other
 * per-area number, so a short scanpath can leave an area at a lower share, or at none.
 */
const PERIPHERAL: Record<string, Array<Anchor & { share: number }>> = {
  'A-cart': [{ aoi: 'keep-shopping', ox: 0.5, oy: 0.5, dur: 180, share: 0.27 }],
  'B-cart': [{ aoi: 'keep-shopping', ox: 0.5, oy: 0.5, dur: 190, share: 0.36 }],
  'A-payment': [
    { aoi: 'trust', ox: 0.5, oy: 0.5, dur: 200, share: 0.36 },
    { aoi: 'support', ox: 0.5, oy: 0.5, dur: 190, share: 0.18 },
  ],
  'B-payment': [
    { aoi: 'trust', ox: 0.5, oy: 0.5, dur: 210, share: 0.41 },
    { aoi: 'support', ox: 0.5, oy: 0.5, dur: 280, share: 0.58 },
  ],
  'A-review': [{ aoi: 'support', ox: 0.5, oy: 0.5, dur: 180, share: 0.09 }],
};

/** An agent who gives up on variant B's review step looks for help before leaving. */
const LEAVES_LOOKING_FOR_HELP = 'support';

/* ===== the page layouts ==================================================== */

type AoiSource = 'dom' | 'a11y' | 'sam';

interface AoiSpec {
  id: string;
  label: string;
  source: AoiSource;
  role: string | null;
  isPrimaryAction?: boolean;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Child {
  aoi: AoiSpec;
  x: number;
  width: number;
  height: number;
  /** Offset from the top of the block the area sits inside. */
  dy: number;
}

interface Block {
  aoi?: AoiSpec;
  /** Drawn in the placeholder for a block that is not an area of interest. */
  caption?: string;
  height?: number;
  /** Stretch the block down to this absolute y instead of giving it a height. */
  fillTo?: number;
  /** Space above the block. */
  gap?: number;
  x?: number;
  width?: number;
  /** An absolute y, for the content variant B's review step pushes the button past. */
  startAt?: number;
  /** Sit beside the block before it rather than under it. */
  sameRow?: boolean;
  children?: Child[];
}

interface PlacedBox {
  aoi?: AoiSpec;
  caption?: string;
  box: Box;
}

interface PageLayout {
  boxes: PlacedBox[];
  pageHeight: number;
  foldY: number;
}

const CONTENT_X = 16;
const CONTENT_WIDTH = VIEWPORT.width - CONTENT_X * 2;

const aoi = (
  id: string,
  label: string,
  source: AoiSource,
  role: string | null,
  isPrimaryAction = false,
): AoiSpec => ({ id, label, source, role, isPrimaryAction });

const shopBar = (cartLabel: string): Block => ({
  caption: `Shop bar — NORTHWIND — ${cartLabel}`,
  x: 0,
  width: VIEWPORT.width,
  height: 48,
  children: [
    { aoi: aoi('cart-badge', 'Cart badge', 'dom', 'link'), x: 272, width: 102, height: 28, dy: 10 },
  ],
});

const promoBanner = (): Block => ({
  aoi: aoi('promo', 'Promo banner', 'sam', null),
  height: 76,
  gap: 12,
});

const heading = (text: string, gap = 16): Block => ({
  caption: `Heading — ${text}`,
  height: 28,
  gap,
});

const trustRow = (): Block => ({
  aoi: aoi('trust', 'Trust badges', 'sam', null),
  height: 56,
  gap: 16,
  children: [
    {
      aoi: aoi('support', '"Need help?" link', 'dom', 'link'),
      x: 240,
      width: 118,
      height: 28,
      dy: 14,
    },
  ],
});

const cartPage = (variant: VariantId): Block[] => [
  shopBar('Cart (1)'),
  ...(variant === 'B' ? [promoBanner()] : []),
  heading('Your cart'),
  { aoi: aoi('cart-line', 'Cart line item', 'dom', null), height: 72, gap: 12 },
  { aoi: aoi('cart-total', 'Cart total', 'dom', null), height: 120, gap: 12 },
  {
    aoi: aoi('cart-checkout', '"Checkout" button', 'dom', 'button', true),
    height: 48,
    gap: 16,
  },
  { aoi: aoi('keep-shopping', '"Keep shopping" link', 'dom', 'link'), height: 36, gap: 10 },
];

const paymentPage = (variant: VariantId): Block[] => [
  shopBar('Cart (1)'),
  ...(variant === 'B' ? [promoBanner()] : []),
  heading('Payment details'),
  { aoi: aoi('email', 'Email field', 'a11y', 'textbox'), height: 56, gap: 12 },
  { aoi: aoi('card', 'Card number field', 'dom', 'textbox'), height: 56, gap: 10 },
  { aoi: aoi('expiry', 'Expiry field', 'a11y', 'textbox'), height: 56, gap: 10, width: 171 },
  {
    aoi: aoi('cvc', 'CVC field', 'a11y', 'textbox'),
    height: 56,
    x: 203,
    width: 171,
    sameRow: true,
  },
  {
    aoi: aoi(
      'primary',
      variant === 'A' ? '"Continue to review" button' : '"Place order" button',
      'dom',
      'button',
      true,
    ),
    height: 48,
    gap: 16,
  },
  heading('Order summary', 20),
  {
    aoi: aoi('summary', 'Order summary', 'dom', null),
    height: 148,
    gap: 12,
    children:
      variant === 'B'
        ? [
            {
              aoi: aoi('shipping-row', 'Shipping row', 'dom', null),
              x: 32,
              width: 326,
              height: 28,
              dy: 44,
            },
          ]
        : [],
  },
  trustRow(),
];

const reviewPage = (variant: VariantId): Block[] => {
  const completeY = VIEWPORT.height + COMPLETE_BELOW_FOLD_BY;
  return [
    shopBar('Cart (1)'),
    ...(variant === 'B' ? [promoBanner()] : []),
    heading('Review your order'),
    { aoi: aoi('ship-to', 'Shipping address row', 'dom', null), height: 56, gap: 12 },
    { aoi: aoi('pay-with', 'Payment method row', 'dom', null), height: 56, gap: 10 },
    ...(variant === 'B'
      ? [
          {
            caption: 'Planted defect — content pushing the completing action below the fold',
            gap: 16,
            fillTo: completeY,
          },
        ]
      : []),
    {
      aoi: aoi(
        'complete',
        variant === 'A' ? '"Place order" button' : '"Confirm purchase" button',
        'dom',
        'button',
        true,
      ),
      height: 48,
      gap: 16,
      ...(variant === 'B' ? { startAt: completeY } : {}),
    },
    heading('Order summary', 20),
    {
      aoi: aoi('summary', 'Order summary', 'dom', null),
      height: variant === 'B' ? 176 : 148,
      gap: 12,
      children:
        variant === 'B'
          ? [
              {
                aoi: aoi('fee-row', 'Service fee row', 'dom', null),
                x: 32,
                width: 326,
                height: 28,
                dy: 72,
              },
            ]
          : [],
    },
    trustRow(),
  ];
};

const confirmPage = (): Block[] => [
  shopBar('Cart (0)'),
  {
    aoi: aoi('confirm', 'Confirmation message', 'dom', null),
    height: 120,
    gap: 16,
    children: [
      {
        aoi: aoi('order-number', 'Order number', 'dom', null),
        x: 32,
        width: 326,
        height: 32,
        dy: 72,
      },
    ],
  },
  { aoi: aoi('summary', 'Amount paid', 'dom', null), height: 96, gap: 16 },
];

const PAGE_BLOCKS: Record<StepId, (variant: VariantId) => Block[]> = {
  cart: cartPage,
  payment: paymentPage,
  review: reviewPage,
  confirm: confirmPage,
};

const layOut = (blocks: Block[]): PageLayout => {
  const boxes: PlacedBox[] = [];
  let cursor = 0;
  let previousY = 0;
  for (const block of blocks) {
    const y = block.startAt ?? (block.sameRow ? previousY : cursor + (block.gap ?? 0));
    const height = block.fillTo === undefined ? (block.height ?? 0) : Math.max(0, block.fillTo - y);
    const box: Box = {
      x: block.x ?? CONTENT_X,
      y,
      width: block.width ?? CONTENT_WIDTH,
      height,
    };
    boxes.push({ aoi: block.aoi, caption: block.caption, box });
    for (const child of block.children ?? []) {
      boxes.push({
        aoi: child.aoi,
        box: { x: child.x, y: y + child.dy, width: child.width, height: child.height },
      });
    }
    previousY = y;
    cursor = Math.max(cursor, y + height);
  }
  const filler = Math.max(FILLER_MIN_HEIGHT, PAGE_MIN_HEIGHT - cursor);
  boxes.push({
    caption: 'Footer — placeholder filler',
    box: { x: 0, y: cursor, width: VIEWPORT.width, height: filler },
  });
  return { boxes, pageHeight: cursor + filler, foldY: VIEWPORT.height };
};

/* ===== the areas of interest, from the prototype's AOI_METRICS ============= */

/** `null` where the area does not exist in that variant; `ttff: null` where none ever did. */
/** Only `label` and `src` are read: the readings are the shape the anchors aim at. */
interface MetricReading {
  ttff: number | null;
  ffd: number | null;
  dwell: number;
  fix: number;
  rev: number;
  seen: number;
}

interface MetricRow {
  id: string;
  label: string;
  src: string;
  A: MetricReading | null;
  B: MetricReading | null;
}

// prettier-ignore
const AOI_METRICS: Record<StepId, MetricRow[]> = {
  cart: [
    { id: 'promo', label: 'Promo banner', src: 'SAM 3.1 segment', A: null, B: { ttff: 0.3, ffd: 480, dwell: 2.4, fix: 3.1, rev: 1.4, seen: 91 } },
    { id: 'cart-line', label: 'Cart line item', src: 'DOM', A: { ttff: 0.5, ffd: 310, dwell: 1.4, fix: 2.2, rev: 0.4, seen: 100 }, B: { ttff: 1.1, ffd: 280, dwell: 1.1, fix: 1.8, rev: 0.3, seen: 100 } },
    { id: 'cart-total', label: 'Cart total', src: 'DOM', A: { ttff: 1.2, ffd: 420, dwell: 2.1, fix: 2.8, rev: 0.6, seen: 100 }, B: { ttff: 1.9, ffd: 300, dwell: 1.9, fix: 2.6, rev: 0.9, seen: 91 } },
    { id: 'cart-checkout', label: '"Checkout" button', src: 'DOM · primary action', A: { ttff: 2.0, ffd: 520, dwell: 1.0, fix: 1.3, rev: 0.1, seen: 100 }, B: { ttff: 3.4, ffd: 450, dwell: 0.9, fix: 1.2, rev: 0.2, seen: 100 } },
    { id: 'keep-shopping', label: '"Keep shopping" link', src: 'DOM', A: { ttff: 3.1, ffd: 180, dwell: 0.2, fix: 0.4, rev: 0.0, seen: 27 }, B: { ttff: 4.0, ffd: 190, dwell: 0.3, fix: 0.5, rev: 0.1, seen: 36 } },
  ],
  payment: [
    { id: 'promo', label: 'Promo banner', src: 'SAM 3.1 segment', A: null, B: { ttff: 0.4, ffd: 520, dwell: 3.1, fix: 4.2, rev: 1.8, seen: 92 } },
    { id: 'summary', label: 'Order summary', src: 'DOM', A: { ttff: 2.4, ffd: 300, dwell: 2.3, fix: 3.1, rev: 0.8, seen: 100 }, B: { ttff: 3.0, ffd: 280, dwell: 3.4, fix: 4.4, rev: 2.1, seen: 100 } },
    { id: 'shipping-row', label: 'Shipping row — B: "calculated at next step"', src: 'DOM', A: null, B: { ttff: 4.1, ffd: 380, dwell: 1.9, fix: 2.4, rev: 1.3, seen: 83 } },
    { id: 'card', label: 'Card number field', src: 'DOM', A: { ttff: 1.1, ffd: 480, dwell: 2.0, fix: 2.2, rev: 0.3, seen: 100 }, B: { ttff: 2.2, ffd: 460, dwell: 1.9, fix: 2.1, rev: 0.4, seen: 100 } },
    { id: 'primary', label: 'Primary action — A: "Continue to review", B: "Place order"', src: 'DOM · primary action', A: { ttff: 1.8, ffd: 560, dwell: 1.4, fix: 1.9, rev: 0.2, seen: 100 }, B: { ttff: 3.6, ffd: 420, dwell: 1.2, fix: 1.6, rev: 0.3, seen: 92 } },
    { id: 'trust', label: 'Trust badges', src: 'SAM 3.1 segment', A: { ttff: 4.6, ffd: 200, dwell: 0.3, fix: 0.6, rev: 0.0, seen: 36 }, B: { ttff: 5.2, ffd: 210, dwell: 0.4, fix: 0.7, rev: 0.1, seen: 41 } },
    { id: 'support', label: '"Need help?" link', src: 'DOM', A: { ttff: 5.8, ffd: 190, dwell: 0.2, fix: 0.3, rev: 0.0, seen: 18 }, B: { ttff: 5.0, ffd: 280, dwell: 0.9, fix: 1.2, rev: 0.4, seen: 58 } },
  ],
  review: [
    { id: 'fee-row', label: 'Service fee row — planted defect', src: 'DOM', A: null, B: { ttff: 1.2, ffd: 610, dwell: 3.6, fix: 3.9, rev: 2.4, seen: 100 } },
    { id: 'summary', label: 'Order summary', src: 'DOM', A: { ttff: 1.6, ffd: 340, dwell: 2.2, fix: 2.9, rev: 0.7, seen: 100 }, B: { ttff: 0.6, ffd: 520, dwell: 4.8, fix: 5.6, rev: 3.1, seen: 100 } },
    { id: 'complete', label: 'Completing action — A: "Place order", B: "Confirm purchase"', src: 'DOM · primary action', A: { ttff: 2.3, ffd: 610, dwell: 1.6, fix: 2.0, rev: 0.2, seen: 100 }, B: { ttff: null, ffd: null, dwell: 0, fix: 0, rev: 0, seen: 0 } },
    { id: 'pay-with', label: 'Payment method row', src: 'DOM', A: { ttff: 1.1, ffd: 320, dwell: 1.1, fix: 1.6, rev: 0.3, seen: 91 }, B: { ttff: 2.8, ffd: 260, dwell: 0.8, fix: 1.2, rev: 0.4, seen: 67 } },
    { id: 'support', label: '"Need help?" link', src: 'DOM', A: { ttff: 4.9, ffd: 180, dwell: 0.2, fix: 0.3, rev: 0.0, seen: 9 }, B: { ttff: 3.4, ffd: 330, dwell: 1.0, fix: 1.3, rev: 0.5, seen: 67 } },
  ],
  confirm: [
    { id: 'confirm', label: 'Confirmation message', src: 'DOM', A: { ttff: 0.4, ffd: 460, dwell: 1.8, fix: 2.1, rev: 0.2, seen: 100 }, B: { ttff: 0.5, ffd: 430, dwell: 1.5, fix: 1.9, rev: 0.2, seen: 100 } },
    { id: 'order-number', label: 'Order number', src: 'DOM', A: { ttff: 1.0, ffd: 380, dwell: 1.2, fix: 1.4, rev: 0.3, seen: 89 }, B: { ttff: 1.4, ffd: 300, dwell: 0.9, fix: 1.1, rev: 0.4, seen: 100 } },
    { id: 'summary', label: 'Amount paid', src: 'DOM', A: { ttff: 1.9, ffd: 240, dwell: 0.6, fix: 0.9, rev: 0.1, seen: 67 }, B: { ttff: 1.1, ffd: 520, dwell: 2.2, fix: 2.5, rev: 1.5, seen: 100 } },
  ],
};

// prettier-ignore
const STEP_CAPTION: Array<{ variant: VariantId; step: StepId; caption: string }> = [
  { variant: 'A', step: 'cart', caption: 'Variant A, cart. The up-front $8.95 shipping line is read as part of the total; two price-sensitive agents left here over it.' },
  { variant: 'B', step: 'cart', caption: 'Variant B, cart. The promo banner takes the first fixation, and "calculated later" draws a second fixation in 8 of 11 sessions before Checkout is clicked.' },
  { variant: 'A', step: 'payment', caption: 'Variant A, payment step. Attention settles on the card field, then the total, then the primary action: 9 of 9 agents who reached this step fixated "Continue to review", median 1.8 s in.' },
  { variant: 'B', step: 'payment', caption: 'Variant B, payment step. The promo banner takes the first fixation in 9 of 10 sessions and holds 3.1 s of dwell. The primary action here says "Place order", but it only advances to the review step.' },
  { variant: 'A', step: 'review', caption: 'Variant A, review step. The total is read once, then the primary action; 9 of 9 agents placed the order.' },
  { variant: 'B', step: 'review', caption: 'Variant B, review step. The newly revealed $9.95 service fee holds 3.6 s of dwell with 2.4 revisits, and "Confirm purchase" sits below the fold: 0 of 9 agents who reached this step ever fixated it.' },
  { variant: 'A', step: 'confirm', caption: 'Variant A, confirmation. 9 of 11 agents reached it.' },
  { variant: 'B', step: 'confirm', caption: 'Variant B, confirmation. Only 2 of 11 agents reached it, and both re-read the amount paid: 2.2 s of dwell with 1.5 revisits on a total they had not agreed to.' },
];

/* ===== the canonical scanpaths, from the prototype's FIX =================== */

/** A fixation anchored inside an area of interest: a fraction in, and a duration. */
interface Anchor {
  aoi: string;
  ox: number;
  oy: number;
  dur: number;
}

const CANONICAL: Record<string, Anchor[]> = {
  'A-cart': [
    { aoi: 'cart-line', ox: 0.3, oy: 0.5, dur: 310 },
    { aoi: 'cart-line', ox: 0.85, oy: 0.5, dur: 240 },
    { aoi: 'cart-total', ox: 0.8, oy: 0.75, dur: 420 },
    { aoi: 'cart-total', ox: 0.8, oy: 0.9, dur: 360 },
    { aoi: 'cart-checkout', ox: 0.5, oy: 0.5, dur: 520 },
  ],
  'B-cart': [
    { aoi: 'promo', ox: 0.5, oy: 0.45, dur: 480 },
    { aoi: 'promo', ox: 0.5, oy: 0.8, dur: 260 },
    { aoi: 'cart-line', ox: 0.3, oy: 0.5, dur: 280 },
    { aoi: 'cart-total', ox: 0.8, oy: 0.55, dur: 300 },
    { aoi: 'cart-total', ox: 0.8, oy: 0.85, dur: 340 },
    { aoi: 'promo', ox: 0.5, oy: 0.5, dur: 210 },
    { aoi: 'cart-checkout', ox: 0.5, oy: 0.5, dur: 450 },
  ],
  'A-payment': [
    { aoi: 'email', ox: 0.3, oy: 0.5, dur: 260 },
    { aoi: 'card', ox: 0.4, oy: 0.5, dur: 480 },
    { aoi: 'expiry', ox: 0.5, oy: 0.5, dur: 220 },
    { aoi: 'cvc', ox: 0.5, oy: 0.5, dur: 200 },
    { aoi: 'summary', ox: 0.7, oy: 0.35, dur: 300 },
    { aoi: 'summary', ox: 0.75, oy: 0.8, dur: 410 },
    { aoi: 'primary', ox: 0.5, oy: 0.5, dur: 560 },
    { aoi: 'primary', ox: 0.35, oy: 0.5, dur: 240 },
  ],
  'B-payment': [
    { aoi: 'promo', ox: 0.5, oy: 0.4, dur: 520 },
    { aoi: 'promo', ox: 0.55, oy: 0.8, dur: 300 },
    { aoi: 'email', ox: 0.3, oy: 0.5, dur: 240 },
    { aoi: 'card', ox: 0.4, oy: 0.5, dur: 460 },
    { aoi: 'expiry', ox: 0.5, oy: 0.5, dur: 210 },
    { aoi: 'cvc', ox: 0.5, oy: 0.5, dur: 190 },
    { aoi: 'summary', ox: 0.55, oy: 0.25, dur: 280 },
    { aoi: 'shipping-row', ox: 0.3, oy: 0.5, dur: 380 },
    { aoi: 'summary', ox: 0.8, oy: 0.88, dur: 440 },
    { aoi: 'shipping-row', ox: 0.8, oy: 0.5, dur: 350 },
    { aoi: 'promo', ox: 0.5, oy: 0.5, dur: 230 },
    { aoi: 'primary', ox: 0.5, oy: 0.5, dur: 420 },
  ],
  'A-review': [
    { aoi: 'ship-to', ox: 0.4, oy: 0.5, dur: 280 },
    { aoi: 'pay-with', ox: 0.4, oy: 0.5, dur: 320 },
    { aoi: 'summary', ox: 0.75, oy: 0.5, dur: 340 },
    { aoi: 'summary', ox: 0.75, oy: 0.9, dur: 430 },
    { aoi: 'complete', ox: 0.5, oy: 0.5, dur: 610 },
  ],
  // Variant B, review step: no anchor names `complete`. No fixation ever lands on the
  // button that completes the order — the headline finding, not missing data.
  'B-review': [
    { aoi: 'summary', ox: 0.55, oy: 0.35, dur: 520 },
    { aoi: 'fee-row', ox: 0.35, oy: 0.5, dur: 610 },
    { aoi: 'summary', ox: 0.82, oy: 0.92, dur: 480 },
    { aoi: 'fee-row', ox: 0.75, oy: 0.5, dur: 540 },
    { aoi: 'pay-with', ox: 0.35, oy: 0.5, dur: 260 },
    { aoi: 'summary', ox: 0.6, oy: 0.95, dur: 500 },
    { aoi: 'support', ox: 0.5, oy: 0.5, dur: 330 },
  ],
  'A-confirm': [
    { aoi: 'confirm', ox: 0.5, oy: 0.4, dur: 460 },
    { aoi: 'order-number', ox: 0.5, oy: 0.5, dur: 380 },
    { aoi: 'summary', ox: 0.75, oy: 0.5, dur: 240 },
  ],
  'B-confirm': [
    { aoi: 'confirm', ox: 0.5, oy: 0.4, dur: 430 },
    { aoi: 'summary', ox: 0.6, oy: 0.5, dur: 520 },
    { aoi: 'order-number', ox: 0.5, oy: 0.5, dur: 300 },
  ],
};

/* ===== scores and verdict, from FLOW section 5 and the prototype =========== */

/** The weights FLOW section 5 states. They live in `@personavision/scoring` once it exists. */
const WEIGHTS = {
  taskFailureRate: 0.3,
  abandonment: 0.2,
  timeToFirstFixationPrimary: 0.35,
  deadEndRevisits: 0.15,
};

const TTFF_CAP_SECONDS = 6;
const REVISIT_CAP = 5;

/** The prototype's score cards: the headline, its spread, and the per-seed-group scores. */
const SCORE_READING: Record<
  VariantId,
  {
    median: number;
    sd: number;
    perSeedGroup: Array<{ seed: number; frictionScore: number }>;
    worstStep: StepId;
    /** Median seconds to the primary action on the worst step, `null` when never fixated. */
    medianSeconds: number | null;
    /** Median returns per session to an area that does not advance the task. */
    deadEndRevisits: number;
  }
> = {
  A: {
    median: 22,
    sd: 3,
    perSeedGroup: [
      { seed: 1, frictionScore: 19 },
      { seed: 2, frictionScore: 22 },
      { seed: 3, frictionScore: 25 },
    ],
    worstStep: 'review',
    medianSeconds: 2.3,
    deadEndRevisits: 1.5,
  },
  B: {
    median: 67,
    sd: 4,
    perSeedGroup: [
      { seed: 1, frictionScore: 67 },
      { seed: 2, frictionScore: 71 },
      { seed: 3, frictionScore: 63 },
    ],
    worstStep: 'review',
    medianSeconds: null,
    deadEndRevisits: 4.3,
  },
};

const VERDICT_SENTENCE =
  'Variant B is harder. The gap held in all 3 seed groups (A 19–25, B 63–71 — the bands do not overlap).';

/* ===== assembling the artifact ============================================= */

const round1 = (value: number): number => Math.round(value * 10) / 10;
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

const aoiKey = (variant: VariantId, step: StepId, raw: string): string =>
  `${variant}-${step}-${raw}`;

const pages = new Map<string, PageLayout>();
for (const variant of VARIANTS) {
  for (const step of STEPS) {
    pages.set(`${variant.id}-${step.id}`, layOut(PAGE_BLOCKS[step.id](variant.id)));
  }
}

const pageOf = (variant: VariantId, step: StepId): PageLayout => {
  const page = pages.get(`${variant}-${step}`);
  if (page === undefined) throw new Error(`no page for ${variant}-${step}`);
  return page;
};

const boxOf = (variant: VariantId, step: StepId, raw: string): Box => {
  const placed = pageOf(variant, step).boxes.find((candidate) => candidate.aoi?.id === raw);
  if (placed === undefined) throw new Error(`no area of interest ${raw} on ${variant}-${step}`);
  return placed.box;
};

const metricRow = (step: StepId, raw: string): MetricRow | undefined =>
  AOI_METRICS[step].find((row) => row.id === raw);

/** The prototype's `src` column decides the source and whether the area is the primary action. */
const sourceOf = (src: string): { source: AoiSource; isPrimaryAction: boolean } => ({
  source: src.startsWith('SAM') ? 'sam' : 'dom',
  isPrimaryAction: src.includes('primary action'),
});

const buildAois = (): Run['aois'] => {
  const aois: Run['aois'] = [];
  for (const variant of VARIANTS) {
    for (const step of STEPS) {
      for (const placed of pageOf(variant.id, step.id).boxes) {
        const spec = placed.aoi;
        if (spec === undefined) continue;
        // Where the prototype's table carries the area, its label and source are binding;
        // an area it does not table — a form field, the cart badge — keeps the layout's.
        const row = metricRow(step.id, spec.id);
        const fromSrc = row === undefined ? undefined : sourceOf(row.src);
        aois.push({
          id: aoiKey(variant.id, step.id, spec.id),
          variant: variant.id,
          step: step.id,
          label: row?.label ?? spec.label,
          source: fromSrc?.source ?? spec.source,
          role: spec.role,
          bbox: placed.box,
          isPrimaryAction: fromSrc?.isPrimaryAction ?? spec.isPrimaryAction === true,
          belowFold: placed.box.y >= pageOf(variant.id, step.id).foldY,
        });
      }
    }
  }
  return aois;
};

const buildScore = (variant: VariantId, rows: SessionRow[]): Run['scores'][number] => {
  const scored = rows.filter((row) => row.status !== 'automation_failure');
  const counted = (status: SessionRow['status']): number =>
    rows.filter((row) => row.status === status).length;
  const reading = SCORE_READING[variant];
  const components = {
    taskFailureRate: round6(counted('failed') / scored.length),
    abandonment: round6(counted('abandoned') / scored.length),
    timeToFirstFixationPrimary: {
      worstStep: reading.worstStep,
      medianSeconds: reading.medianSeconds,
      // Never fixated counts as a full 1.0: a control nobody ever sees is the worst case.
      value:
        reading.medianSeconds === null
          ? 1
          : round6(Math.min(1, reading.medianSeconds / TTFF_CAP_SECONDS)),
    },
    deadEndRevisits: round6(Math.min(1, reading.deadEndRevisits / REVISIT_CAP)),
  };
  // A later scoring implementation has to recompute the headline from these four numbers
  // and land on the same answer, so the fixture refuses to carry a score that does not.
  const weighted =
    components.taskFailureRate * WEIGHTS.taskFailureRate +
    components.abandonment * WEIGHTS.abandonment +
    components.timeToFirstFixationPrimary.value * WEIGHTS.timeToFirstFixationPrimary +
    components.deadEndRevisits * WEIGHTS.deadEndRevisits;
  if (Math.round(weighted * 100) !== reading.median) {
    throw new Error(
      `variant ${variant}: the components weigh up to ${(weighted * 100).toFixed(2)}, not the ${reading.median} the prototype prints`,
    );
  }
  return {
    variant,
    taskId: TASK.id,
    frictionScore: { median: reading.median, sd: reading.sd },
    components,
    outcomeCounts: {
      success: counted('success'),
      abandoned: counted('abandoned'),
      failed: counted('failed'),
      automationFailure: counted('automation_failure'),
    },
    scoredSessionCount: scored.length,
    perSeedGroup: reading.perSeedGroup,
  };
};

const PRIMARY_LABEL: Record<VariantId, Partial<Record<StepId, string>>> = {
  A: {
    cart: 'Checkout',
    payment: 'Continue to review',
    review: 'Place order · $137.95',
  },
  B: {
    cart: 'Checkout',
    payment: 'Place order · $129.00',
    review: 'Confirm purchase · $147.95',
  },
};

const PRIMARY_AOI: Record<StepId, string | null> = {
  cart: 'cart-checkout',
  payment: 'primary',
  review: 'complete',
  confirm: null,
};

/** Fixations split over the steps a session reached, in proportion to each step's scanpath. */
const allocate = (total: number, weights: number[]): number[] => {
  const sum = weights.reduce((running, weight) => running + weight, 0);
  const wanted = weights.map((weight) => (total * weight) / sum);
  const given = wanted.map((value) => Math.max(1, Math.floor(value)));
  const order = wanted
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  let left = total - given.reduce((running, value) => running + value, 0);
  for (let turn = 0; left > 0; turn += 1, left -= 1) {
    given[order[turn % order.length].index] += 1;
  }
  while (left < 0) {
    const fullest = given.indexOf(Math.max(...given));
    // A step a session reached shows at least one fixation, so a total too small to go
    // round is refused rather than quietly dropping a step out of the filmstrip.
    if (given[fullest] <= 1) {
      throw new Error(`allocate: ${total} does not go round ${weights.length} steps`);
    }
    given[fullest] -= 1;
    left += 1;
  }
  return given;
};

interface RawFixation {
  step: StepId;
  aoiId: string;
  pageX: number;
  pageY: number;
  durationMs: number;
}

const buildSession = (row: SessionRow, index: number): Session => {
  const sessionId = sessionIdOf(index);
  const persona = personaById(row.persona);
  const durationMs = Math.round(row.seconds * 1000);
  const random = createSeededRandom(1402 + index * 97 + row.seed);
  const jitter = (spread: number): number => (random() - 0.5) * 2 * spread;
  const steps = STEP_PATH.slice(0, STEP_PATH.indexOf(row.endedAt) + 1);

  const plan =
    sessionId === REPLAY_SESSION_ID
      ? REPLAY_STEPS
      : (() => {
          const counts = allocate(
            row.fixations,
            steps.map((step) => CANONICAL[`${row.variant}-${step}`].length),
          );
          const windows = allocate(durationMs, counts);
          let from = 0;
          return steps.map((step, position) => {
            const toMs = position === steps.length - 1 ? durationMs : from + windows[position];
            const window = { step, fixations: counts[position], fromMs: from, toMs };
            from = toMs;
            return window;
          });
        })();

  // One draw per peripheral area, taken outside the fixation loop so that the canonical
  // scanpath's jitter does not depend on which glances this session happens to make.
  const glance = createSeededRandom(1402 + index * 31 + 7);

  const raw: RawFixation[] = [];
  for (const window of plan) {
    const skipped = NEVER_FIXATED[sessionId]?.[window.step] ?? [];
    const key = `${row.variant}-${window.step}`;
    const anchors = CANONICAL[key].filter((anchor) => !skipped.includes(anchor.aoi));
    for (const peripheral of PERIPHERAL[key] ?? []) {
      const drawn = glance() < peripheral.share;
      if (drawn && !skipped.includes(peripheral.aoi)) anchors.push(peripheral);
    }
    if (anchors.length === 0) {
      throw new Error(`${sessionId}: every anchor on ${key} was skipped, so it has no gaze`);
    }
    for (let position = 0; position < window.fixations; position += 1) {
      const last =
        window.step === row.endedAt &&
        position === window.fixations - 1 &&
        row.variant === 'B' &&
        row.endedAt === 'review' &&
        row.status === 'abandoned';
      const anchor = last
        ? { aoi: LEAVES_LOOKING_FOR_HELP, ox: 0.5, oy: 0.5, dur: 330 }
        : anchors[position % anchors.length];
      const box = boxOf(row.variant, window.step, anchor.aoi);
      raw.push({
        step: window.step,
        aoiId: aoiKey(row.variant, window.step, anchor.aoi),
        pageX: round1(
          clamp(box.x + anchor.ox * box.width + jitter(8), box.x + 2, box.x + box.width - 2),
        ),
        pageY: round1(
          clamp(box.y + anchor.oy * box.height + jitter(6), box.y + 2, box.y + box.height - 2),
        ),
        durationMs: Math.round(anchor.dur * (0.88 + random() * 0.24)),
      });
    }
  }

  // One screen per scroll position: a step whose gaze spans more of the page than the
  // viewport shows was scrolled, and the replay needs the offset the image was taken at.
  const screens: Session['screens'] = [];
  /** The same steps as `screens`, still typed, for the decision each screen ends on. */
  const screenSteps: StepId[] = [];
  const screenOfFixation = raw.map(() => -1);
  let firstOfStep = 0;
  for (const window of plan) {
    const page = pageOf(row.variant, window.step);
    const onB = row.variant === 'B';
    const stated = INTENT_ON_B[row.persona]?.[window.step];
    const positions = raw
      .map((_, position) => position)
      .slice(firstOfStep, firstOfStep + window.fixations);
    firstOfStep += window.fixations;
    let chunk: number[] = [];
    const flush = (): void => {
      if (chunk.length === 0) return;
      // The agent scrolls only once its gaze has somewhere to go: a chunk that fits in the
      // opening viewport is read at the top of the page.
      const lowest = Math.min(...chunk.map((position) => raw[position].pageY));
      const highest = Math.max(...chunk.map((position) => raw[position].pageY));
      const scrollY =
        highest <= VIEWPORT.height - SCROLL_MARGIN
          ? 0
          : clamp(Math.round(lowest - SCROLL_MARGIN), 0, page.pageHeight - VIEWPORT.height);
      screens.push({
        index: screens.length,
        step: window.step,
        screenshot: runPaths('').screenshot(row.variant, window.step),
        scrollY,
        intent: onB && stated !== undefined ? stated : INTENT[row.persona][window.step],
        decidedAction: '',
      });
      screenSteps.push(window.step);
      for (const position of chunk) screenOfFixation[position] = screens.length - 1;
      chunk = [];
    };
    for (const position of positions) {
      const spread = [...chunk, position].map((member) => raw[member].pageY);
      if (chunk.length > 0 && Math.max(...spread) - Math.min(...spread) > SCROLL_SPAN) flush();
      chunk.push(position);
    }
    flush();
  }

  // What the agent did at the end of each step, written on the screen it did it from.
  const decision = (step: StepId): string => {
    if (step !== row.endedAt) return `clicked "${PRIMARY_LABEL[row.variant][step] ?? ''}"`;
    if (row.status === 'automation_failure') {
      return 'automation failure: the card number field never resolved';
    }
    if (row.status === 'abandoned') return 'left without ordering';
    if (row.status === 'failed') return 'stopped, believing the order was placed';
    return 'read the confirmation';
  };
  for (const [position, screen] of screens.entries()) {
    const isLastOfStep = screens[position + 1]?.step !== screen.step;
    screen.decidedAction = isLastOfStep
      ? decision(screenSteps[position])
      : 'scrolled to see more of the page';
  }

  const fixations: Session['fixations'] = [];
  let cursor = 0;
  for (const [position, entry] of raw.entries()) {
    const window = plan.find((candidate) => candidate.step === entry.step);
    if (window === undefined) throw new Error(`no window for ${entry.step}`);
    const inStep = raw.filter((candidate) => candidate.step === entry.step);
    const slot = (window.toMs - window.fromMs) / (inStep.length + 1);
    const wanted = window.fromMs + slot * (inStep.indexOf(entry) + 1) + jitter(slot * 0.2);
    const tMs = clamp(
      Math.max(cursor, Math.round(wanted)),
      0,
      Math.max(0, durationMs - entry.durationMs),
    );
    const screenIndex = screenOfFixation[position];
    const screen = screens[screenIndex];
    fixations.push({
      index: position,
      screenIndex,
      tMs,
      durationMs: entry.durationMs,
      x: round1(clamp(entry.pageX, 0, VIEWPORT.width)),
      y: round1(clamp(entry.pageY - screen.scrollY, 0, VIEWPORT.height)),
      pageX: entry.pageX,
      pageY: entry.pageY,
      aoiId: entry.aoiId,
    });
    cursor = tMs + entry.durationMs + 40;
  }

  const saccades: Session['saccades'] = fixations.slice(1).map((fixation, position) => {
    const previous = fixations[position];
    const amplitudePx = round1(
      Math.hypot(fixation.pageX - previous.pageX, fixation.pageY - previous.pageY),
    );
    return {
      fromFixation: previous.index,
      toFixation: fixation.index,
      amplitudePx,
      durationMs: Math.round(18 + amplitudePx * 0.04),
    };
  });

  /**
   * Every change of offset is a scroll, the scroll back to the top included: a replay
   * driven by this log has to land on the crop its screenshot was taken at. Derived from
   * the screens rather than written by hand, so the hand-written replay log below cannot
   * disagree with the offsets its own screens record.
   */
  const scrollActions = (): Session['actions'] => {
    const built: Session['actions'] = [];
    let offset = 0;
    for (const screen of screens) {
      if (screen.scrollY === offset) continue;
      offset = screen.scrollY;
      const first = fixations.find((fixation) => fixation.screenIndex === screen.index);
      built.push({
        tMs: Math.max(0, (first?.tMs ?? 0) - 120),
        type: 'scroll',
        target: 'window',
        aoiId: null,
        value: String(screen.scrollY),
        ok: true,
      });
    }
    return built;
  };

  const actions: Session['actions'] =
    sessionId === REPLAY_SESSION_ID
      ? [
          ...scrollActions(),
          {
            tMs: 8000,
            type: 'click',
            target: 'Checkout',
            aoiId: aoiKey('B', 'cart', 'cart-checkout'),
            value: null,
            ok: true,
          },
          {
            tMs: 14000,
            type: 'type',
            target: 'Card number',
            aoiId: aoiKey('B', 'payment', 'card'),
            value: 'autofilled',
            ok: true,
          },
          { tMs: 23000, type: 'hesitate', target: null, aoiId: null, value: '1900', ok: true },
          {
            tMs: 26000,
            type: 'click',
            target: 'Place order · $129.00',
            aoiId: aoiKey('B', 'payment', 'primary'),
            value: null,
            ok: true,
          },
          {
            tMs: 38000,
            type: 'abandon',
            target: null,
            aoiId: null,
            value: 'Left without placing the order',
            ok: true,
          },
        ]
      : (() => {
          const built: Session['actions'] = scrollActions();
          for (const window of plan) {
            const failedHere = row.status === 'automation_failure' && window.step === row.endedAt;
            if (window.step === 'payment') {
              built.push({
                tMs: Math.round((window.fromMs + window.toMs) / 2),
                type: 'type',
                target: 'Card number',
                aoiId: aoiKey(row.variant, 'payment', 'card'),
                value: failedHere ? null : 'autofilled',
                ok: !failedHere,
              });
            }
            if (window.step === row.endedAt) continue;
            const primary = PRIMARY_AOI[window.step];
            built.push({
              tMs: Math.max(0, window.toMs - 200),
              type: 'click',
              target: PRIMARY_LABEL[row.variant][window.step] ?? null,
              aoiId: primary === null ? null : aoiKey(row.variant, window.step, primary),
              value: null,
              ok: true,
            });
          }
          if (row.status === 'abandoned') {
            built.push({
              tMs: durationMs,
              type: 'abandon',
              target: null,
              aoiId: null,
              value: row.reason,
              ok: true,
            });
          }
          return built;
        })();
  actions.sort((left, right) => left.tMs - right.tMs);

  return {
    schemaVersion: 1,
    sessionId,
    runId: RUN_ID,
    variant: row.variant,
    taskId: TASK.id,
    kind: 'simulated',
    persona: { id: persona.id, traits: persona.traits, device: persona.device },
    participant: null,
    seed: row.seed,
    startedAt: new Date(CREATED_AT.getTime() + index * 45_000).toISOString(),
    durationMs,
    screens,
    fixations,
    saccades,
    actions,
    outcome: {
      status: row.status,
      step: row.endedAt,
      reason: row.reason,
      attribution: row.status === 'automation_failure' ? 'automation' : 'product',
      // Derived here, once, and stored: no screen re-derives which sessions count.
      excludedFromScores: row.status === 'automation_failure',
    },
    integrity:
      row.status === 'automation_failure'
        ? { selectorFailures: 1, retries: 1 }
        : { selectorFailures: 0, retries: 0 },
  };
};

const buildFindings = (sessions: ReadonlyArray<Session>): Findings => {
  const idsWhere = (predicate: (session: Session) => boolean): string[] =>
    sessions.filter(predicate).map((session) => session.sessionId);
  const scored = (session: Session): boolean => !session.outcome.excludedFromScores;
  const reached = (session: Session, step: StepId): boolean =>
    session.screens.some((screen) => screen.step === step);

  const reachedBReview = idsWhere(
    (session) => session.variant === 'B' && scored(session) && reached(session, 'review'),
  );
  const leftOverTheFee = idsWhere(
    (session) =>
      session.variant === 'B' &&
      session.outcome.status === 'abandoned' &&
      session.outcome.step === 'review',
  );
  const sawThePromo = idsWhere(
    (session) =>
      session.variant === 'B' &&
      scored(session) &&
      reached(session, 'payment') &&
      session.fixations.some((fixation) => fixation.aoiId === aoiKey('B', 'payment', 'promo')),
  );
  const believedBought = idsWhere(
    (session) => session.variant === 'B' && session.outcome.status === 'failed',
  );
  const leftOverShipping = idsWhere(
    (session) => session.variant === 'A' && session.outcome.status === 'abandoned',
  );
  const automationFailures = idsWhere((session) => session.outcome.excludedFromScores);

  const findings: Findings['findings'] = [
    {
      id: 'F-1',
      rank: 1,
      severity: 'critical',
      claim: 'Nobody ever looked at the button that completes the order on variant B.',
      evidence:
        '“Confirm purchase” sits about 180 px below the fold on the review step. Of the 9 agents who reached that step, 0 fixated it; on variant A the equivalent button was fixated by 9 of 9, median 2.3 s in.',
      variant: 'B',
      step: 'review',
      aoiId: aoiKey('B', 'review', 'complete'),
      sessionIds: reachedBReview,
      sessionCount: reachedBReview.length,
      attribution: 'product',
      evidence_link: {
        screen: 'attention',
        params: { variant: 'B', step: 'review', aoi: aoiKey('B', 'review', 'complete') },
      },
    },
    {
      id: 'F-2',
      rank: 2,
      severity: 'critical',
      claim:
        'A $9.95 service fee appears only after payment details are entered, and 4 of 9 agents left within 5 s of fixating it.',
      evidence:
        'The fee row holds 610 ms on first fixation and 2.4 revisits — the highest revisit count in the run. The total changes from $129.00 to $147.95 between the payment and review steps.',
      variant: 'B',
      step: 'review',
      aoiId: aoiKey('B', 'review', 'fee-row'),
      sessionIds: leftOverTheFee,
      sessionCount: leftOverTheFee.length,
      attribution: 'product',
      evidence_link: {
        screen: 'attention',
        params: { variant: 'B', step: 'review', aoi: aoiKey('B', 'review', 'fee-row') },
      },
    },
    {
      id: 'F-3',
      rank: 3,
      severity: 'high',
      claim:
        'The promo banner takes the first fixation in 9 of 10 sessions, a median 1.3 s before any form field.',
      evidence:
        'Dwell 3.1 s with 1.8 revisits, against 1.2 s on the primary action beneath it. No agent applied the code: the banner costs attention without being used.',
      variant: 'B',
      step: 'payment',
      aoiId: aoiKey('B', 'payment', 'promo'),
      sessionIds: sawThePromo,
      sessionCount: sawThePromo.length,
      attribution: 'product',
      evidence_link: {
        screen: 'attention',
        params: { variant: 'B', step: 'payment', aoi: aoiKey('B', 'payment', 'promo') },
      },
    },
    {
      id: 'F-4',
      rank: 4,
      severity: 'medium',
      claim:
        'The payment step’s button says “Place order” but only advances to review, and 3 of 11 agents stopped there believing they had bought the boots.',
      evidence:
        'All three show a confirmation-seeking fixation pattern on the next screen (summary, then support link) and no further action. Their outcome is a failure with no order placed, not an abandonment.',
      variant: 'B',
      step: 'payment',
      aoiId: aoiKey('B', 'payment', 'primary'),
      sessionIds: believedBought,
      sessionCount: believedBought.length,
      attribution: 'product',
      evidence_link: { screen: 'sessions', params: { variant: 'B', outcome: 'failed' } },
    },
    {
      id: 'F-5',
      rank: 5,
      severity: 'low',
      claim:
        'On variant A, 2 of 11 agents abandoned at the cart after re-reading the shipping line.',
      evidence:
        'Both were the price-sensitive scanner persona; $8.95 shipping on a $129.00 order drew 2 revisits before they left. Reported for symmetry: variant A is the cleaner variant, not a perfect one.',
      variant: 'A',
      step: 'cart',
      aoiId: aoiKey('A', 'cart', 'cart-total'),
      sessionIds: leftOverShipping,
      sessionCount: leftOverShipping.length,
      attribution: 'product',
      evidence_link: { screen: 'sessions', params: { variant: 'A', outcome: 'abandoned' } },
    },
    {
      id: 'F-6',
      rank: 6,
      severity: 'info',
      claim: '2 of 24 sessions ended in an automation failure and are excluded from both scores.',
      evidence:
        'Playwright selector timeout on the card-number iframe (S-09 on variant A, S-23 on variant B) after one retry each. This is a weakness of the simulation, never evidence against a variant.',
      // The finding concerns the simulation, not either variant: the prototype's chip reads
      // "both variants".
      variant: null,
      step: 'payment',
      aoiId: null,
      sessionIds: automationFailures,
      sessionCount: automationFailures.length,
      attribution: 'automation',
      evidence_link: { screen: 'sessions', params: { outcome: 'automation_failure' } },
    },
  ];
  return { schemaVersion: 1, runId: RUN_ID, findings };
};

const buildRun = (sessions: ReadonlyArray<Session>): Run => {
  const aois = buildAois();
  const scores = VARIANTS.map((variant) =>
    buildScore(
      variant.id,
      SESSION_ROWS.filter((row) => row.variant === variant.id),
    ),
  );
  const [scoreA, scoreB] = scores;
  const harder = scoreB.frictionScore.median >= scoreA.frictionScore.median ? scoreB : scoreA;
  const easier = harder === scoreB ? scoreA : scoreB;
  const disjoint = (seed: number): boolean => {
    const band = (score: Run['scores'][number]): { low: number; high: number } => {
      const group = score.perSeedGroup.find((entry) => entry.seed === seed);
      if (group === undefined) throw new Error(`no seed group ${seed}`);
      return {
        low: group.frictionScore - score.frictionScore.sd,
        high: group.frictionScore + score.frictionScore.sd,
      };
    };
    const [low, high] = [band(easier), band(harder)];
    return low.high < high.low;
  };
  const agreeing = SEED_GROUPS.filter(disjoint).length;

  return {
    schemaVersion: 1,
    runId: RUN_ID,
    createdAt: CREATED_AT.toISOString(),
    task: TASK,
    variants: VARIANTS,
    steps: STEPS,
    stepCaptions: STEP_CAPTION,
    personas: PERSONAS,
    seedGroups: SEED_GROUPS,
    engine: {
      mode: 'offline',
      provider: null,
      models: null,
      // The offline attention model's blend: bottom-up saliency, task relevance, and the
      // position bias that keeps a first fixation near where the page opens.
      weights: { alpha: 0.5, beta: 0.35, gamma: 0.15 },
      version: 'seed-fixture',
    },
    sessionIds: sessions.map((session) => session.sessionId),
    screenshots: VARIANTS.flatMap((variant) =>
      STEPS.map((step) => {
        const page = pageOf(variant.id, step.id);
        return {
          variant: variant.id,
          step: step.id,
          path: runPaths('').screenshot(variant.id, step.id),
          viewport: VIEWPORT,
          pageHeight: page.pageHeight,
          foldY: page.foldY,
        };
      }),
    ),
    aois,
    // Computed, never transcribed: the engine is the one place per-area numbers are made,
    // so the committed fixture is exactly what it produces from the sessions beside it.
    aoiMetrics: aggregate(sessions, aois),
    scores,
    verdict: {
      harderVariant: harder.variant,
      gapPoints: harder.frictionScore.median - easier.frictionScore.median,
      bandsDisjoint: agreeing === SEED_GROUPS.length,
      seedGroupsAgreeing: agreeing,
      sentence: VERDICT_SENTENCE,
    },
    calibration: { benchmark: 'UEyes', cc: 0.68, nss: 1.9, scanMatch: 0.54 },
  };
};

/* ===== the placeholder screenshots ========================================= */

/** A neutral placeholder palette. The screens themselves read `docs/design/tokens.css`. */
const INK = '#1d2433';
const FAINT = '#8a93a6';
const PAPER = '#ffffff';
const BLOCK_FILL = '#f1f3f8';
const BLOCK_LINE = '#c9d1e0';
const PRIMARY_FILL = '#dbe7ff';
const PRIMARY_LINE = '#6f93d8';
const FOLD = '#d4304a';

const escapeXml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ??
      character,
  );

const pageSvg = (variant: VariantId, label: string, page: PageLayout): string => {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWPORT.width}" height="${page.pageHeight}" viewBox="0 0 ${VIEWPORT.width} ${page.pageHeight}">`,
    `<rect width="${VIEWPORT.width}" height="${page.pageHeight}" fill="${PAPER}"/>`,
    `<g font-family="Helvetica, Arial, sans-serif" font-size="11">`,
  ];
  for (const placed of page.boxes) {
    const { box } = placed;
    const primary = placed.aoi?.isPrimaryAction === true;
    const text = placed.aoi === undefined ? (placed.caption ?? '') : placed.aoi.label;
    parts.push(
      `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="6" fill="${placed.aoi === undefined ? PAPER : primary ? PRIMARY_FILL : BLOCK_FILL}" stroke="${placed.aoi === undefined ? BLOCK_LINE : primary ? PRIMARY_LINE : BLOCK_LINE}" stroke-dasharray="${placed.aoi === undefined ? '4 4' : 'none'}"/>`,
      `<text x="${box.x + 10}" y="${box.y + 18}" fill="${placed.aoi === undefined ? FAINT : INK}">${escapeXml(text)}</text>`,
    );
  }
  parts.push(
    `<line x1="0" y1="${page.foldY}" x2="${VIEWPORT.width}" y2="${page.foldY}" stroke="${FOLD}" stroke-width="2" stroke-dasharray="9 6"/>`,
    `<text x="10" y="${page.foldY - 8}" fill="${FOLD}" font-size="11">fold · ${page.foldY} px</text>`,
    `<text x="10" y="${page.pageHeight - 14}" fill="${FAINT}">Variant ${variant} · ${label} · placeholder · ${VIEWPORT.width} × ${page.pageHeight}</text>`,
    `</g></svg>`,
  );
  return parts.join('\n');
};

/* ===== writing it out ====================================================== */

/**
 * Writes the seed example run under `runsRoot` and returns its directory. Everything goes
 * through the contract: `writeRun` for the JSON it has parsed, `runPaths` for every name.
 */
/**
 * The sessions reach each step as often as the prototype's filmstrip prints, over the
 * sessions that count towards a score. The generator refuses to write an artifact that
 * disagrees, so a change to an anchor or a fixation budget cannot quietly move a reach
 * count the Attention screen reads out.
 */
const checkReach = (sessions: ReadonlyArray<Session>): void => {
  for (const variant of VARIANTS) {
    for (const step of STEPS) {
      const reached = sessions.filter(
        (session) =>
          session.variant === variant.id &&
          !session.outcome.excludedFromScores &&
          session.screens.some((screen) => screen.step === step.id),
      ).length;
      const wanted = REACH[variant.id][step.id as StepId];
      if (reached !== wanted) {
        throw new Error(
          `variant ${variant.id}, ${step.id}: ${reached} sessions reached it, not the ${wanted} the prototype prints`,
        );
      }
    }
  }
};

export const writeSeedRun = async (runsRoot: string): Promise<string> => {
  const sessions = SESSION_ROWS.map(buildSession);
  checkReach(sessions);
  const run = buildRun(sessions);
  const findings = buildFindings(sessions);
  const runDir = join(runsRoot, RUN_ID);
  const paths = runPaths(runDir);

  await writeRun(runDir, { run, sessions, findings });

  for (const screenshot of run.screenshots) {
    const step = STEPS.find((candidate) => candidate.id === screenshot.step);
    const file = paths.screenshot(screenshot.variant, screenshot.step);
    await mkdir(dirname(file), { recursive: true });
    const svg = pageSvg(
      screenshot.variant as VariantId,
      step?.label ?? screenshot.step,
      pageOf(screenshot.variant as VariantId, screenshot.step as StepId),
    );
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file);
  }

  return runDir;
};

const main = async (): Promise<void> => {
  const runsRoot = resolve(process.argv[2] ?? fileURLToPath(new URL('../runs', import.meta.url)));
  const runDir = await writeSeedRun(runsRoot);
  process.stdout.write(`seed:example-run: wrote ${runDir}\n`);
};

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) await main();
