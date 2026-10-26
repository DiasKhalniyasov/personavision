/**
 * Variant B — the redesign candidate, and the three defects planted in it on purpose.
 *
 * This is the project's known answer: every later ticket that scores a run, writes a finding
 * or states ground truth is measured against the fact that these three things, and only
 * these three, were done deliberately. So the suite checks three promises:
 *
 * 1. **The ids are the prototype's.** `docs/design/prototype.html`'s `PAGES` is parsed, and
 *    each variant-B page has to carry exactly the ids its `only-a` *and* `only-b` branches
 *    declare — nothing invented, nothing dropped.
 * 2. **B is A plus exactly the declared edits.** `DEFECT_EDITS` below is the whole list of
 *    differences between the two variants. Applying it to variant A's markup has to produce
 *    variant B's markup byte for byte, so B cannot drift from A by accident and a fourth
 *    defect cannot arrive unannounced.
 * 3. **The defects do what they claim.** The totals, the one completing action and the
 *    banner are asserted as strings on the *served* pages, because that is what a browser
 *    and a driver will see, and `demo/README.md` — the index later tickets quote instead of
 *    re-reading HTML — is asserted against them.
 *
 * The helpers below are deliberately local: `shop.test.ts` owns variant A's copies and
 * neither file exports, because importing one Vitest file from another would run its suites.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveDemoShop } from '../serve.ts';
import type { DemoShop } from '../serve.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const read = (relativePath: string): string => readFileSync(join(repoRoot, relativePath), 'utf8');

/** The step pages: the prototype's `PAGES` key, and the URL each variant is served at. */
const STEP_PAGES = [
  { step: 'cart', file: 'cart.html' },
  { step: 'payment', file: 'payment.html' },
  { step: 'review', file: 'review.html' },
  { step: 'confirm', file: 'confirmation.html' },
] as const;

const ENTITIES: Readonly<Record<string, string>> = {
  '&middot;': '·',
  '&bull;': '•',
  '&minus;': '−',
  '&nbsp;': ' ',
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
};

const decodeEntities = (html: string): string =>
  html.replace(/&[a-z]+;/g, (entity) => ENTITIES[entity] ?? entity);

/** The words a reader sees, flattened, so an assertion does not depend on where tags fall. */
const visibleText = (html: string): string =>
  decodeEntities(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** Every `data-aoi` value in a document, in order, duplicates included. */
const aoiValues = (html: string): string[] =>
  [...html.matchAll(/data-aoi="([^"]+)"/g)].map((match) => match[1]);

const countOf = (html: string, id: string): number =>
  aoiValues(html).filter((value) => value === id).length;

/* ------------------------------------------------------------------ the declared defects */

/**
 * One difference between a variant-A page and its variant-B counterpart: the exact lines B
 * replaces, and what it puts in their place. `defect` is the ticket's numbering — 1 the
 * completing action nobody sees, 2 the fee that arrives after the card, 3 the banner that
 * takes the first look — and `0` is the one difference that is deliberately *not* a declared
 * defect: the payment step's "Place order" wording, which the prototype draws and reports as
 * a finding of its own.
 */
interface DefectEdit {
  readonly page: string;
  readonly defect: 0 | 1 | 2 | 3;
  readonly aoi: string;
  readonly why: string;
  readonly a: string;
  readonly b: string;
}

const lines = (...parts: readonly string[]): string => parts.map((part) => `${part}\n`).join('');

const DEFECT_EDITS: readonly DefectEdit[] = [
  {
    page: 'cart.html',
    defect: 3,
    aoi: 'promo',
    why: 'the banner goes above the content, between the bar and the body',
    a: lines('    </header>'),
    b: lines(
      '    </header>',
      '    <!-- Defect 3, the banner that takes the first look: above the content, on every step but the last. -->',
      '    <div class="promo" data-aoi="promo">',
      '      SPRING SALE &minus;20%<small>code SPRING20 &middot; today only</small>',
      '    </div>',
    ),
  },
  {
    page: 'cart.html',
    defect: 2,
    aoi: 'cart-total',
    why: 'shipping is deferred, so the cart total reads $129.00',
    a: lines(
      '            <dt>Shipping</dt>',
      '            <dd>$8.95</dd>',
      '            <dt class="total">Total</dt>',
      '            <dd class="total">$137.95</dd>',
    ),
    b: lines(
      '            <!-- Defect 2, where it begins: shipping is deferred, so this total is not the one paid. -->',
      '            <dt class="faint">Shipping</dt>',
      '            <dd class="faint">calculated later</dd>',
      '            <dt class="total">Total</dt>',
      '            <dd class="total">$129.00</dd>',
    ),
  },
  {
    page: 'payment.html',
    defect: 3,
    aoi: 'promo',
    why: 'the banner goes above the content, between the bar and the body',
    a: lines('    </header>'),
    b: lines(
      '    </header>',
      '    <!-- Defect 3, the banner that takes the first look: above the content, on every step but the last. -->',
      '    <div class="promo" data-aoi="promo">',
      '      SPRING SALE &minus;20%<small>code SPRING20 &middot; today only</small>',
      '    </div>',
    ),
  },
  {
    page: 'payment.html',
    defect: 0,
    aoi: 'primary',
    why: 'the prototype\u2019s own extra finding: "Place order" on a step that only advances',
    a: lines(
      '          <button class="cta" data-aoi="primary" type="submit">Continue to review</button>',
    ),
    b: lines(
      '          <!--',
      '            Carried over from the prototype and deliberately not one of the three declared',
      '            defects: this button says "Place order" but only advances to the review step.',
      '            The prototype draws it this way and reports it as a finding of its own; see the',
      '            variant-B section of `demo/README.md` for what that costs in measured precision.',
      '          -->',
      '          <button class="cta" data-aoi="primary" type="submit">Place order &middot; $129.00</button>',
    ),
  },
  {
    page: 'payment.html',
    defect: 2,
    aoi: 'shipping-row',
    why: 'shipping is still deferred, so the agreed total reads $129.00',
    a: lines(
      '            <dt>Shipping</dt>',
      '            <dd>$8.95</dd>',
      '            <dt class="total">Total</dt>',
      '            <dd class="total">$137.95</dd>',
    ),
    b: lines(
      '            <!-- Defect 2, still deferred: the amount agreed to here is $129.00. -->',
      '            <dt class="faint" data-aoi="shipping-row">Shipping</dt>',
      '            <dd class="faint">calculated at next step</dd>',
      '            <dt class="total">Total</dt>',
      '            <dd class="total">$129.00</dd>',
    ),
  },
  {
    page: 'review.html',
    defect: 3,
    aoi: 'promo',
    why: 'the banner goes above the content, between the bar and the body',
    a: lines('    </header>'),
    b: lines(
      '    </header>',
      '    <!-- Defect 3, the banner that takes the first look: above the content, on every step but the last. -->',
      '    <div class="promo" data-aoi="promo">',
      '      SPRING SALE &minus;20%<small>code SPRING20 &middot; today only</small>',
      '    </div>',
    ),
  },
  {
    page: 'review.html',
    defect: 1,
    aoi: 'complete',
    why: 'the completing action is demoted and pushed below the fold by the spacer',
    a: lines(
      '        <!-- The one completing action on the step. -->',
      '        <form method="get" action="confirmation.html">',
      '          <button class="cta" data-aoi="complete" type="submit">',
      '            Place order &middot; $137.95',
    ),
    b: lines(
      '        <!--',
      '          Defect 1, the completing action nobody sees. Still the one completing action on',
      '          the step, and still reachable by scrolling, so the task stays completable: the',
      "          spacer pushes it below the fold at both viewports and the shop's secondary",
      "          treatment demotes it. The spacer's height is measured, not guessed; the",
      '          arithmetic is in the variant-B section of `demo/README.md`.',
      '        -->',
      '        <form method="get" action="confirmation.html">',
      '          <div class="pushdown" aria-hidden="true"></div>',
      '          <button class="cta weak" data-aoi="complete" type="submit">',
      '            Confirm purchase &middot; $147.95',
    ),
  },
  {
    page: 'review.html',
    defect: 2,
    aoi: 'fee-row',
    why: 'the $9.95 service fee appears for the first time, and takes the total to $147.95',
    a: lines(
      '            <dd>$8.95</dd>',
      '            <dt class="total">Total</dt>',
      '            <dd class="total">$137.95</dd>',
    ),
    b: lines(
      '            <dd>$8.95</dd>',
      '            <!-- Defect 2, the fee that arrives after the card: its first appearance in the flow. -->',
      '            <dt class="fee-new" data-aoi="fee-row">Service fee</dt>',
      '            <dd class="fee-new">$9.95</dd>',
      '            <dt class="total">Total</dt>',
      '            <dd class="total fee-new">$147.95</dd>',
    ),
  },
  {
    page: 'confirmation.html',
    defect: 2,
    aoi: 'summary',
    why: 'the fee is in the amount paid: $147.95',
    a: lines(
      '          <dd>$8.95</dd>',
      '          <dt class="total">Paid</dt>',
      '          <dd class="total">$137.95</dd>',
    ),
    b: lines(
      '          <dd>$8.95</dd>',
      '          <!--',
      '            Defect 2, where it ends: the fee is in the amount paid. It is a plain row here,',
      '            not an alarmed one \u2014 the alarm colour belongs to the step where the fee first',
      '            appears, and this page is only a receipt.',
      '          -->',
      '          <dt>Service fee</dt>',
      '          <dd>$9.95</dd>',
      '          <dt class="total">Paid</dt>',
      '          <dd class="total">$147.95</dd>',
    ),
  },
];

/** Variant A's markup with every edit for that page applied, in file order. */
const applyDefects = (file: string, variantA: string): string => {
  let markup = variantA;
  for (const edit of DEFECT_EDITS.filter((candidate) => candidate.page === file)) {
    const occurrences = markup.split(edit.a).length - 1;
    expect(
      occurrences,
      `the variant-A lines edit "${edit.aoi}" on ${file} replaces appear exactly once`,
    ).toBe(1);
    markup = markup.replace(edit.a, edit.b);
  }
  return markup;
};

/* -------------------------------------------------------------------------- prototype */

/**
 * The `PAGES` constant of `docs/design/prototype.html`, split per step into the ids a
 * variant-A branch declares and the ids only a variant-B branch does. An element's own
 * `class` carries `only-a` / `only-b`, which is also where its `data-aoi` sits, so reading
 * the opening tag is enough. Variant B carries both sets: it is variant A's chrome with the
 * defects added, not a different page.
 */
const prototypeAoi = (): Map<string, { a: string[]; b: string[] }> => {
  const source = read('docs/design/prototype.html');
  const start = source.indexOf('const PAGES = {');
  expect(start, 'docs/design/prototype.html declares a PAGES constant').toBeGreaterThan(-1);

  const byStep = new Map<string, { a: string[]; b: string[] }>();
  for (const [, step, markup] of source.slice(start).matchAll(/(\w+):\s*`([\s\S]*?)`/g)) {
    const ids = { a: [] as string[], b: [] as string[] };
    for (const tag of markup.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      const aoi = /data-aoi="([^"]+)"/.exec(tag);
      if (aoi === null) continue;
      const classes = (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/);
      ids[classes.includes('only-b') ? 'b' : 'a'].push(aoi[1]);
    }
    byStep.set(step, ids);
    if (step === 'confirm') break;
  }
  return byStep;
};

const PROTOTYPE = prototypeAoi();

/** The ids variant B carries on a step: the variant-A set plus the variant-B-only ones. */
const expectedIds = (step: string): string[] => {
  const ids = PROTOTYPE.get(step);
  expect(ids, `the prototype declares a "${step}" step`).toBeDefined();
  return [...new Set([...(ids?.a ?? []), ...(ids?.b ?? [])])];
};

/* ------------------------------------------------------------------------- the spacer */

const SHOP_CSS = read('demo/northwind/shared/shop.css');

/** The `.pushdown` height from the stylesheet, in px — the one place the value is written. */
const spacerHeight = (): number => {
  const rule = /\.pushdown\s*\{[^}]*height:\s*(\d+)px/.exec(SHOP_CSS);
  expect(rule, 'shared/shop.css declares a .pushdown height in px').not.toBeNull();
  return Number(rule?.[1]);
};

const SPACER_PX = spacerHeight();

/* ----------------------------------------------------------------------------- README */

const README = read('demo/README.md');

const readmeSection = (title: string): string => {
  const section = README.split('\n## ').find((part) => part.startsWith(title));
  if (section === undefined) throw new Error(`demo/README.md has no "## ${title}" section`);
  return section;
};

/** The rows of a markdown table in a section, as trimmed cells, header and rule dropped. */
const tableRows = (section: string): string[][] =>
  section
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));

/** Rows of a table in the variant-B section, keyed by the `/b/…` URL in the first cell. */
const bRowsOf = (section: string): Map<string, string[]> => {
  const byPage = new Map<string, string[]>();
  for (const cells of tableRows(readmeSection(section))) {
    const page = cells[0].replace(/`/g, '');
    if (!page.startsWith('/b/')) continue;
    byPage.set(page, cells);
  }
  return byPage;
};

const backticked = (cell: string): string[] =>
  [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

const VARIANT_B_SECTION = 'Variant B: the three planted defects';

/**
 * The variant-B section's fold-arithmetic table: its labels, backticks stripped, against the
 * px value each states. The section's other tables carry no bare-integer second cell.
 */
const foldArithmetic = (): Map<string, number> => {
  const values = new Map<string, number>();
  for (const cells of tableRows(readmeSection(VARIANT_B_SECTION))) {
    if (cells.length === 2 && /^\d+$/.test(cells[1])) {
      values.set(cells[0].replace(/`/g, '').replace(/\s+/g, ' ').trim(), Number(cells[1]));
    }
  }
  expect(values.size, 'demo/README.md writes out the fold arithmetic').toBeGreaterThan(4);
  return values;
};

/* ----------------------------------------------------------------------------- server */

interface Fetched {
  status: number;
  contentType: string | null;
  body: string;
}

let shop: DemoShop;
const served = new Map<string, string>();

const get = async (path: string): Promise<Fetched> => {
  const response = await fetch(`${shop.url}${path}`, { redirect: 'manual' });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  };
};

/** The served HTML of a page, fetched once in `beforeAll`. */
const page = (url: string): string => {
  const html = served.get(url);
  if (html === undefined) throw new Error(`${url} was not fetched`);
  return html;
};

beforeAll(async () => {
  shop = await serveDemoShop();
  for (const { file } of STEP_PAGES) {
    for (const url of [`/a/${file}`, `/b/${file}`]) {
      const fetched = await get(url);
      expect(fetched.status, `${url} is served`).toBe(200);
      expect(fetched.contentType, `${url} is served as HTML`).toBe('text/html; charset=utf-8');
      served.set(url, fetched.body);
    }
  }
});

afterAll(async () => {
  await shop.close();
});

/* ====================================================================== the test suite */

describe("variant B's areas of interest are the prototype's", () => {
  it('found all four step pages in the prototype', () => {
    expect([...PROTOTYPE.keys()]).toEqual(['cart', 'payment', 'review', 'confirm']);
  });

  for (const { step, file } of STEP_PAGES) {
    describe(`/b/${file}`, () => {
      it('carries exactly the ids the prototype declares for variant B, and no others', () => {
        const expected = expectedIds(step);
        expect(expected.length).toBeGreaterThan(3);
        expect([...aoiValues(page(`/b/${file}`))].sort()).toEqual([...expected].sort());
      });

      it('declares each of them exactly once', () => {
        for (const id of expectedIds(step)) {
          expect(countOf(page(`/b/${file}`), id), `data-aoi="${id}" on /b/${file}`).toBe(1);
        }
      });

      it('carries every id its variant-A counterpart carries', () => {
        for (const id of aoiValues(page(`/a/${file}`))) {
          expect(countOf(page(`/b/${file}`), id), `variant A's "${id}" is also on /b/${file}`).toBe(
            1,
          );
        }
      });
    });
  }

  it('adds promo to the cart, payment and review steps and fee-row to review, and nothing else', () => {
    const added = new Map(
      STEP_PAGES.map(({ file }) => [
        `/b/${file}`,
        aoiValues(page(`/b/${file}`)).filter((id) => !aoiValues(page(`/a/${file}`)).includes(id)),
      ]),
    );
    expect(added.get('/b/cart.html')).toEqual(['promo']);
    expect(added.get('/b/payment.html')).toEqual(['promo', 'shipping-row']);
    expect(added.get('/b/review.html')).toEqual(['promo', 'fee-row']);
    expect(added.get('/b/confirmation.html')).toEqual([]);
  });
});

describe('variant B is variant A plus exactly the declared defect edits', () => {
  for (const { file } of STEP_PAGES) {
    it(`/b/${file} is /a/${file} with only those edits applied`, () => {
      expect(applyDefects(file, page(`/a/${file}`))).toBe(page(`/b/${file}`));
    });
  }

  it('declares an edit for every page that differs, and none for a page that does not', () => {
    for (const { file } of STEP_PAGES) {
      const edits = DEFECT_EDITS.filter((edit) => edit.page === file);
      const differs = page(`/a/${file}`) !== page(`/b/${file}`);
      expect(edits.length > 0, `/b/${file} differs from /a/${file}`).toBe(differs);
    }
  });

  it('plants three defects and carries over exactly one difference that is not one', () => {
    expect([...new Set(DEFECT_EDITS.map((edit) => edit.defect))].sort()).toEqual([0, 1, 2, 3]);
    expect(DEFECT_EDITS.filter((edit) => edit.defect === 0)).toHaveLength(1);
    expect(DEFECT_EDITS.find((edit) => edit.defect === 0)?.page).toBe('payment.html');
  });

  it('leaves the shared chrome, the titles and the relative links untouched', () => {
    for (const { file } of STEP_PAGES) {
      const a = page(`/a/${file}`);
      const b = page(`/b/${file}`);
      expect(/<title>([^<]*)<\/title>/.exec(b)?.[1]).toBe(/<title>([^<]*)<\/title>/.exec(a)?.[1]);
      expect([...b.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])).toEqual(
        [...a.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
      );
      expect(/<header class="shop-bar">[\s\S]*?<\/header>/.exec(b)?.[0]).toBe(
        /<header class="shop-bar">[\s\S]*?<\/header>/.exec(a)?.[0],
      );
    }
  });
});

describe('defect 1: the completing action nobody sees', () => {
  const url = '/b/review.html';

  it('has exactly one completing action, and it is the one marked complete', () => {
    const html = page(url);
    expect(html.match(/<button\b/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*data-aoi="complete"/);
    expect(visibleText(html)).toContain('Confirm purchase · $147.95');
    expect(visibleText(html)).not.toContain('Place order');
  });

  it('sits below the spacer, inside the form that completes the order', () => {
    const form = /<form[^>]*action="confirmation\.html">([\s\S]*?)<\/form>/.exec(page(url))?.[1];
    expect(form, 'the completing form').toBeDefined();
    expect(form).toContain('<div class="pushdown" aria-hidden="true"></div>');
    expect((form ?? '').indexOf('class="pushdown"')).toBeLessThan(
      (form ?? '').indexOf('data-aoi="complete"'),
    );
  });

  it('is demoted: the same control as variant A, in the weaker treatment', () => {
    expect(page('/a/review.html')).toMatch(/<button class="cta" data-aoi="complete"/);
    expect(page(url)).toMatch(/<button class="cta weak" data-aoi="complete"/);
  });

  it('is the only thing on the step that advances the task', () => {
    const html = page(url);
    const forms = [...html.matchAll(/<form[^>]*action="([^"]+)"/g)].map((match) => match[1]);
    expect(forms).toEqual(['confirmation.html']);
    for (const href of [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1])) {
      expect(href, `${href} does not advance the task`).not.toContain('confirmation.html');
    }
  });

  it('keeps variant A\u2019s weight on the grand total the fee changes', () => {
    // `.summary .total` and `.summary .fee-new` have equal specificity, so without this rule
    // the later one wins on `class="total fee-new"` and renders B's total lighter than A's —
    // a fourth visual difference, in the region the run photographs. Measured in Chrome
    // before the rule existed: 500 against variant A's 700.
    expect(SHOP_CSS).toMatch(/\.summary \.total\.fee-new\s*\{[^}]*font-weight:\s*700/);
    expect(page('/b/review.html')).toContain('<dd class="total fee-new">$147.95</dd>');
  });

  it('is still reachable: the spacer is empty, hidden from assistive tech, and scrollable past', () => {
    expect(SPACER_PX).toBeGreaterThan(0);
    expect(page(url)).toContain('<div class="pushdown" aria-hidden="true"></div>');
    expect(SHOP_CSS).not.toMatch(/\.pushdown\s*\{[^}]*position:/);
    expect(SHOP_CSS).not.toMatch(/\.cta\.weak\s*\{[^}]*display:\s*none/);
  });
});

describe('defect 2: the fee that arrives after the card', () => {
  it('reads $129.00 with shipping deferred on the cart and the payment step', () => {
    for (const [url, deferred] of [
      ['/b/cart.html', 'calculated later'],
      ['/b/payment.html', 'calculated at next step'],
    ] as const) {
      const text = visibleText(page(url));
      expect(text).toContain('$129.00');
      expect(text).toContain(`Shipping ${deferred}`);
      expect(text).toContain('Total $129.00');
      expect(text, `the fee has not appeared yet on ${url}`).not.toContain('$9.95');
      expect(text, `the final total has not appeared yet on ${url}`).not.toContain('$147.95');
    }
  });

  it('reveals the $9.95 service fee for the first time on the review step', () => {
    const text = visibleText(page('/b/review.html'));
    expect(text).toContain('Service fee $9.95');
    expect(text).toContain('Total $147.95');
    expect(countOf(page('/b/review.html'), 'fee-row')).toBe(1);
    expect(page('/b/review.html')).toMatch(
      /<dt class="fee-new" data-aoi="fee-row">Service fee<\/dt>/,
    );
  });

  it('carries the fee into the amount paid on the confirmation step', () => {
    const text = visibleText(page('/b/confirmation.html'));
    expect(text).toContain('Service fee $9.95');
    expect(text).toContain('Paid $147.95');
  });

  it('never states variant A’s $137.95 anywhere on variant B', () => {
    for (const { file } of STEP_PAGES) {
      expect(visibleText(page(`/b/${file}`)), `/b/${file}`).not.toContain('$137.95');
    }
  });

  it('is the jump the defect claims: the agreed total is not the confirmed one', () => {
    expect(visibleText(page('/b/payment.html'))).toContain('Total $129.00');
    expect(visibleText(page('/b/review.html'))).toContain('Total $147.95');
  });
});

describe('defect 3: the banner that takes the first look', () => {
  it('is capped to the width of the column beneath it', () => {
    // `.body` is 980px wide with 20px of padding; uncapped, the banner ran to the full
    // viewport and overhung that column by 420px at 1440px wide.
    expect(SHOP_CSS).toMatch(/\.promo\s*\{[^}]*max-width:\s*940px/);
  });

  it('sits above the content on the cart, payment and review steps', () => {
    for (const file of ['cart.html', 'payment.html', 'review.html']) {
      const html = page(`/b/${file}`);
      expect(countOf(html, 'promo'), `promo on /b/${file}`).toBe(1);
      expect(visibleText(html)).toContain('SPRING SALE −20%');
      expect(visibleText(html)).toContain('code SPRING20 · today only');
      expect(
        html.indexOf('data-aoi="promo"'),
        `the banner precedes the body on /b/${file}`,
      ).toBeLessThan(html.indexOf('<main'));
    }
  });

  it('is absent from the confirmation step, as the prototype draws it', () => {
    expect(countOf(page('/b/confirmation.html'), 'promo')).toBe(0);
    expect(visibleText(page('/b/confirmation.html'))).not.toContain('SPRING SALE');
  });

  it('is not a control: it competes for attention without being clickable', () => {
    const banner = /<div class="promo"[\s\S]*?<\/div>/.exec(page('/b/cart.html'))?.[0] ?? '';
    expect(banner).not.toContain('href');
    expect(banner).not.toContain('<button');
    expect(banner).not.toContain('<input');
  });
});

describe('the carried-over wording that is deliberately not a declared defect', () => {
  it('says "Place order" on the payment step, which only advances to review', () => {
    const html = page('/b/payment.html');
    expect(visibleText(html)).toContain('Place order · $129.00');
    expect(html).toMatch(/<form[^>]*action="review\.html"/);
    expect(html).toMatch(/<button class="cta" data-aoi="primary"/);
  });

  it('is recorded as such in demo/README.md, not counted among the three', () => {
    const section = readmeSection(VARIANT_B_SECTION);
    expect(section).toContain('Place order');
    expect(section.toLowerCase()).toContain('not one of the three');
  });
});

describe('the task can still be completed on variant B with JavaScript disabled', () => {
  it('serves no script at all', () => {
    for (const { file } of STEP_PAGES) {
      expect(page(`/b/${file}`).toLowerCase(), `/b/${file} is script-free`).not.toContain(
        '<script',
      );
    }
  });

  it('advances from the cart by an ordinary link', async () => {
    expect(page('/b/cart.html')).toMatch(
      /data-aoi="cart-checkout"[^>]*href="payment\.html"|href="payment\.html"[^>]*data-aoi="cart-checkout"/,
    );
    expect((await get('/b/payment.html')).status).toBe(200);
  });

  it('advances from the payment step by a GET form submit, query string and all', async () => {
    const form = /<form[^>]*>/.exec(page('/b/payment.html'))?.[0] ?? '';
    expect(form).toContain('method="get"');
    expect(form).toContain('action="review.html"');

    const submitted = await get('/b/review.html?email=you%40example.com&expiry=09+%2F+29&cvc=123');
    expect(submitted.status).toBe(200);
    expect(submitted.body).toContain('Review your order');
  });

  it('advances from the review step by a GET form submit', async () => {
    const submitted = await get('/b/confirmation.html?');
    expect(submitted.status).toBe(200);
    expect(submitted.body).toContain('Order placed');
    expect(visibleText(submitted.body)).toContain('Paid $147.95');
  });

  it('keeps the inherited dead ends reachable as real pages', async () => {
    expect(page('/b/payment.html')).toContain('href="../shared/help.html"');
    expect((await get('/shared/help.html')).status).toBe(200);
    expect(page('/b/cart.html')).toMatch(/data-aoi="keep-shopping"[^>]*href="cart\.html"/);
  });

  it('leaves no way from the shared help page into either variant', async () => {
    // Both variants share this page. A link to `../a/cart.html` on it would walk a variant-B
    // session into variant A and go on attributing it to variant B, so the comparison would
    // be measuring the wrong pages. The way back is the browser's back button.
    const help = await get('/shared/help.html');
    expect(help.status).toBe(200);
    for (const href of [...help.body.matchAll(/href="([^"]+)"/g)].map((match) => match[1])) {
      expect(href, `${href} leads back into a variant`).not.toMatch(/\.\.\/[ab]\//);
    }
  });

  it('embeds the same shared card frame as variant A', async () => {
    expect(page('/b/payment.html')).toContain('src="../shared/card-frame.html"');
    expect(page('/b/payment.html')).not.toContain('name="card-number"');
    expect((await get('/shared/card-frame.html')).status).toBe(200);
  });

  it('adds no dependency to the shop', () => {
    const manifest = JSON.parse(read('demo/northwind/package.json')) as Record<string, unknown>;
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
  });
});

describe('demo/README.md documents variant B', () => {
  it('lists, per page, exactly the ids that page carries', () => {
    const claimed = bRowsOf('Variant B: the three planted defects');
    expect([...claimed.keys()]).toEqual(STEP_PAGES.map(({ file }) => `/b/${file}`));

    for (const { file } of STEP_PAGES) {
      const ids = backticked(claimed.get(`/b/${file}`)?.[1] ?? '');
      expect([...ids].sort(), `the ids demo/README.md claims for /b/${file}`).toEqual(
        [...aoiValues(page(`/b/${file}`))].sort(),
      );
    }
  });

  it('names each defect with the step and the region it lives in', () => {
    const section = readmeSection(VARIANT_B_SECTION);
    for (const [defect, aoi, step] of [
      [1, 'complete', '/b/review.html'],
      [2, 'fee-row', '/b/review.html'],
      [3, 'promo', '/b/cart.html'],
    ] as const) {
      expect(section, `defect ${defect} is named`).toContain(`\`${aoi}\``);
      expect(section, `defect ${defect} names its step`).toContain(step);
    }
  });

  it('states the spacer height the stylesheet uses', () => {
    expect(foldArithmetic().get('The .pushdown spacer')).toBe(SPACER_PX);
  });

  it('writes out fold arithmetic that adds up, at both viewports', () => {
    const px = foldArithmetic();
    const natural = px.get('Top edge of the completing action, less the spacer');
    const served = px.get('Top edge of the completing action, as served');
    const mobileFold = px.get('The fold at 390 x 844');
    const desktopFold = px.get('The fold at 1440 x 900');

    for (const [label, value] of [
      ['the top edge less the spacer', natural],
      ['the top edge as served', served],
      ['the mobile fold', mobileFold],
      ['the desktop fold', desktopFold],
    ] as const) {
      expect(value, `the fold arithmetic states ${label}`).toBeDefined();
    }

    // The spacer is what puts the control below the fold, and by how much at each viewport.
    expect((natural as number) + SPACER_PX).toBe(served);
    expect((served as number) - (mobileFold as number)).toBe(px.get('Below the mobile fold'));
    expect((served as number) - (desktopFold as number)).toBe(px.get('Below the desktop fold'));
    expect(served, 'the completing action is below the fold at both viewports').toBeGreaterThan(
      Math.max(mobileFold as number, desktopFold as number),
    );

    const section = readmeSection(VARIANT_B_SECTION);
    expect(section).toContain('390 \u00d7 844');
    expect(section).toContain('1440 \u00d7 900');
  });
});
