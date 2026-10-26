/**
 * The demo shop is the system under test for the whole project, so these tests check the
 * two promises it makes to other tickets rather than its looks:
 *
 * 1. Its `data-aoi` ids are exactly the variant-A ids `docs/design/prototype.html` declares.
 *    Those ids travel into the Attention screen, the findings and the ground truth; a
 *    rename here breaks three later tickets silently, so the prototype is parsed and
 *    compared rather than trusted.
 * 2. `demo/README.md` is the index later tickets quote instead of re-reading HTML, so the
 *    ids, primary actions, viewports and stall switch it claims are asserted against the
 *    pages themselves.
 *
 * Everything is asserted over the *served* HTML, through `serveDemoShop()`, because that is
 * what a browser will see.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveDemoShop } from '../serve.ts';
import type { DemoShop } from '../serve.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const read = (relativePath: string): string => readFileSync(join(repoRoot, relativePath), 'utf8');

/** The step pages, as the prototype's `PAGES` key and the URL the shop serves it at. */
const STEP_PAGES = [
  { step: 'cart', url: '/a/cart.html' },
  { step: 'payment', url: '/a/payment.html' },
  { step: 'review', url: '/a/review.html' },
  { step: 'confirm', url: '/a/confirmation.html' },
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
  decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** Every `data-aoi` value in a document, in order, duplicates included. */
const aoiValues = (html: string): string[] =>
  [...html.matchAll(/data-aoi="([^"]+)"/g)].map((match) => match[1]);

const countOf = (html: string, id: string): number =>
  aoiValues(html).filter((value) => value === id).length;

/* -------------------------------------------------------------------------- prototype */

/**
 * The `PAGES` constant of `docs/design/prototype.html`, split per step into the ids a
 * variant-A branch declares and the ids only a variant-B branch does. An element's own
 * `class` carries `only-a` / `only-b`, which is also where its `data-aoi` sits, so reading
 * the opening tag is enough.
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

/** Rows of a table keyed by a page URL in backticks in the first cell. */
const rowsByPage = (title: string): Map<string, string[]> => {
  const byPage = new Map<string, string[]>();
  for (const cells of tableRows(readmeSection(title))) {
    const page = cells[0].replace(/`/g, '');
    if (!page.startsWith('/a/')) continue;
    byPage.set(page, cells);
  }
  return byPage;
};

const backticked = (cell: string): string[] =>
  [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

/* ----------------------------------------------------------------------------- server */

interface Fetched {
  status: number;
  contentType: string | null;
  location: string | null;
  body: string;
}

let shop: DemoShop;
const pages = new Map<string, string>();

const get = async (path: string, init?: RequestInit): Promise<Fetched> => {
  const response = await fetch(`${shop.url}${path}`, { redirect: 'manual', ...init });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    location: response.headers.get('location'),
    body: await response.text(),
  };
};

/** The served HTML of a step page, fetched once. */
const page = (url: string): string => {
  const html = pages.get(url);
  if (html === undefined) throw new Error(`${url} was not fetched`);
  return html;
};

beforeAll(async () => {
  shop = await serveDemoShop();
  for (const { url } of STEP_PAGES) {
    const fetched = await get(url);
    expect(fetched.status, `${url} is served`).toBe(200);
    pages.set(url, fetched.body);
  }
});

afterAll(async () => {
  await shop.close();
});

/* ====================================================================== the test suite */

describe("the areas of interest are the prototype's", () => {
  it('found all four step pages in the prototype', () => {
    expect([...PROTOTYPE.keys()]).toEqual(['cart', 'payment', 'review', 'confirm']);
  });

  for (const { step, url } of STEP_PAGES) {
    describe(url, () => {
      it('carries exactly the ids the variant-A branches declare, and no others', () => {
        const expected = PROTOTYPE.get(step)?.a ?? [];
        expect(expected.length).toBeGreaterThan(3);
        expect([...aoiValues(page(url))].sort()).toEqual([...expected].sort());
      });

      it('declares each of them exactly once', () => {
        for (const id of PROTOTYPE.get(step)?.a ?? []) {
          expect(countOf(page(url), id), `data-aoi="${id}" on ${url}`).toBe(1);
        }
      });

      it('carries no id that only a variant-B branch declares', () => {
        const bOnly = (PROTOTYPE.get(step)?.b ?? []).filter(
          (id) => !(PROTOTYPE.get(step)?.a ?? []).includes(id),
        );
        for (const id of bOnly) {
          expect(countOf(page(url), id), `variant-B id "${id}" leaked onto ${url}`).toBe(0);
        }
      });
    });
  }
});

describe('demo/README.md is the index later tickets quote', () => {
  it('lists, per page, exactly the ids that page carries', () => {
    const claimed = rowsByPage('Areas of interest, per page');
    expect([...claimed.keys()]).toEqual(STEP_PAGES.map((p) => p.url));

    for (const { url } of STEP_PAGES) {
      const ids = backticked(claimed.get(url)?.[1] ?? '');
      expect([...ids].sort(), `the ids demo/README.md claims for ${url}`).toEqual(
        [...aoiValues(page(url))].sort(),
      );
    }
  });

  it("names each step's primary action, and the pages carry it", () => {
    const claimed = rowsByPage('The primary action, per page');
    expect([...claimed.keys()]).toEqual(STEP_PAGES.map((p) => p.url));

    let named = 0;
    for (const { url } of STEP_PAGES) {
      const cells = claimed.get(url) ?? [];
      const selector = cells[2] ?? '';
      if (selector === '—') continue;
      named += 1;

      const id = /data-aoi="([^"]+)"/.exec(selector)?.[1];
      expect(id, `the selector demo/README.md gives for ${url}`).toBeDefined();
      expect(countOf(page(url), id as string)).toBe(1);

      const label = /"([^"]+)"/.exec(cells[1] ?? '')?.[1];
      expect(label, `the label demo/README.md gives for ${url}`).toBeDefined();
      expect(visibleText(page(url))).toContain(label as string);
    }
    // Three steps advance; the confirmation step is terminal.
    expect(named).toBe(3);
  });

  it('documents both viewports', () => {
    const viewports = readmeSection('Viewports');
    expect(viewports).toContain('390 × 844');
    expect(viewports).toContain('1440 × 900');
    expect(viewports.toLowerCase()).toContain('touch');
    expect(viewports.toLowerCase()).toContain('one column');
    expect(viewports.toLowerCase()).toContain('two columns');
  });

  it('documents the stall switch', () => {
    const stall = readmeSection('The stall switch');
    expect(stall).toContain('shared/card-frame.html');
    expect(stall).toContain('?stall=1');
    expect(stall.toLowerCase()).toContain('never');
  });

  it('documents the URL of every step page', () => {
    const urls = tableRows(readmeSection('URL layout')).map((cells) => cells[0].replace(/`/g, ''));
    for (const { url } of STEP_PAGES) {
      expect(urls).toContain(url);
    }
  });
});

describe('the task can be completed with JavaScript disabled', () => {
  it('serves no script at all', () => {
    for (const { url } of STEP_PAGES) {
      expect(page(url).toLowerCase(), `${url} is script-free`).not.toContain('<script');
    }
  });

  it('advances from the cart by an ordinary link', async () => {
    expect(page('/a/cart.html')).toMatch(
      /data-aoi="cart-checkout"[^>]*href="payment\.html"|href="payment\.html"[^>]*data-aoi="cart-checkout"/,
    );
    expect((await get('/a/payment.html')).status).toBe(200);
  });

  it('advances from the payment step by a GET form submit, query string and all', async () => {
    const form = /<form[^>]*>/.exec(page('/a/payment.html'))?.[0] ?? '';
    expect(form).toContain('method="get"');
    expect(form).toContain('action="review.html"');

    const submitted = await get('/a/review.html?email=you%40example.com&expiry=09+%2F+29&cvc=123');
    expect(submitted.status).toBe(200);
    expect(submitted.body).toContain('Review your order');
  });

  it('advances from the review step by a GET form submit', async () => {
    const form = /<form[^>]*>/.exec(page('/a/review.html'))?.[0] ?? '';
    expect(form).toContain('method="get"');
    expect(form).toContain('action="confirmation.html"');

    const submitted = await get('/a/confirmation.html?');
    expect(submitted.status).toBe(200);
    expect(submitted.body).toContain('Order placed');
  });

  it('keeps the dead ends reachable as real pages', async () => {
    expect(page('/a/payment.html')).toContain('href="../shared/help.html"');
    expect((await get('/shared/help.html')).status).toBe(200);
    expect(page('/a/cart.html')).toMatch(/data-aoi="keep-shopping"[^>]*href="cart\.html"/);
  });
});

describe('the payment step', () => {
  for (const [id, label] of [
    ['email', 'Email'],
    ['expiry', 'Expiry'],
    ['cvc', 'CVC'],
  ] as const) {
    it(`has a labelled ${id} control`, () => {
      const html = page('/a/payment.html');
      expect(html).toContain(`<label for="${id}">${label}</label>`);
      expect(html).toMatch(new RegExp(`<input[^>]*\\sid="${id}"`));
      expect(html).toMatch(new RegExp(`<input[^>]*\\sname="${id}"`));
    });
  }

  it('puts the card-number field in a same-origin iframe inside the card region', () => {
    const html = page('/a/payment.html');
    const cardAt = html.indexOf('data-aoi="card"');
    const frameAt = html.indexOf('src="../shared/card-frame.html"');
    // `indexOf` is -1 when the card region is the last one on the page, which would make
    // the comparison below fail for the wrong reason if payment.html were ever reordered.
    const after = html.indexOf('data-aoi=', cardAt + 1);
    const nextRegionAt = after === -1 ? html.length : after;

    expect(cardAt).toBeGreaterThan(-1);
    expect(frameAt, 'the card frame is embedded').toBeGreaterThan(cardAt);
    expect(frameAt, 'the card frame sits inside the card region').toBeLessThan(nextRegionAt);
    expect(visibleText(html)).toContain('Card number');
  });

  it('holds no card number of its own: the field only exists in the frame', () => {
    expect(page('/a/payment.html')).not.toContain('name="card-number"');
  });

  it('labels the card-number input inside the frame', async () => {
    const frame = await get('/shared/card-frame.html');
    expect(frame.status).toBe(200);
    expect(frame.contentType).toBe('text/html; charset=utf-8');

    const labelFor = /<label\s+for="([^"]+)">([^<]*)<\/label>/.exec(frame.body);
    expect(labelFor, 'the frame carries a label').not.toBeNull();
    expect(labelFor?.[2].trim()).toBe('Card number');
    expect(frame.body).toMatch(new RegExp(`<input[^>]*\\sid="${labelFor?.[1]}"`));
    expect(frame.body).toContain('name="card-number"');
  });
});

describe('the review step has exactly one completing action', () => {
  it('carries one button, and it is the one marked complete', () => {
    const html = page('/a/review.html');
    const buttons = html.match(/<button\b/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*data-aoi="complete"/);
    expect(visibleText(html)).toContain('Place order · $137.95');
  });
});

describe('the order reads the same all the way through', () => {
  for (const { url } of STEP_PAGES) {
    it(`states $129.00, $8.95 and $137.95 on ${url}`, () => {
      const text = visibleText(page(url));
      expect(text).toContain('$129.00');
      expect(text).toContain('$8.95');
      expect(text).toContain('$137.95');
      expect(text).not.toContain('$147.95');
    });
  }

  it('labels the up-front shipping on the cart', () => {
    const text = visibleText(page('/a/cart.html'));
    expect(text).toContain('Subtotal');
    expect(text).toContain('Shipping');
    expect(text).toContain('Total');
  });

  it('names the one product', () => {
    const text = visibleText(page('/a/cart.html'));
    expect(text).toContain('Ridgeline hiking boots');
    expect(text).toContain('size 43 · brown');
  });

  it('names the order number on the confirmation page', () => {
    const html = page('/a/confirmation.html');
    expect(countOf(html, 'order-number')).toBe(1);
    expect(visibleText(html)).toContain('NW-20418');
    expect(visibleText(html)).toContain('Order placed');
  });

  it('empties the cart badge on the confirmation page only', () => {
    expect(visibleText(page('/a/confirmation.html'))).toContain('Cart (0)');
    for (const { url } of STEP_PAGES.slice(0, 3)) {
      expect(visibleText(page(url))).toContain('Cart (1)');
    }
  });
});

describe('serveDemoShop', () => {
  it('serves correct content types', async () => {
    expect((await get('/a/cart.html')).contentType).toBe('text/html; charset=utf-8');
    expect((await get('/shared/shop.css')).contentType).toBe('text/css; charset=utf-8');
  });

  it('sends the front door to variant A', async () => {
    const root = await get('/');
    expect(root.status).toBe(302);
    expect(root.location).toBe('/a/cart.html');
  });

  it('answers a missing file and a directory with 404', async () => {
    expect((await get('/a/nope.html')).status).toBe(404);
    expect((await get('/a')).status).toBe(404);
  });

  it('refuses a path that escapes the root', async () => {
    // A plain `../` never arrives: WHATWG URL parsing collapses it, and `%2e%2e` with it.
    // An encoded *slash* does survive that normalisation, so this is the vector the
    // server's own guard has to catch rather than inherit.
    expect((await get('/%2e%2e%2f%2e%2e%2fpackage.json')).status).toBe(403);
    expect((await get('/a%2f..%2f..%2fpackage.json')).status).toBe(403);
    expect((await get('/a/..%2f..%2fpnpm-workspace.yaml')).status).toBe(403);
  });

  it('answers a directory-shaped path with 404 rather than the page one level up', async () => {
    // `/a/cart.html/` would otherwise resolve to the cart page, whose relative links and
    // stylesheet would then all be one level too deep — a page that looks like a success
    // and cannot advance.
    expect((await get('/a/cart.html/')).status).toBe(404);
    expect((await get('/a/')).status).toBe(404);
  });

  it('serves only the shop, not the package around it', async () => {
    for (const path of ['/serve.ts', '/package.json', '/tsconfig.json', '/test/shop.test.ts']) {
      expect((await get(path)).status, `${path} is not part of the shop`).toBe(404);
    }
    // ...and the shop's own directories still answer.
    expect((await get('/a/cart.html')).status).toBe(200);
    expect((await get('/shared/shop.css')).status).toBe(200);
  });

  it('refuses a method other than GET or HEAD', async () => {
    expect((await get('/a/cart.html', { method: 'POST' })).status).toBe(405);
  });

  it('answers HEAD with the length it would have sent', async () => {
    const response = await fetch(`${shop.url}/a/cart.html`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(Number(response.headers.get('content-length'))).toBe(
      Buffer.byteLength(page('/a/cart.html')),
    );
  });

  it('takes a free port, and close() gives it back', async () => {
    const own = await serveDemoShop();
    expect(own.port).toBeGreaterThan(0);
    expect(own.url).toBe(`http://127.0.0.1:${own.port}`);
    expect((await fetch(`${own.url}/a/cart.html`)).status).toBe(200);

    const url = own.url;
    await own.close();
    await expect(fetch(`${url}/a/cart.html`)).rejects.toThrow();
  });

  it('brackets an IPv6 host so the origin it reports parses', async () => {
    const own = await serveDemoShop({ host: '::1' });
    try {
      expect(own.url).toBe(`http://[::1]:${own.port}`);
      // The point of the brackets: this throws on an unbracketed literal.
      expect((await fetch(`${own.url}/a/cart.html`)).status).toBe(200);
    } finally {
      await own.close();
    }
  });

  it('runs two instances side by side without colliding', async () => {
    const [one, two] = await Promise.all([serveDemoShop(), serveDemoShop()]);
    try {
      expect(one.port).not.toBe(two.port);
      const [first, second] = await Promise.all([
        fetch(`${one.url}/a/cart.html`),
        fetch(`${two.url}/a/cart.html`),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    } finally {
      await Promise.all([one.close(), two.close()]);
    }
  });

  it('accepts a stalled card frame, never answers it, and keeps serving', async () => {
    const stalled = fetch(`${shop.url}/shared/card-frame.html?stall=1`, {
      signal: AbortSignal.timeout(300),
    });
    await expect(stalled).rejects.toThrow();

    // Only `?stall=1` stalls, and the server is unharmed by having stalled.
    expect((await get('/shared/card-frame.html')).status).toBe(200);
    expect((await get('/shared/card-frame.html?stall=0')).status).toBe(200);
    expect((await get('/a/cart.html')).status).toBe(200);
  });

  it('closes while a request is stalled', async () => {
    const own = await serveDemoShop();
    const stalled = fetch(`${own.url}/shared/card-frame.html?stall=1`).catch(() => undefined);
    // Give the request time to reach the server, so close() really has a stall to destroy.
    await new Promise((resume) => setTimeout(resume, 100));

    await expect(own.close()).resolves.toBeUndefined();
    await stalled;
  });
});
