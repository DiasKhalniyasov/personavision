/**
 * Reading a stylesheet back through the CSSOM, for the suites that assert the part of a
 * screen contract that is CSS.
 *
 * jsdom applies no stylesheet of its own, so a media query, a column count and a border
 * colour are not reachable through a rendered component. A suite puts its screen's CSS
 * module in the document instead and reads the rules out of it.
 *
 * `tests/audience/stylesheet.test.ts` (#109) wrote this first, inside itself, and set the
 * pattern; this is the same reader with a home of its own, so the next screen's suite adds
 * assertions rather than a second copy of the reader. That suite can move onto this when
 * something next touches it.
 */

export interface Rule {
  readonly selector: string;
  /** The media query the rule sits in, or `''` for a rule at the top level. */
  readonly condition: string;
  readonly declarations: Record<string, string>;
}

const declarationsOf = (rule: CSSStyleRule): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: rule.style.length }, (_unused, index) => rule.style.item(index)).map(
      (property) => [property, rule.style.getPropertyValue(property)],
    ),
  );

/** Every style rule of a stylesheet, flattened, each carrying the query it sits in. */
export function rulesOf(css: string): Rule[] {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const sheet = style.sheet as CSSStyleSheet;

  return [...sheet.cssRules].flatMap((rule) => {
    if (rule instanceof CSSMediaRule) {
      return [...rule.cssRules].map((inner) => ({
        selector: (inner as CSSStyleRule).selectorText,
        condition: rule.conditionText,
        declarations: declarationsOf(inner as CSSStyleRule),
      }));
    }
    if (rule instanceof CSSStyleRule) {
      return [{ selector: rule.selectorText, condition: '', declarations: declarationsOf(rule) }];
    }
    return [];
  });
}

/** The selectors of one rule, in the order they are written, however they are spaced. */
const selectorsOf = (rule: Rule): string[] =>
  rule.selector.split(',').map((selector) => selector.trim());

/**
 * One rule's declarations, by the selectors it is written for and the query it sits in.
 * Exactly one rule must match, so a stylesheet that grew a second one is a failure rather
 * than a silent first answer.
 */
export const ruleIn =
  (rules: readonly Rule[]) =>
  (selectors: string | string[], condition = ''): Record<string, string> => {
    const wanted = typeof selectors === 'string' ? [selectors] : selectors;
    const found = rules.filter(
      (item) =>
        item.condition === condition &&
        selectorsOf(item).length === wanted.length &&
        selectorsOf(item).every((selector, index) => selector === wanted[index]),
    );
    if (found.length !== 1) {
      throw new Error(
        `${wanted.join(', ')} ${condition}: expected one rule, found ${String(found.length)}`,
      );
    }
    return (found[0] as Rule).declarations;
  };
