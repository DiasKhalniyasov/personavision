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
 *
 * The variant in an element's id is the session's — `page.variant.id`, the variant the page
 * was opened under — because that is what this seam is given. A caller that captured one
 * open session under some other variant label would disagree with it, which is a reason not
 * to do that rather than a reason for this seam to take a fourth argument.
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
  'table',
  'caption',
  'th',
  'td',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'figure',
  'figcaption',
  'pre',
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
 * Chromium's spellings, as ARIA spells them, so that a role from the accessibility pass
 * means what the same role from the DOM pass means. `fixtures/site/LANDMARKS.md`'s role
 * table records the two that differ on those pages; the rest are the Chromium names that
 * have an ARIA equivalent at all.
 *
 * A Chromium role with no ARIA name — `MenuListPopup`, `Video`, `Legend` — is reported as
 * Chromium spells it. Inventing an ARIA name for it would be worse than passing the
 * browser's own answer through, and a consumer that filters on ARIA roles sees it is not
 * one of them.
 */
const ARIA_ROLE_BY_AX_ROLE: Readonly<Record<string, string>> = {
  DescriptionList: 'list',
  DescriptionListDetail: 'definition',
  DescriptionListTerm: 'term',
  DisclosureTriangle: 'button',
  Figcaption: 'caption',
  Iframe: 'iframe',
  SvgRoot: 'graphics-document',
  image: 'img',
};

/**
 * Collapses whitespace; an empty name is `null`, which is what an unnamed element has.
 *
 * The describer has its own copy of this, because code that runs in the page cannot close
 * over anything in this module.
 */
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
      blockquote: 'blockquote',
      button: 'button',
      caption: 'caption',
      dd: 'definition',
      dl: 'list',
      dt: 'term',
      figure: 'figure',
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
      table: 'table',
      td: 'cell',
      textarea: 'textbox',
      th: 'columnheader',
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

    /** A selector that resolves to this element and to nothing else. */
    const selectorFor = (element: Element): string => {
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
      // A chain of `nth-child` steps from the root matches one node by construction, so
      // it needs no verifying query — and a query per element is the cost that grows with
      // the size of the document.
      return steps.join(' > ');
    };

    /** `transparent`, or `rgba(…, 0)` in any colour: a background that paints nothing. */
    const paintsNothing = (colour: string): boolean => {
      if (colour === 'transparent') {
        return true;
      }
      const alpha = /^rgba?\([^)]*,\s*([\d.]+)\s*\)$/.exec(colour)?.[1];
      return alpha !== undefined && Number(alpha) === 0;
    };

    window.__personavisionDescribeElement = (element: Element) => {
      // Only a node of this document can carry a selector that resolves to it, which rules
      // out what lives in a shadow root — the editor Chromium puts inside a text input is
      // a node of the accessibility tree and of no selector.
      if (!(element instanceof Element) || element.getRootNode() !== document) {
        return null;
      }

      const tag = element.tagName.toLowerCase();
      // The document and its body are the page, not areas of it. A `<body tabindex="-1">`
      // — the ordinary focus-management pattern — would otherwise be a page-sized
      // candidate that every fixation falls inside.
      if (tag === 'html' || tag === 'body') {
        return null;
      }

      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      // Laid out is not the same as visible: an `opacity: 0` block and the contents of a
      // collapsed `<details>` both have boxes, and neither can be looked at. The browser
      // already knows which is which, so it is asked rather than second-guessed.
      if (
        !element.checkVisibility({
          contentVisibilityAuto: true,
          opacityProperty: true,
          visibilityProperty: true,
        })
      ) {
        return null;
      }

      const style = window.getComputedStyle(element);
      const text = ownText(element);
      const role = roleOf(element);
      const painted =
        text === null &&
        rect.width * rect.height >= minPaintedRegionArea &&
        (style.backgroundImage !== 'none' || !paintsNothing(style.backgroundColor));

      // What makes an element a candidate, for both passes: it says something of its own,
      // it *is* something — a control or a landmark rather than a plain box — or it is a
      // painted region, which is the hand-off segmentation fills in. A wrapper that is
      // none of the three is the scaffolding around the elements that already are.
      if (
        text === null &&
        (role === null || role === 'generic') &&
        !painted &&
        !element.hasAttribute('tabindex')
      ) {
        return null;
      }

      // A fixed element is anchored to the viewport rather than to the document: it paints
      // where it sits whatever the scroll, and a screenshot of this project is taken at
      // scroll 0, so its client rect already is its page-space box. Adding the scroll
      // offset would walk it down the page by however far the session had scrolled.
      //
      // A `position: sticky` element is the case this does not cover: its box is a
      // document box until it sticks and a viewport box after, and which it is cannot be
      // read off the element. It is reported as a document box here.
      const anchoredToViewport = style.position === 'fixed';

      return {
        tag,
        path: documentPath(element),
        selector: selectorFor(element),
        role,
        name: normalise(element.getAttribute('alt')) ?? text,
        text,
        painted,
        bbox: {
          // Page space: the client rect is relative to the viewport, the scroll offset puts
          // it back in the document.
          x: rect.x + (anchoredToViewport ? 0 : window.scrollX),
          y: rect.y + (anchoredToViewport ? 0 : window.scrollY),
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
      // The describer was installed moments ago, so it is gone only because the page is:
      // it navigated out from under this extraction. That is a failure of our own browsing
      // and is raised as one, rather than recorded as a screen with nothing on it.
      throw new Error('element extraction: the page navigated away mid-extraction');
    }

    const described: PageElement[] = [];
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const candidate = describe(element);
      if (candidate !== null) {
        described.push(candidate);
      }
    }
    return described;
  }, CANDIDATE_SELECTOR);

/** One accessibility-tree node that has a box on the page. */
interface A11yCandidate {
  role: string;
  name: string | null;
  element: PageElement;
}

/** The object group every node resolved for one extraction belongs to. */
const AX_OBJECT_GROUP = 'personavision-extract';

/**
 * Describes the DOM node an accessibility-tree node was computed from.
 *
 * The tree is one snapshot and its nodes are read one at a time afterwards, so a page that
 * changes in between — a carousel, a lazily loaded image, a toast that fades — can have
 * dropped a node before it is reached. That node is no longer on the screen and is skipped;
 * it is not a reason to fail the capture of everything else.
 */
const describeBackendNode = async (
  cdp: CDPSession,
  backendNodeId: number,
): Promise<PageElement | null> => {
  try {
    const resolved = await cdp.send('DOM.resolveNode', {
      backendNodeId,
      objectGroup: AX_OBJECT_GROUP,
    });
    const objectId = resolved.object.objectId;
    if (objectId === undefined) {
      return null;
    }

    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        'function () { return window.__personavisionDescribeElement ? window.__personavisionDescribeElement(this) : null; }',
      returnByValue: true,
    });
    return (result.value as PageElement | null) ?? null;
  } catch {
    return null;
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
      if (element === null) {
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
    // Both at once: the handles taken for the nodes above, and the session that took them.
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: AX_OBJECT_GROUP }).catch(() => {});
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
