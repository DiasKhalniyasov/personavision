import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attributionWords, outcomeWords } from '../../src/session';
import type { OutcomeStatus } from '../../src/session';
import {
  durationSeconds,
  tagClass,
  variantTagClass,
  whereItEnded,
} from '../../src/screens/sessions/rows';

/**
 * The three rules for putting a row's stored values on screen.
 *
 * The chip rule is the one worth a test of its own: the colour of an outcome comes from the
 * token the vocabulary names, through the one class in `src/styles/base.css` that declares
 * that token — so there is no second list of statuses on this screen to fall out of step,
 * and the four outcomes a row can carry cannot collapse into fewer than four colours.
 */

const baseCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../src/styles/base.css'),
  'utf8',
);

/** The properties one class of `base.css` declares. */
const declarations = (className: string): string => {
  const rule = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`).exec(baseCss);
  expect(rule, `base.css declares .${className}`).not.toBeNull();
  return (rule as RegExpExecArray)[1] as string;
};

const OUTCOMES: OutcomeStatus[] = ['success', 'abandoned', 'failed', 'automation_failure'];

describe('the chip carrying an outcome or an attribution', () => {
  it('takes its colour from the token the vocabulary names, for all four outcomes', () => {
    for (const status of OUTCOMES) {
      const { token, backgroundToken } = outcomeWords(status);
      const declared = declarations(tagClass(token));

      expect(declared, status).toContain(`var(${token})`);
      expect(declared, status).toContain(`var(${backgroundToken})`);
    }
  });

  it('keeps the four outcomes four colours, so none is folded into another', () => {
    const classes = OUTCOMES.map((status) => tagClass(outcomeWords(status).token));

    // An automation failure borrows the attribution token, which is the one the tokens
    // file declares for it — and it is still not any of the three product outcomes.
    expect(new Set(classes).size).toBe(4);
    expect(classes).toEqual(['tag-success', 'tag-abandoned', 'tag-failed', 'tag-automation']);
  });

  it('does the same for the two attributions and the two versions', () => {
    for (const attribution of ['product', 'automation'] as const) {
      const { token } = attributionWords(attribution);
      expect(declarations(tagClass(token)), attribution).toContain(`var(${token})`);
    }
    expect(declarations(variantTagClass('A'))).toContain('var(--variant-a)');
    expect(declarations(variantTagClass('B'))).toContain('var(--variant-b)');
  });

  it('reads a third version as information rather than as a chip with no colour', () => {
    // A version id is any name in the contract, and the tokens colour only two of them.
    expect(variantTagClass('control')).toBe('tag-info');
    expect(declarations('tag-info')).toContain('var(--sev-info)');
  });
});

describe('where a session ended', () => {
  it('names the step and the reason', () => {
    expect(whereItEnded({ step: 'confirm', label: 'Confirmation' }, 'Order placed')).toBe(
      'Confirmation — Order placed',
    );
  });

  it('does not say the step twice when the pipeline’s reason already opens with it', () => {
    expect(
      whereItEnded(
        { step: 'payment', label: 'Payment' },
        'Payment — selector timeout on the card iframe',
      ),
    ).toBe('Payment — selector timeout on the card iframe');
  });

  it('still names the step when the reason merely opens with its letters', () => {
    // "Review" is a prefix of "Reviewed", and dropping the step there would leave the one
    // column headed "Where it ended" not saying where.
    expect(whereItEnded({ step: 'review', label: 'Review' }, 'Reviewed the fees and left')).toBe(
      'Review — Reviewed the fees and left',
    );
  });

  it('falls back to the step’s id when the run never planned that step', () => {
    expect(whereItEnded({ step: 'help', label: null }, 'Left from the help page')).toBe(
      'help — Left from the help page',
    );
  });
});

describe('a duration', () => {
  it('reads in seconds to one decimal, as every duration in the product does', () => {
    expect(durationSeconds(38_000)).toBe('38.0 s');
    expect(durationSeconds(22_400)).toBe('22.4 s');
  });
});
