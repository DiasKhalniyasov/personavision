/**
 * The candidate elements of a page: interactive controls and meaningful text blocks, read
 * from the DOM **and** from Chromium's accessibility tree, each with a stable id, a role,
 * an accessible name, its text, its page-space box and whether it sits below the fold.
 *
 * This is what makes attention attributable: `run.json`'s `aois` entries with
 * `source: "dom"` and `source: "a11y"` are these elements, and every area-of-interest
 * metric is keyed on the ids minted here.
 *
 * **Two sources, on purpose.** The DOM pass reads what the markup says — a tag's implied
 * role and the text the element itself holds. The accessibility pass reads what Chromium
 * computed — the role and the accessible name a screen reader would announce, which is
 * where a `<label for>`, an `aria-label` and an `alt` have already been resolved. They
 * disagree, and that disagreement is information: the fixture site's `cart-save-tote` reads
 * `Save` and is named `Save the canvas tote for later`. Neither source is dropped, and an
 * element never appears twice from the same source.
 *
 * **Page space.** Every box is the element's client rect plus the current scroll offset, so
 * it is in the document's coordinates and not the viewport's: an overlay registers to a
 * full-page screenshot whatever the page was scrolled to when the element was read.
 *
 * **The fold is read, never recomputed.** `belowFold` is `isBelowFold(bbox, geometry)` with
 * the geometry handed in, so one rule holds everywhere (`geometry.ts`).
 *
 * `isPrimaryAction` is left `false` here. The task declares its primary action by selector
 * and `resolvePrimaryAction` sets the flag on the element it resolves to.
 */

/// <reference lib="dom" />
// The callbacks below run inside the page, not in Node: this module needs the DOM types,
// and the reference travels with the file (see `geometry.ts`).
import { isBelowFold } from '../geometry.js';
import type { Box, CaptureElement, Geometry, PageHandle } from '../types.js';
import { stableElementId } from './stable-id.js';
import type { CDPSession, Page } from 'playwright';

export type ExtractElements = (
  page: PageHandle,
  geometry: Geometry,
  step: string | null,
) => Promise<CaptureElement[]>;

/** One element, as the page describes it. Both passes go through the same description. */
interface PageElement {
  tag: string;
  /** The chain of child indexes from the root: the element's position in the document. */
  path: string;
  selector: string;
  /** The ARIA role the markup implies — what the DOM alone can say. */
  role: string | null;
  /** What the DOM alone can read as a name: an `alt`, otherwise the element's own text. */
  name: string | null;
  /** The text the element itself holds, not its descendants'. */
  text: string | null;
  /** A box with a painted background and no text of its own: a banner, or a card. */
  painted: boolean;
  bbox: Box;
}

declare global {
  interface Window {
    /**
     * Installed on the page for the length of one extraction, so that the DOM pass and the
     * accessibility pass describe an element the same way. The accessibility pass reaches
     * its nodes over the DevTools protocol, which hands back a remote object rather than
     * anything a selector could find, so it calls this on each of them.
     */
    __personavisionDescribeElement?: (element: Element) => PageElement | null;
  }
}

/**
 * What the DOM pass looks at: every interactive control, every element that carries a role
 * or is focusable, the text-bearing elements of a page, and the plain boxes — `div` and
 * `span` — which are kept only when they hold text of their own or are painted regions.
 */
const CANDIDATE_SELECTOR = [
  'a',
  'button',
  'summary',
  'input',
  'select',
  'textarea',
  '[role]',
  '[tabindex]',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'label',
  'li',
  'img',
  'iframe',
  'section',
  'form',
  'main',
  'nav',
  'header',
  'footer',
  'aside',
  'article',
  'div',
  'span',
].join(', ');

/**
 * How large a wordless painted box has to be to be a candidate, in square CSS pixels.
 *
 * A banner and a card are regions the DOM cannot explain — no text, no role, no name — and
 * a candidate for one can state its box and nothing else, which is the hand-off
 * segmentation fills in with `source: "sam"` (`docs/adr/0002-…`). The threshold is what
 * keeps a one-pixel spacer out; it is a heuristic, and a page of small painted chips is the
 * case it will read as background.
 */
const MIN_PAINTED_REGION_AREA = 1_000;

/**
 * Accessibility-tree roles that are not candidates: the document itself, and the text nodes
 * underneath an element that is already one. A `StaticText` under a button is the button's
 * name, not a second area of interest.
 */
const SKIPPED_AX_ROLES: ReadonlySet<string> = new Set([
  'RootWebArea',
  'StaticText',
  'InlineTextBox',
  'LineBreak',
  'ListMarker',
  'none',
  'presentation',
]);

/**
 * Chromium's spellings, as ARIA spells them. `fixtures/site/LANDMARKS.md`'s role table
 * records the two that differ, and the roles this module reports are the ARIA names, so a
 * role means the same thing whichever source produced it.
 */
const ARIA_ROLE_BY_AX_ROLE: Readonly<Record<string, string>> = {
  image: 'img',
  Iframe: 'iframe',
};

/** Collapses whitespace; an empty name is `null`, which is what an unnamed element has. */
const collapse = (value: string | null | undefined): string | null => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
};

/** Installs the describer the two passes share. Removed again when extraction is done. */
const installDescriber = async (page: Page): Promise<void> => {
  await page.evaluate((minPaintedRegionArea: number) => {
    const normalise = (value: string | null | undefined): string | null => {
      const text = (value ?? '').replace(/\s+/g, ' ').trim();
      return text.length > 0 ? text : null;
    };

    /** The element's own words. A container's text belongs to the children that hold it. */
    const ownText = (element: Element): string | null =>
      normalise(
        Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? '')
          .join(' '),
      );

    const ROLE_BY_TAG: Record<string, string> = {
      article: 'article',
      aside: 'complementary',
      button: 'button',
      footer: 'contentinfo',
      form: 'form',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      header: 'banner',
      iframe: 'iframe',
      img: 'img',
      li: 'listitem',
      main: 'main',
      nav: 'navigation',
      ol: 'list',
      p: 'paragraph',
      summary: 'button',
      textarea: 'textbox',
      ul: 'list',
    };

    const ROLE_BY_INPUT_TYPE: Record<string, string> = {
      button: 'button',
      checkbox: 'checkbox',
      image: 'button',
      number: 'spinbutton',
      radio: 'radio',
      range: 'slider',
      reset: 'button',
      submit: 'button',
    };

    /** The role the markup implies. An explicit `role` wins, as it does in the browser. */
    const roleOf = (element: Element): string | null => {
      const declared = normalise(element.getAttribute('role'));
      if (declared !== null) {
        return declared.split(' ')[0] ?? null;
      }

      const tag = element.tagName.toLowerCase();
      if (tag === 'a') {
        return element.hasAttribute('href') ? 'link' : 'generic';
      }
      if (tag === 'input') {
        const type = (element as HTMLInputElement).type.toLowerCase();
        if (type === 'hidden') {
          return null;
        }
        return ROLE_BY_INPUT_TYPE[type] ?? 'textbox';
      }
      if (tag === 'select') {
        const select = element as HTMLSelectElement;
        return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
      }
      if (tag === 'section') {
        // A sectioning element is a landmark once it is named, and a plain box until then.
        const named =
          element.hasAttribute('aria-label') ||
          element.hasAttribute('aria-labelledby') ||
          element.hasAttribute('title');
        return named ? 'region' : 'generic';
      }
      return ROLE_BY_TAG[tag] ?? 'generic';
    };

    const documentPath = (element: Element): string => {
      const indexes: number[] = [];
      for (let node: Element | null = element; node?.parentElement; node = node.parentElement) {
        indexes.unshift(Array.from(node.parentElement.children).indexOf(node));
      }
      return indexes.join('/');
    };

    /** A selector that resolves to this element and to nothing else, or `null`. */
    const selectorFor = (element: Element): string | null => {
      const byId = element.id.length > 0 ? `#${CSS.escape(element.id)}` : null;
      if (byId !== null && document.querySelectorAll(byId).length === 1) {
        return byId;
      }

      const steps: string[] = [];
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const parent = node.parentElement;
        const tag = node.tagName.toLowerCase();
        steps.unshift(
          parent === null
            ? tag
            : `${tag}:nth-child(${Array.from(parent.children).indexOf(node) + 1})`,
        );
      }
      const path = steps.join(' > ');
      return document.querySelectorAll(path).length === 1 ? path : null;
    };

    window.__personavisionDescribeElement = (element: Element) => {
      // Only a node of this document can carry a selector that resolves to it, which rules
      // out what lives in a shadow root — the editor Chromium puts inside a text input is
      // a node of the accessibility tree and of no selector.
      if (!(element instanceof Element) || element.getRootNode() !== document) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      const style = window.getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') {
        return null;
      }

      const selector = selectorFor(element);
      if (selector === null) {
        return null;
      }

      const text = ownText(element);
      const transparent =
        style.backgroundColor === 'transparent' || style.backgroundColor === 'rgba(0, 0, 0, 0)';

      return {
        tag: element.tagName.toLowerCase(),
        path: documentPath(element),
        selector,
        role: roleOf(element),
        name: normalise(element.getAttribute('alt')) ?? text,
        text,
        painted:
          text === null &&
          rect.width * rect.height >= minPaintedRegionArea &&
          (style.backgroundImage !== 'none' || !transparent),
        bbox: {
          // Page space: the client rect is relative to the viewport, the scroll offset puts
          // it back in the document.
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
        },
      };
    };
  }, MIN_PAINTED_REGION_AREA);
};

/** The DOM pass, in document order. */
const describeDomCandidates = async (page: Page): Promise<PageElement[]> =>
  page.evaluate((selector: string) => {
    const describe = window.__personavisionDescribeElement;
    if (describe === undefined) {
      return [];
    }

    const described: PageElement[] = [];
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const candidate = describe(element);
      if (candidate === null) {
        continue;
      }

      // A plain box is a candidate only when it holds words of its own or is a painted
      // region; otherwise it is the scaffolding around the elements that already are.
      const plain =
        (candidate.tag === 'div' ||
          candidate.tag === 'span' ||
          (candidate.tag === 'a' && !element.hasAttribute('href'))) &&
        !element.hasAttribute('role') &&
        !element.hasAttribute('tabindex');
      if (plain && candidate.text === null && !candidate.painted) {
        continue;
      }

      described.push(candidate);
    }
    return described;
  }, CANDIDATE_SELECTOR);

/** One accessibility-tree node that has a box on the page. */
interface A11yCandidate {
  role: string;
  name: string | null;
  element: PageElement;
}

/** Describes the DOM node an accessibility-tree node was computed from. */
const describeBackendNode = async (
  cdp: CDPSession,
  backendNodeId: number,
): Promise<PageElement | null> => {
  const resolved = await cdp.send('DOM.resolveNode', { backendNodeId });
  const objectId = resolved.object.objectId;
  if (objectId === undefined) {
    return null;
  }

  try {
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        'function () { return window.__personavisionDescribeElement ? window.__personavisionDescribeElement(this) : null; }',
      returnByValue: true,
    });
    return (result.value as PageElement | null) ?? null;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId });
  }
};

/**
 * The accessibility pass: Chromium's own tree, over the DevTools protocol.
 *
 * The tree is read rather than recomputed, because the accessible name of a control is the
 * browser's answer and not a rule this module could restate — `aria-label`,
 * `aria-labelledby`, a `<label for>`, an `alt` and the text of a button all resolve in it
 * already. The roles come back in Chromium's spelling and are reported in ARIA's.
 */
const describeA11yCandidates = async (handle: PageHandle): Promise<A11yCandidate[]> => {
  const cdp = await handle.context.newCDPSession(handle.page);
  try {
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');

    const candidates: A11yCandidate[] = [];
    for (const node of nodes) {
      if (node.ignored || node.backendDOMNodeId === undefined) {
        continue;
      }
      const axRole = node.role?.value;
      if (typeof axRole !== 'string' || SKIPPED_AX_ROLES.has(axRole)) {
        continue;
      }

      const element = await describeBackendNode(cdp, node.backendDOMNodeId);
      // The document and its body are the page, not areas of it.
      if (element === null || element.tag === 'html' || element.tag === 'body') {
        continue;
      }

      const name = node.name?.value;
      candidates.push({
        role: ARIA_ROLE_BY_AX_ROLE[axRole] ?? axRole,
        name: collapse(typeof name === 'string' ? name : null),
        element,
      });
    }
    return candidates;
  } finally {
    await cdp.detach();
  }
};

export const extractElements: ExtractElements = async (page, geometry, step) => {
  await installDescriber(page.page);

  try {
    const dom = await describeDomCandidates(page.page);
    const a11y = await describeA11yCandidates(page);

    const elements: CaptureElement[] = [];
    const taken = new Set<string>();
    const describedPaths: Record<CaptureElement['source'], Set<string>> = {
      dom: new Set(),
      a11y: new Set(),
    };

    const add = (
      source: CaptureElement['source'],
      role: string | null,
      name: string | null,
      element: PageElement,
    ): void => {
      // One entry per element per source: an element the accessibility tree reports twice
      // — a control and its own grouping — is one area of interest, not two.
      if (describedPaths[source].has(element.path)) {
        return;
      }
      describedPaths[source].add(element.path);

      let ordinal = 0;
      let id = stableElementId({
        variant: page.variant.id,
        step,
        source,
        role,
        name,
        path: element.path,
        ordinal,
      });
      while (taken.has(id)) {
        ordinal += 1;
        id = stableElementId({
          variant: page.variant.id,
          step,
          source,
          role,
          name,
          path: element.path,
          ordinal,
        });
      }
      taken.add(id);

      elements.push({
        id,
        source,
        role,
        name,
        text: element.text,
        bbox: element.bbox,
        isPrimaryAction: false,
        belowFold: isBelowFold(element.bbox, geometry),
        selector: element.selector,
      });
    };

    for (const element of dom) {
      add('dom', element.role, element.name, element);
    }
    for (const candidate of a11y) {
      add('a11y', candidate.role, candidate.name, candidate.element);
    }

    return elements;
  } finally {
    // The describer belongs to this extraction. It dies with the page in any case, so a
    // page that has gone away before it could be removed is not a failure of extraction.
    await page.page
      .evaluate(() => {
        delete window.__personavisionDescribeElement;
      })
      .catch(() => undefined);
  }
};
