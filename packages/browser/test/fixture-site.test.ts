/**
 * The fixture site, held to its own record.
 *
 * Six tickets of the browser-driving step assert against `fixtures/site/LANDMARKS.md`
 * instead of re-reading the pages: an id, a role, an accessible name, a box, a fold
 * position or a route is a stated fact there. That is only safe if the record and the
 * pages cannot drift apart, so this suite reads both and compares them — every documented
 * landmark against the served markup, every documented box against the geometry written on
 * the element, every documented route against what the server answers.
 *
 * Everything is asserted over the *served* bytes, through `serveFixtureSite()`, because
 * that is what Chromium will be given. Nothing here drives a browser: this step's
 * Playwright-based tests arrive with the module itself, and a broken fixture should be
 * caught before one is launched.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_SITE_DIR, serveFixtureSite } from './helpers/static-site.js';
import type { FixtureSite } from './helpers/static-site.js';

/* ------------------------------------------------------------------ the two viewports */

/** The fold at each of the two viewports `LANDMARKS.md` documents positions for. */
const FOLDS = { '390x844': 844, '1440x900': 900 } as const;

/** The two fold columns of a geometry table: `id | x | y | width | height | 390x844 | 1440x900`. */
const MOBILE_COLUMN = 5;
const DESKTOP_COLUMN = 6;

/** The primary-action column of a landmarks table, which holds `yes` for one row per step page. */
const PRIMARY_ACTION_COLUMN = 5;

/* -------------------------------------------------------------------- reading the doc */

const read = (name: string): string => readFileSync(join(FIXTURE_SITE_DIR, name), 'utf8');

const LANDMARKS = read('LANDMARKS.md');
const FIXTURE_CSS = read('fixture.css');

/** A cell whose value is "nothing": the document writes an em dash rather than leaving it blank. */
const NONE = '—';

const isRuleRow = (cells: readonly string[]): boolean =>
  cells.every((cell) => /^:?-{2,}:?$/.test(cell));

/**
 * Every markdown table in the document, keyed by the headings above it — `"Pages"`, or
 * `"Page: cart.html > Geometry"`. Rows are trimmed cells with the header and the rule row
 * dropped, so a column that prettier has padded reads the same as one it has not.
 */
const docTables = (markdown: string): Map<string, string[][]> => {
  const tables = new Map<string, string[][]>();
  let section = '';
  let subsection = '';
  for (const line of markdown.split('\n')) {
    const heading = /^(#{2,3})\s+(.+)$/.exec(line);
    if (heading !== null) {
      if (heading[1] === '##') {
        section = heading[2].trim();
        subsection = '';
      } else {
        subsection = heading[2].trim();
      }
      continue;
    }
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (isRuleRow(cells)) continue;
    const key = subsection === '' ? section : `${section} > ${subsection}`;
    const rows = tables.get(key);
    if (rows === undefined) {
      // The first row of a table is its header, which names columns rather than values.
      tables.set(key, []);
    } else {
      rows.push(cells);
    }
  }
  return tables;
};

const TABLES = docTables(LANDMARKS);

const table = (key: string): string[][] => {
  const rows = TABLES.get(key);
  if (rows === undefined) throw new Error(`LANDMARKS.md has no "${key}" table`);
  return rows;
};

/** The text inside backticks, for the columns that quote an id, a page or a route. */
const unquote = (cell: string): string => cell.replace(/^`(.*)`$/, '$1');

interface StepRule {
  readonly id: string;
  readonly urlPattern: string;
  readonly requiredSelector: string;
  readonly primaryAction: string;
}

/** The task definition the document states, read from its JSON block so a test can run it. */
const stepRules = (): StepRule[] => {
  const section = LANDMARKS.split('\n## ').find((part) => part.startsWith('Step match rules'));
  if (section === undefined) throw new Error('LANDMARKS.md has no "Step match rules" section');
  const fence = /```json\n([\s\S]*?)```/.exec(section);
  if (fence === null) throw new Error('"Step match rules" has no JSON block');
  return JSON.parse(fence[1]) as StepRule[];
};

const STEP_RULES = stepRules();

/** The pages the document lists, with the step each one is (or `null`), and its height. */
const PAGES = table('Pages').map(([page, url, step, height]) => ({
  file: unquote(page),
  url: unquote(url),
  step: step === 'none' ? null : unquote(step),
  height: Number(height),
}));

const STEP_PAGES = PAGES.filter((page) => page.step !== null);

/* ------------------------------------------------------------------- reading the pages */

const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const ENTITIES: Readonly<Record<string, string>> = {
  '&nbsp;': ' ',
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
};

/** The words a reader sees, flattened, so an assertion does not depend on where tags fall. */
const visibleText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();

const ATTRIBUTE = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const parseAttributes = (raw: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const [, name, doubleQuoted, singleQuoted, bare] = match;
    attributes[name.toLowerCase()] = doubleQuoted ?? singleQuoted ?? bare ?? '';
  }
  return attributes;
};

interface ServedElement {
  readonly id: string;
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  /** Visible text, whitespace collapsed; empty for a void or empty element. */
  readonly text: string;
  /** The ids of the elements this one sits inside, innermost first. */
  readonly ancestors: readonly string[];
}

interface OpenElement {
  readonly tag: string;
  readonly id: string | null;
  readonly attributes: Readonly<Record<string, string>>;
  readonly ancestors: readonly string[];
  readonly contentStart: number;
}

/**
 * Every element with an id, by id. The ancestor chain is kept because a landmark's
 * page-space box is the sum of the `left` and `top` values along it: an absolutely
 * positioned child is placed against its nearest positioned ancestor, and on these pages
 * that is either another landmark or the document.
 */
const parsePage = (html: string): Map<string, ServedElement> => {
  const elements = new Map<string, ServedElement>();
  const open: OpenElement[] = [];
  const chain = (): string[] =>
    open.flatMap((frame) => (frame.id === null ? [] : [frame.id])).reverse();

  const close = (frame: OpenElement, contentEnd: number): void => {
    if (frame.id === null) return;
    elements.set(frame.id, {
      id: frame.id,
      tag: frame.tag,
      attributes: frame.attributes,
      text: visibleText(html.slice(frame.contentStart, contentEnd)),
      ancestors: frame.ancestors,
    });
  };

  const pattern = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    const [, closing, rawTag, rawAttributes] = match;
    const tag = rawTag.toLowerCase();

    if (closing === '/') {
      // Pop to the matching tag. These pages close everything they open, so this is a
      // single step in practice; the loop keeps a stray tag from shifting every ancestor
      // chain after it.
      while (open.length > 0) {
        const frame = open.pop();
        if (frame === undefined) break;
        close(frame, match.index);
        if (frame.tag === tag) break;
      }
      continue;
    }

    const attributes = parseAttributes(rawAttributes);
    const id = attributes.id ?? null;
    if (VOID_ELEMENTS.has(tag) || rawAttributes.trimEnd().endsWith('/')) {
      if (id !== null) {
        elements.set(id, { id, tag, attributes, text: '', ancestors: chain() });
      }
      continue;
    }
    open.push({ tag, id, attributes, ancestors: chain(), contentStart: pattern.lastIndex });
  }
  return elements;
};

/** The accessible name a `<label for>` gives a field, by the id it points at. */
const labelsByField = (html: string): Map<string, string> => {
  const labels = new Map<string, string>();
  for (const [, field, content] of html.matchAll(
    /<label\b[^>]*\bfor="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g,
  )) {
    labels.set(field, visibleText(content));
  }
  return labels;
};

const pixels = (style: string, property: string): number | null => {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(-?\\d+)px`).exec(style);
  return match === null ? null : Number(match[1]);
};

/** A landmark's own `left`, `top`, `width` and `height`, as written on the element. */
const ownBox = (element: ServedElement): Record<'left' | 'top' | 'width' | 'height', number> => {
  const style = element.attributes.style ?? '';
  const box = { left: 0, top: 0, width: 0, height: 0 };
  for (const property of ['left', 'top', 'width', 'height'] as const) {
    const value = pixels(style, property);
    expect(value, `#${element.id} states its ${property}`).not.toBeNull();
    box[property] = value ?? 0;
  }
  return box;
};

/** The role the markup gives an element, by the rules `LANDMARKS.md` documents roles under. */
const roleOf = (element: ServedElement): string => {
  const explicit = element.attributes.role;
  if (explicit !== undefined) return explicit;
  switch (element.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
      return 'heading';
    case 'p':
      return 'paragraph';
    case 'img':
      return 'img';
    case 'a':
      return element.attributes.href === undefined ? 'generic' : 'link';
    case 'button':
      return 'button';
    case 'input':
      return element.attributes.type === 'text' ? 'textbox' : 'generic';
    case 'select':
      return 'combobox';
    case 'form':
      return element.attributes['aria-label'] === undefined ? 'generic' : 'form';
    case 'section':
      return element.attributes['aria-label'] === undefined ? 'generic' : 'region';
    case 'iframe':
      return 'iframe';
    default:
      return 'generic';
  }
};

/** Roles whose accessible name comes from the element's own content. */
const NAMED_BY_CONTENT: ReadonlySet<string> = new Set(['heading', 'link', 'button']);

const accessibleNameOf = (
  element: ServedElement,
  role: string,
  labels: Map<string, string>,
): string => {
  const ariaLabel = element.attributes['aria-label'];
  if (ariaLabel !== undefined) return ariaLabel;
  if (role === 'img') return element.attributes.alt ?? '';
  if (role === 'iframe') return element.attributes.title ?? '';
  if (role === 'textbox' || role === 'combobox') return labels.get(element.id) ?? '';
  if (NAMED_BY_CONTENT.has(role)) return element.text;
  return '';
};

/** The height `fixture.css` gives a page, which is what a full-page screenshot is tall. */
const styledPageHeight = (file: string): number | null => {
  const pageClass = `page-${file.replace(/\.html$/, '')}`;
  const match = new RegExp(`body\\.${pageClass}\\s*\\{[^}]*height:\\s*(\\d+)px`).exec(FIXTURE_CSS);
  return match === null ? null : Number(match[1]);
};

/* ----------------------------------------------------------------------------- the site */

let site: FixtureSite;
/** Each page's served HTML and the elements parsed out of it, by file name. */
const served = new Map<string, { html: string; elements: Map<string, ServedElement> }>();

beforeAll(async () => {
  site = await serveFixtureSite();
  for (const page of PAGES) {
    const response = await fetch(`${site.url}${page.url}`);
    expect(response.status, `${page.url} is served`).toBe(200);
    const html = await response.text();
    served.set(page.file, { html, elements: parsePage(html) });
  }
});

afterAll(async () => {
  await site.close();
});

const pageOf = (file: string): { html: string; elements: Map<string, ServedElement> } => {
  const page = served.get(file);
  if (page === undefined) throw new Error(`${file} was not served`);
  return page;
};

/* ----------------------------------------------------------------------------- the server */

describe('serveFixtureSite', () => {
  it('answers every documented route with its documented status and content type', async () => {
    for (const [route, method, status, contentType] of table('Server routes')) {
      const path = unquote(route);
      if (path === '/slow') continue; // its own test: it never answers at all.
      const response = await fetch(`${site.url}${path}`, {
        method: unquote(method),
        redirect: 'manual',
      });
      expect(response.status, `${method} ${path}`).toBe(Number(status));
      if (contentType !== NONE) {
        expect(response.headers.get('content-type'), `content type of ${path}`).toBe(
          unquote(contentType),
        );
      }
      if (response.status === 302) {
        expect(response.headers.get('location'), `where ${path} redirects`).toBe('/cart.html');
      }
      await response.arrayBuffer();
    }
  });

  it('takes a free port, and two sites run side by side without colliding', async () => {
    const second = await serveFixtureSite();
    try {
      expect(second.port).not.toBe(site.port);
      expect(second.url).not.toBe(site.url);
      for (const origin of [site.url, second.url]) {
        const response = await fetch(`${origin}/cart.html`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('id="cart-items"');
      }
    } finally {
      await second.close();
    }
  });

  it('releases its port on close, even with a request still held by /slow', async () => {
    const closing = await serveFixtureSite();
    const port = closing.port;

    // Held open on purpose and never awaited: `/slow` writes no response, so this promise
    // only settles when the connection is destroyed.
    const stalled = fetch(`${closing.url}/slow`).catch(() => 'destroyed');
    await new Promise((settle) => setTimeout(settle, 50));

    await expect(closing.close()).resolves.toBeUndefined();
    await expect(stalled).resolves.toBe('destroyed');
    await expect(fetch(`http://127.0.0.1:${port}/cart.html`)).rejects.toThrow();

    // The port is free, not merely unanswered: a second site can bind it by number.
    const rebound = await serveFixtureSite({ port });
    try {
      expect(rebound.port).toBe(port);
    } finally {
      await rebound.close();
    }
  });

  it('accepts /slow and never answers, and serves the site afterwards', async () => {
    await expect(fetch(`${site.url}/slow`, { signal: AbortSignal.timeout(300) })).rejects.toThrow();

    const after = await fetch(`${site.url}/cart.html`);
    expect(after.status).toBe(200);
    await after.arrayBuffer();
  });

  it('refuses a path that escapes the site directory once it is decoded', async () => {
    for (const path of ['/%2e%2e%2fpackage.json', '/assets/%2e%2e%2f%2e%2e%2ftsconfig.json']) {
      const response = await fetch(`${site.url}${path}`);
      expect(response.status, path).toBe(403);
      await response.arrayBuffer();
    }
  });
});

/* -------------------------------------------------------------------- the pages' landmarks */

describe('the fixture pages', () => {
  it('is as tall as fixture.css makes each page', () => {
    for (const page of PAGES) {
      expect(styledPageHeight(page.file), `the styled height of ${page.file}`).toBe(page.height);
    }
  });

  it('documents every id on every page, and every documented id is on its page', () => {
    for (const page of PAGES) {
      const documented = table(`Page: ${page.file} > Landmarks`).map(([id]) => unquote(id));
      const present = [...pageOf(page.file).elements.keys()];
      expect(new Set(documented), `ids documented for ${page.file}`).toEqual(new Set(present));
      expect(documented.length, `no id documented twice for ${page.file}`).toBe(
        new Set(documented).size,
      );
    }
  });

  it('serves each landmark with the element, role, accessible name and text documented', () => {
    for (const page of PAGES) {
      const { html, elements } = pageOf(page.file);
      const labels = labelsByField(html);
      for (const row of table(`Page: ${page.file} > Landmarks`)) {
        const [id, tag, role, name, text] = row.map(unquote);
        const element = elements.get(id);
        expect(element, `#${id} is on ${page.file}`).toBeDefined();
        if (element === undefined) continue;

        expect(element.tag, `the element of #${id}`).toBe(tag);
        expect(roleOf(element), `the role of #${id}`).toBe(role);
        expect(accessibleNameOf(element, roleOf(element), labels), `the name of #${id}`).toBe(
          name === NONE ? '' : name,
        );
        if (text !== NONE) {
          expect(element.text, `the visible text of #${id}`).toBe(text);
        }
      }
    }
  });

  it('places each landmark at its documented box, the same at both viewports', () => {
    for (const page of PAGES) {
      const { elements } = pageOf(page.file);
      for (const row of table(`Page: ${page.file} > Geometry`)) {
        const id = unquote(row[0]);
        const [x, y, width, height] = row.slice(1, 5).map(Number);
        const element = elements.get(id);
        expect(element, `#${id} is on ${page.file}`).toBeDefined();
        if (element === undefined) continue;

        // Page space: a landmark inside another is placed against it, so its page-space
        // box is the sum of the chain. Nothing in that sum depends on the viewport.
        const own = ownBox(element);
        let pageX = own.left;
        let pageY = own.top;
        for (const ancestorId of element.ancestors) {
          const ancestor = elements.get(ancestorId);
          expect(ancestor, `#${ancestorId}, which #${id} sits inside`).toBeDefined();
          if (ancestor === undefined) continue;
          const box = ownBox(ancestor);
          pageX += box.left;
          pageY += box.top;
        }

        expect(
          { x: pageX, y: pageY, width: own.width, height: own.height },
          `the box of #${id}`,
        ).toEqual({ x, y, width, height });

        // The two fold columns are the record of `belowFold`, which is `y >= foldY`.
        expect(row[MOBILE_COLUMN], `#${id} at 390x844`).toBe(
          pageY >= FOLDS['390x844'] ? 'below' : 'above',
        );
        expect(row[DESKTOP_COLUMN], `#${id} at 1440x900`).toBe(
          pageY >= FOLDS['1440x900'] ? 'below' : 'above',
        );
        expect(pageY + own.height, `#${id} fits in the page`).toBeLessThanOrEqual(page.height);
      }
    }
  });

  it('has a control that is below the fold on mobile and above it on desktop', () => {
    const crossing = PAGES.flatMap((page) =>
      table(`Page: ${page.file} > Geometry`).filter(
        (row) => row[MOBILE_COLUMN] === 'below' && row[DESKTOP_COLUMN] === 'above',
      ),
    );
    expect(crossing.length, 'landmarks that change side with the viewport').toBeGreaterThan(0);
    for (const row of crossing) {
      const y = Number(row[2]);
      expect(y).toBeGreaterThanOrEqual(FOLDS['390x844']);
      expect(y).toBeLessThan(FOLDS['1440x900']);
    }
  });

  it('has two controls with the same words in different places', () => {
    const byText = new Map<string, string[]>();
    for (const row of table('Page: cart.html > Landmarks')) {
      const [id, , role, , text] = row.map(unquote);
      if (text === NONE || !NAMED_BY_CONTENT.has(role)) continue;
      byText.set(text, [...(byText.get(text) ?? []), id]);
    }
    const twins = [...byText.values()].filter((ids) => ids.length > 1);
    expect(twins.length, 'controls on cart.html that read the same').toBeGreaterThan(0);

    const { elements } = pageOf('cart.html');
    for (const ids of twins) {
      expect(new Set(ids).size, 'same words, different ids').toBe(ids.length);
      const boxes = ids.map((id) => {
        const served = elements.get(id);
        return served === undefined ? '' : JSON.stringify(ownBox(served));
      });
      expect(new Set(boxes).size, 'same words, different places').toBe(ids.length);
    }
  });

  it('has a control whose accessible name comes only from aria-label', () => {
    const { html, elements } = pageOf('cart.html');
    const labels = labelsByField(html);
    const ariaOnly = [...elements.values()].filter((element) => {
      const role = roleOf(element);
      if (!NAMED_BY_CONTENT.has(role)) return false;
      const name = accessibleNameOf(element, role, labels);
      return element.attributes['aria-label'] !== undefined && name !== element.text;
    });
    expect(ariaOnly.length, 'controls named only by aria-label').toBeGreaterThan(0);
    for (const control of ariaOnly) {
      expect(control.text, `the visible text of #${control.id}`).not.toBe('');
      expect(control.attributes['aria-label']).not.toBe(control.text);
    }
  });

  it('labels the payment page text input and select, and gives the select options', () => {
    const { html, elements } = pageOf('payment.html');
    const labels = labelsByField(html);

    const input = elements.get('payment-card-number');
    expect(input?.tag).toBe('input');
    expect(input?.attributes.type).toBe('text');
    expect(labels.get('payment-card-number')).toBe('Card number');

    const select = elements.get('payment-expiry-month');
    expect(select?.tag).toBe('select');
    expect(labels.get('payment-expiry-month')).toBe('Expiry month');
    expect(html.match(/<option\b/g)?.length ?? 0).toBeGreaterThan(1);
  });

  it('leaves the card and the banner unexplained by the DOM', () => {
    const { elements } = pageOf('cart.html');
    for (const id of ['cart-banner', 'cart-upsell-card']) {
      const region = elements.get(id);
      expect(region, `#${id} is on cart.html`).toBeDefined();
      expect(region?.text, `#${id} says nothing`).toBe('');
      expect(region?.attributes['aria-label'], `#${id} is not named`).toBeUndefined();
      expect(region?.attributes.role, `#${id} has no role of its own`).toBeUndefined();
      if (region !== undefined) {
        expect(roleOf(region), `the role of #${id}`).toBe('generic');
      }
    }
  });

  it('references two frame sources that cannot load', () => {
    const { elements } = pageOf('broken-frame.html');
    const stalled = elements.get('broken-frame-stalled');
    const unresolvable = elements.get('broken-frame-unresolvable');
    expect(
      stalled?.attributes.src,
      'the stalled frame points at the route that never answers',
    ).toBe('/slow');
    expect(
      unresolvable?.attributes.src,
      'the other frame points at a host that cannot resolve',
    ).toMatch(/^https?:\/\/[^/]+\.invalid\//);
  });
});

/* --------------------------------------------------------------- the task these pages are */

describe('the step match rules', () => {
  it('declares one rule per step page, in the order the pages are reached', () => {
    expect(STEP_RULES.map((rule) => rule.id)).toEqual(STEP_PAGES.map((page) => page.step));
  });

  it('matches each step page with its own rule, and requires an element that is there', () => {
    for (const rule of STEP_RULES) {
      const page = STEP_PAGES.find((candidate) => candidate.step === rule.id);
      expect(page, `a page for step ${rule.id}`).toBeDefined();
      if (page === undefined) continue;

      const pattern = new RegExp(rule.urlPattern);
      expect(pattern.test(page.url), `${rule.urlPattern} matches ${page.url}`).toBe(true);

      const required = rule.requiredSelector.replace(/^#/, '');
      expect(
        pageOf(page.file).elements.has(required),
        `${rule.requiredSelector} is on ${page.file}`,
      ).toBe(true);

      const primary = rule.primaryAction.replace(/^#/, '');
      expect(
        pageOf(page.file).elements.has(primary),
        `${rule.primaryAction} is on ${page.file}`,
      ).toBe(true);

      // A pattern anchored at its end would stop matching the review page the moment the
      // payment form submits a value into the URL.
      expect(
        pattern.test(`${page.url}?card=4242&expiry=01`),
        `${rule.urlPattern} survives a query`,
      ).toBe(true);
    }
  });

  it('marks exactly one primary action per step page, the one the rule declares', () => {
    for (const page of STEP_PAGES) {
      const marked = table(`Page: ${page.file} > Landmarks`)
        .filter((row) => row[PRIMARY_ACTION_COLUMN] === 'yes')
        .map((row) => unquote(row[0]));
      expect(marked.length, `primary actions documented on ${page.file}`).toBe(1);
      const rule = STEP_RULES.find((candidate) => candidate.id === page.step);
      expect(`#${marked[0]}`, `the primary action of ${page.step}`).toBe(rule?.primaryAction);
    }
  });

  it('leaves no-control.html on no step: its URL matches, its required element does not exist', () => {
    const noControl = PAGES.find((page) => page.file === 'no-control.html');
    expect(noControl, 'no-control.html is documented').toBeDefined();
    if (noControl === undefined) return;

    const matching = STEP_RULES.filter((rule) => new RegExp(rule.urlPattern).test(noControl.url));
    expect(
      matching.map((rule) => rule.id),
      'the steps whose URL pattern it matches',
    ).toEqual(['payment']);

    const { elements } = pageOf('no-control.html');
    for (const rule of STEP_RULES) {
      expect(
        elements.has(rule.requiredSelector.replace(/^#/, '')),
        `${rule.requiredSelector} is absent from no-control.html`,
      ).toBe(false);
    }
    // Not an empty page: a detector cannot get this right by finding nothing at all.
    expect(elements.size, 'no-control.html is an ordinary page').toBeGreaterThan(2);
  });

  it('is walkable in order, with no script on any page', () => {
    const hrefOf = (file: string, id: string): string | undefined =>
      pageOf(file).elements.get(id)?.attributes.href;

    expect(hrefOf('cart.html', 'cart-checkout')).toBe('payment.html');
    const form = pageOf('payment.html').elements.get('payment-form');
    expect(form?.attributes.action).toBe('review.html');
    expect(form?.attributes.method).toBe('get');
    expect(hrefOf('review.html', 'review-place-order')).toBe('confirmation.html');
    expect(hrefOf('confirmation.html', 'confirmation-continue-shopping')).toBe('cart.html');

    // The review page's way back to the previous step.
    expect(hrefOf('review.html', 'review-back')).toBe('payment.html');

    for (const page of PAGES) {
      expect(pageOf(page.file).html, `${page.file} carries no script`).not.toMatch(/<script/i);
    }
  });
});
