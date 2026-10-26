/**
 * The planted-defect ground truth: is it still true of the shop, and of the findings
 * package it is matched against?
 *
 * `defects.json` is the one file in the project that says which defects were planted on
 * purpose, so every number the demo reports about its own accuracy is computed against it.
 * That makes it the file with the most to lose from drift, and drift has exactly two
 * directions, one checked against each neighbour:
 *
 * 1. **Towards the findings package.** Every declared `ruleId` has to be a rule that still
 *    exists. Matching is by rule id, so a renamed rule does not report a different defect —
 *    it reports none, and recall falls to zero for a reason nothing on the screen explains.
 * 2. **Towards the shop.** Every declared region has to be a region the served variant-B
 *    page still carries. The pages are fetched from `serveDemoShop()` rather than read off
 *    disk or quoted from `demo/README.md`, because what a driver and a browser see is the
 *    served bytes and a ground truth should be checked against the same thing.
 *
 * The validation itself is tested on objects rather than on fixture files: every way of
 * being wrong gets a case, and each one asserts the JSON Pointer the error names, because
 * "defects.json is invalid" is not a message anyone can act on.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINDING_RULE_IDS, type PlantedDefect } from '@personavision/scoring';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DeclaredDefectsError,
  declaredDefects,
  loadDeclaredDefects,
  parseDeclaredDefects,
  shopRegionOf,
} from '../defects.ts';
import { serveDemoShop } from '../serve.ts';
import type { DemoShop } from '../serve.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** The page each step id is served at on variant B, as `demo/README.md` lists them. */
const PAGE_OF_STEP: Readonly<Record<string, string>> = {
  cart: '/b/cart.html',
  payment: '/b/payment.html',
  review: '/b/review.html',
  confirm: '/b/confirmation.html',
};

const ground = declaredDefects();

let shop: DemoShop;
const served = new Map<string, string>();

/** The served HTML of a page, fetched once in `beforeAll`. */
const page = (url: string): string => {
  const html = served.get(url);
  if (html === undefined) throw new Error(`${url} was not fetched`);
  return html;
};

const countOf = (html: string, region: string): number =>
  [...html.matchAll(/data-aoi="([^"]+)"/g)].filter((match) => match[1] === region).length;

/** A valid document, to be spoiled one field at a time. */
const valid = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL('../defects.json', import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

/** The `DeclaredDefectsError` a call throws, so a case can assert on its `path`. */
const refusalOf = (document: unknown): DeclaredDefectsError => {
  try {
    parseDeclaredDefects(document);
  } catch (error) {
    if (error instanceof DeclaredDefectsError) return error;
    throw error;
  }
  throw new Error('the document was accepted');
};

beforeAll(async () => {
  shop = await serveDemoShop();
  for (const url of Object.values(PAGE_OF_STEP)) {
    const response = await fetch(`${shop.url}${url}`, { redirect: 'manual' });
    expect(response.status, `${url} is served`).toBe(200);
    served.set(url, await response.text());
  }
});

afterAll(async () => {
  await shop.close();
});

/* ====================================================================== the test suite */

describe('the declared set', () => {
  it('holds exactly three entries, loaded through the typed loader', () => {
    expect(ground.defects).toHaveLength(3);
  });

  it('gives each one a stable, distinct id', () => {
    const ids = ground.defects.map((defect) => defect.id);
    expect(new Set(ids).size, `${ids.join(', ')} are distinct`).toBe(ids.length);
    expect(ids).toEqual(['D-1', 'D-2', 'D-3']);
  });

  it('names variant B on every entry and variant A on none of them', () => {
    for (const defect of ground.defects) {
      expect(defect.variant, `${defect.id} is on the redesign candidate`).toBe('B');
    }
    expect(ground.defects.filter((defect) => defect.variant === 'A')).toEqual([]);
  });

  it('describes each one in a sentence a person could read', () => {
    for (const defect of ground.defects) {
      expect(defect.description.length, `${defect.id} is described`).toBeGreaterThan(40);
      expect(defect.description.trimEnd(), `${defect.id} ends in a full stop`).toMatch(/\.$/);
    }
  });

  it('declares the three defects #10 names: the unseen action, the late fee and the banner', () => {
    expect(
      ground.defects.map((defect) => ({
        ruleId: defect.ruleId,
        step: defect.step,
        region: shopRegionOf(defect),
      })),
    ).toEqual([
      { ruleId: 'never-fixated-primary-action', step: 'review', region: 'complete' },
      { ruleId: 'value-changed-between-steps', step: 'review', region: 'fee-row' },
      { ruleId: 'competing-first-fixation', step: 'payment', region: 'promo' },
    ]);
  });
});

describe('every rule id is a rule the findings package still has', () => {
  it('matches the set the package exports, so a rename breaks here', () => {
    for (const defect of ground.defects) {
      expect(FINDING_RULE_IDS as readonly string[], `${defect.id}'s rule id`).toContain(
        defect.ruleId,
      );
    }
  });

  it('declares nothing against the informational note, which is attributed to automation', () => {
    // It is neither a hit nor a false positive, so a defect declared against it could
    // never be found: #10's comment from the scoring step says so outright.
    for (const defect of ground.defects) {
      expect(defect.ruleId).not.toBe('informational-note');
    }
  });

  it('refuses a rule id no rule carries, naming the entry', () => {
    const document = valid();
    const defects = document.defects as PlantedDefect[];
    document.defects = [
      { ...defects[0]!, ruleId: 'never-looked-at-the-button' },
      ...defects.slice(1),
    ];

    const error = refusalOf(document);
    expect(error.path).toBe('/defects/0/ruleId');
    expect(error.message).toContain('FINDING_RULE_IDS');
  });
});

describe('every declared defect is still in the shop', () => {
  it('serves a page for each declared step', () => {
    for (const defect of ground.defects) {
      expect(PAGE_OF_STEP[defect.step], `step "${defect.step}" of ${defect.id}`).toBeDefined();
    }
  });

  for (const defect of declaredDefects().defects) {
    it(`${defect.id}: ${defect.step} / ${shopRegionOf(defect)} is on the served variant-B page`, () => {
      const region = shopRegionOf(defect);
      expect(region).not.toBeNull();
      const url = PAGE_OF_STEP[defect.step]!;
      expect(countOf(page(url), region!), `data-aoi="${region}" on ${url}`).toBe(1);
    });
  }

  it('finds the undeclared mislabel in the shop too, on the step it is left out of', () => {
    // Left out of the declared set, but it has to exist: the prose below explains the cost
    // of not declaring it, and a cost paid for a defect the shop no longer has is nonsense.
    for (const undeclared of ground.notDeclared) {
      const url = PAGE_OF_STEP[undeclared.step]!;
      const prefix = `${undeclared.variant}-${undeclared.step}-`;
      expect(undeclared.aoiId, `${undeclared.what} names a region`).not.toBeNull();
      expect(
        undeclared.aoiId!.startsWith(prefix),
        `${undeclared.aoiId} is "${prefix}<data-aoi>"`,
      ).toBe(true);
      expect(countOf(page(url), undeclared.aoiId!.slice(prefix.length))).toBe(1);
    }
  });

  it('refuses an area id that is not in the artifact scheme', () => {
    const stray: PlantedDefect = { ...ground.defects[0]!, aoiId: 'complete' };
    expect(() => shopRegionOf(stray)).toThrow(DeclaredDefectsError);
    expect(() => shopRegionOf(stray)).toThrow(/B-review-/);
  });

  it('reads the whole step as the defect when there is no area', () => {
    expect(shopRegionOf({ ...ground.defects[0]!, aoiId: null })).toBeNull();
  });
});

describe('the file documents what it deliberately leaves out', () => {
  it('records the payment-step mislabel as a real defect that is not declared', () => {
    expect(ground.notDeclared).toHaveLength(1);
    const [mislabel] = ground.notDeclared;
    expect(mislabel!.step).toBe('payment');
    expect(mislabel!.what).toContain('Place order');
    expect(mislabel!.why.join(' ')).toContain('false positive');
  });

  it('states that precision is bounded below 1.0, and that the floor is measured', () => {
    const prose = ground.precision.join(' ');
    expect(prose).toContain('below 1.0');
    expect(prose).toContain('baseline');
    expect(prose).toMatch(/not a target/);
  });

  it('explains what the file is and how it is matched', () => {
    const prose = ground.about.join(' ');
    expect(prose).toContain('PlantedDefect');
    expect(prose).toContain('data-aoi');
  });

  it('refuses a file that has lost its prose', () => {
    expect(refusalOf({ ...valid(), precision: [] }).path).toBe('/precision');
    expect(refusalOf({ ...valid(), notDeclared: [] }).path).toBe('/notDeclared');
  });
});

describe('the loader names the offending path', () => {
  it('accepts the committed file', () => {
    expect(() => loadDeclaredDefects()).not.toThrow();
  });

  it('points at a missing field', () => {
    const document = valid();
    const defects = document.defects as Record<string, unknown>[];
    const withoutDescription = { ...defects[1]! };
    delete withoutDescription.description;
    document.defects = [defects[0], withoutDescription, defects[2]];
    expect(refusalOf(document).path).toBe('/defects/1/description');
  });

  it('points at a field the shape does not have, rather than ignoring it', () => {
    const document = valid();
    const defects = document.defects as PlantedDefect[];
    document.defects = [{ ...defects[0]!, aoiLabel: 'complete' }, ...defects.slice(1)];
    expect(refusalOf(document).path).toBe('/defects/0/aoiLabel');
  });

  it('points at a field of the wrong type', () => {
    const document = valid();
    const defects = document.defects as PlantedDefect[];
    document.defects = [defects[0], defects[1], { ...defects[2]!, step: 7 }];
    expect(refusalOf(document).path).toBe('/defects/2/step');
  });

  it('points at a repeated id', () => {
    const document = valid();
    const defects = document.defects as PlantedDefect[];
    document.defects = [defects[0], { ...defects[1]!, id: defects[0]!.id }, defects[2]];
    expect(refusalOf(document).path).toBe('/defects/1/id');
  });

  it('refuses a fourth entry: the planted set is three, and a fourth is a changed claim', () => {
    const document = valid();
    const defects = document.defects as PlantedDefect[];
    document.defects = [...defects, { ...defects[0]!, id: 'D-4' }];
    const error = refusalOf(document);
    expect(error.path).toBe('/defects');
    expect(error.message).toContain('4 entries');
  });

  it('refuses a document that is not an object at all', () => {
    expect(refusalOf([]).path).toBe('');
  });

  it('refuses a file that is not JSON, naming the file rather than the parser', () => {
    const notJson = new URL('../shared/shop.css', import.meta.url);
    expect(() => loadDeclaredDefects(notJson)).toThrow(DeclaredDefectsError);
    expect(() => loadDeclaredDefects(notJson)).toThrow(/is not JSON/);
  });
});

describe('nothing else parses the ground truth', () => {
  /** Every tracked `.ts`/`.tsx` file under the project's source directories. */
  const sources = (directory: string): string[] => {
    const entries = readdirSync(join(repoRoot, directory), { withFileTypes: true });
    return entries.flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return ['node_modules', 'dist'].includes(entry.name) ? [] : sources(path);
      }
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  };

  it('names `defects.json` in the loader and in this suite, and nowhere else', () => {
    const naming = ['apps', 'demo', 'packages', 'scripts', 'tests']
      .flatMap(sources)
      .filter((path) => readFileSync(join(repoRoot, path), 'utf8').includes('defects.json'));

    expect(naming.sort()).toEqual([
      'demo/northwind/defects.ts',
      'demo/northwind/test/defects.test.ts',
    ]);
  });
});
