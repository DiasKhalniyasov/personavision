#!/usr/bin/env node

/**
 * The `personavision` executable.
 *
 * Placeholder: `open`, `run` and `validate` are built by this step's CLI ticket. Until then
 * every invocation fails loudly rather than pretending to have done something.
 */

const requested = process.argv.slice(2).join(' ');

process.stderr.write(
  [
    `personavision: not implemented yet${requested === '' ? '' : ` (asked for: ${requested})`}.`,
    'The commands open, run and validate arrive in the CLI ticket of the',
    '"Run artifact contract and app skeleton" step. See CONTEXT.md for the module map.',
    '',
  ].join('\n'),
);

process.exit(1);
