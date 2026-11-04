import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../src/cli-error.js';
import {
  DERIVED_STEP_ID,
  DERIVED_STEP_LABEL,
  readTaskSteps,
  stepsOf,
  taskFor,
} from '../src/run/task.js';
import type { TaskStep } from '@personavision/browser';
import type { RunRequest } from '@personavision/contract';

/**
 * The task the swarm is handed, built from what the command was given.
 *
 * Most of this suite is about the **derived** task — the one step a test of a single URL
 * gets, which stands for the whole site. It declares no primary action, and that is the
 * point (#418): nobody designed a control on the site under test, so there is none to name,
 * and `packages/browser`'s resolution marks nothing rather than refusing the screen.
 *
 * A task that declares its own steps is the other half and is asserted to be untouched: the
 * demo, `--steps` files and `tests/acceptance/` all name their real controls, and a step
 * that names one keeps every rule it had.
 */

const REQUEST: RunRequest = {
  task: { prompt: 'See what people make of the pricing page' },
  variants: [{ id: 'A', name: 'Today', url: 'https://example.com/pricing' }],
  audienceId: 'shoppers',
  repeats: 1,
  seed: 7,
  engineMode: 'offline',
};

/** A step that names its control, as `demo/northwind/demo.config.ts` and `--steps` do. */
const DECLARED: TaskStep = {
  id: 'cart',
  label: 'Cart',
  match: { urlPattern: '/cart', requiredSelector: '#cart-items' },
  primaryAction: { selector: '#cart-checkout' },
};

describe('the one step a derived task declares', () => {
  const derived = (request: RunRequest = REQUEST): TaskStep => {
    const [step, ...rest] = taskFor(request, null).steps;
    expect(rest, 'a derived task declares one step').toEqual([]);
    if (step === undefined) throw new Error('a derived task declares one step');
    return step;
  };

  it('declares no primary action at all', () => {
    expect(derived().primaryAction).toBeUndefined();
    expect('primaryAction' in derived()).toBe(false);
  });

  it('is otherwise the page: its id, its label, its path and a body', () => {
    expect(derived()).toStrictEqual({
      id: DERIVED_STEP_ID,
      label: DERIVED_STEP_LABEL,
      match: { urlPattern: '/pricing', requiredSelector: 'body' },
    });
  });

  it('still matches both versions of a two-version test', () => {
    const twoVersions: RunRequest = {
      ...REQUEST,
      variants: [
        { id: 'A', name: 'Today', url: 'https://example.com/pricing' },
        { id: 'B', name: 'The change', url: 'https://example.com/pricing-new' },
      ],
    };

    expect(new RegExp(derived(twoVersions).match.urlPattern).test('/pricing-new')).toBe(true);
    expect(new RegExp(derived(twoVersions).match.urlPattern).test('/pricing')).toBe(true);
  });

  it('is listed in the artifact by its id and label, which carry no control either', () => {
    expect(stepsOf(taskFor(REQUEST, null))).toEqual([
      { id: DERIVED_STEP_ID, label: DERIVED_STEP_LABEL },
    ]);
  });
});

describe('a task that declares its own steps', () => {
  it('keeps the control each step names, untouched', () => {
    expect(taskFor(REQUEST, [DECLARED]).steps).toStrictEqual([DECLARED]);
  });

  it('keeps an optional control optional, which is a different thing from declaring none', () => {
    const optional: TaskStep = {
      ...DECLARED,
      primaryAction: { selector: '#cart-checkout', optional: true },
    };

    expect(taskFor(REQUEST, [optional]).steps[0]?.primaryAction).toEqual({
      selector: '#cart-checkout',
      optional: true,
    });
  });
});

describe('a --steps file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personavision-steps-file-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const wrote = async (steps: unknown): Promise<string> => {
    const file = join(dir, 'steps.json');
    await writeFile(file, JSON.stringify(steps), 'utf8');
    return file;
  };

  const bare = {
    id: 'page',
    label: 'The page',
    match: { urlPattern: '/', requiredSelector: 'body' },
  };

  it('may omit the primary action, which declares a step that is a whole page', async () => {
    expect(await readTaskSteps(await wrote([bare]))).toStrictEqual([bare]);
  });

  it('still reads one that names a control, with its optional flag', async () => {
    const named = { ...bare, primaryAction: { selector: '#go', optional: true } };

    expect(await readTaskSteps(await wrote([named]))).toStrictEqual([named]);
  });

  it('still refuses a primary action that is declared and empty', async () => {
    const empty = { ...bare, primaryAction: { selector: '' } };

    await expect(readTaskSteps(await wrote([empty]))).rejects.toBeInstanceOf(CliError);
  });

  it('still refuses a step missing something it must declare', async () => {
    const noLabel = { id: 'page', match: { urlPattern: '/', requiredSelector: 'body' } };

    await expect(readTaskSteps(await wrote([noLabel]))).rejects.toBeInstanceOf(CliError);
  });
});

describe('the four-selector stand-in', () => {
  it('is spelled nowhere in the repository, doc comments and markdown included', async () => {
    // The acceptance criterion, as a test. The stand-in was the one place a derived step's
    // primary action came from, and a second spelling of it anywhere is a second place a
    // screen could be refused for a control nobody declared (#418). Comments and prose are
    // read too: a paragraph that still quotes it is a paragraph that says the product does
    // something it no longer does.
    const root = join(import.meta.dirname, '..', '..', '..');
    const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', 'build', 'runs']);
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/\.(ts|tsx|md|json)$/.test(entry.name)) files.push(path);
      }
    };
    // Every directory the project's own code and prose live in.
    for (const where of ['packages', 'apps', 'demo', 'scripts', 'tests', 'docs', 'tools']) {
      await walk(join(root, where));
    }

    /**
     * The four kinds of control it listed, in one selector, however it is spaced or quoted.
     * A file that names one of them on its own — `a[href]`, a real task's `#checkout` — does
     * not match: it is the list of all four that was the stand-in.
     */
    const STAND_IN =
      /button\s*,\s*input\[type\s*=\s*['"]?submit['"]?\]\s*,\s*a\[href\]\s*,\s*\[role\s*=\s*['"]?button['"]?\]/;

    const spelling = await Promise.all(
      files.map(async (file) => ({
        file: relative(root, file),
        found: STAND_IN.test(await readFile(file, 'utf8')),
      })),
    );

    expect(spelling.filter((entry) => entry.found).map((entry) => entry.file)).toEqual([]);
  });
});
