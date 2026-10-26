import axe from 'axe-core';
import type { AxeResults, ElementContext, RunOptions } from 'axe-core';

/**
 * An axe pass over a rendered screen, for the tests that ask for one.
 *
 * jsdom lays nothing out, so the rules that need geometry or a painted colour cannot be
 * decided there. They are disabled by name rather than left to report nothing, so a reader
 * of a failure knows the pass covered structure and naming — roles, labels, names, heading
 * order, table headers, duplicate ids, landmark nesting — and not contrast or target size.
 * The visual half of accessibility is the design tokens' job and `tokens.css` carries it.
 */
const UNDECIDABLE_IN_JSDOM: readonly string[] = [
  'color-contrast',
  'target-size',
  'scrollable-region-focusable',
];

export async function axePass(
  context: ElementContext = document.body,
  options: RunOptions = {},
): Promise<AxeResults> {
  return axe.run(context, {
    ...options,
    rules: {
      ...Object.fromEntries(UNDECIDABLE_IN_JSDOM.map((id) => [id, { enabled: false }])),
      ...options.rules,
    },
  });
}

export async function axeViolations(
  context: ElementContext = document.body,
  options: RunOptions = {},
): Promise<AxeResults['violations']> {
  return (await axePass(context, options)).violations;
}

/** What a failing axe pass should print: the rule, the help text and the nodes. */
export const describeViolations = (violations: AxeResults['violations']): string =>
  violations
    .map(
      (violation) =>
        `${violation.id}: ${violation.help}\n  ${violation.nodes
          .map((node) => node.html)
          .join('\n  ')}`,
    )
    .join('\n');
