import { runSchema, verdictSchema, type Audience } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { acceptanceThresholds, bandOf, bandsDisjoint } from '../src/bands.js';
import { findings, score, verdict, type VariantScore } from '../src/index.js';
import {
  buildFixtureRun,
  fixtureAoiMetrics,
  fixtureAois,
  fixtureSessions,
  fixtureTask,
} from './fixtures/index.js';

/**
 * **The project's one hard pass-or-fail criterion** (`docs/FLOW.md` section 5).
 *
 * The clean checkout scores at or under 25, the one carrying the three planted defects at
 * or over 60, the gap is at least 30 points, the ± 1σ bands do not overlap and they agreed
 * across at least three seed groups; and the figures the product leads with separate too —
 * at least 0.6 of the clean variant's scored sessions finished the task, at most 0.3 of the
 * defective one's, and the variant to ship is the clean one.
 *
 * It is measured end to end over the sessions #26 committed: the real `score()`, the real
 * `findings()` and the real `verdict()` over what both return. A build that cannot separate
 * the two by this margin has not worked, whatever the individual subsystems do, and this
 * test is where that is said: it is part of `pnpm test`, so it fails CI when it fails.
 *
 * What is asserted about the words is only what **this** ticket decides — which findings
 * become the headline, which of them become the reasons and which area the hero evidence
 * points at. The wording of a claim is #28's and is held to the contract in
 * `test/findings.test.ts`; repeating it here would make one edit fail in two places.
 *
 * The thresholds are `acceptanceThresholds`, which mirrors `docs/design/tokens.css` — the
 * one place in this package that writes them down.
 */

const AUDIENCE: Audience = {
  id: 'outdoor-gear-shoppers',
  name: 'Outdoor-gear shoppers',
  ageRange: { min: 25, max: 45 },
  roles: ['shopper'],
  regions: ['United Kingdom'],
  goals: ['Buy a tent'],
  devices: [
    {
      name: 'Desktop 1280',
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      touch: false,
      share: 1,
    },
  ],
  techSavviness: 0.5,
  priceSensitivity: 0.7,
  size: 4,
  generatedFrom: { seed: 1, generatorVersion: 'fixture-1' },
};

const scores = score(fixtureSessions, fixtureAois, fixtureAoiMetrics, fixtureTask);
const runFindings = findings(fixtureSessions, fixtureAois, fixtureAoiMetrics, scores);
const written = verdict(scores, runFindings, AUDIENCE);

const forVariant = (variant: string): VariantScore => {
  const found = scores.find((candidate) => candidate.variant === variant);
  if (found === undefined) throw new Error(`the fixture run has no score for variant ${variant}`);
  return found;
};

const clean = forVariant('A');
const defective = forVariant('B');

describe('the acceptance table of docs/FLOW.md section 5, over the committed fixtures', () => {
  it('scores the clean checkout at or under its threshold', () => {
    expect(clean.frictionScore.median).toBeLessThanOrEqual(
      acceptanceThresholds.frictionCleanAtMost,
    );
  });

  it('scores the checkout with the three planted defects at or over its threshold', () => {
    expect(defective.frictionScore.median).toBeGreaterThanOrEqual(
      acceptanceThresholds.frictionDefectiveAtLeast,
    );
  });

  it('separates the two by at least the required gap, and names the harder one', () => {
    expect(written.harderVariant).toBe('B');
    expect(written.gapPoints).toBeGreaterThanOrEqual(acceptanceThresholds.gapPointsAtLeast);
    expect(written.gapPoints).toBeCloseTo(
      defective.frictionScore.median - clean.frictionScore.median,
      12,
    );
  });

  it('reports ± 1σ bands that do not overlap', () => {
    expect(written.bandsDisjoint).toBe(true);
    expect(bandsDisjoint(bandOf(clean), bandOf(defective))).toBe(true);
    expect(bandOf(clean).high).toBeLessThan(bandOf(defective).low);
  });

  it('holds across at least three seed groups, measured group by group', () => {
    expect(written.seedGroupsAgreeing).toBeGreaterThanOrEqual(
      acceptanceThresholds.seedGroupsAgreeingAtLeast,
    );
    expect(clean.perSeedGroup.length).toBeGreaterThanOrEqual(
      acceptanceThresholds.seedGroupsAgreeingAtLeast,
    );
    expect(defective.perSeedGroup.length).toBeGreaterThanOrEqual(
      acceptanceThresholds.seedGroupsAgreeingAtLeast,
    );
  });

  it('completes on the clean checkout and not on the defective one', () => {
    expect(clean.completionRate).toBeGreaterThanOrEqual(
      acceptanceThresholds.completionCleanAtLeast,
    );
    expect(defective.completionRate).toBeLessThanOrEqual(
      acceptanceThresholds.completionDefectiveAtMost,
    );
  });

  it('ships the clean checkout', () => {
    expect(written.preferredVariant).toBe('A');
  });
});

describe('what the gate hands to the screens', () => {
  it('states the result in the verdict line, with the gap and the seed groups in it', () => {
    expect(written.sentence).toBe(
      'Variant B is harder by 42.5 points. The gap held in all 3 seed groups (A 19–25, B 60–69 — the bands do not overlap).',
    );
  });

  it('leads with one sentence in the audience’s own words', () => {
    expect(written.audienceSentence).toBe('Outdoor-gear shoppers buy a tent on A, not on B.');
  });

  it('names the three findings the generator ranked highest, as its own ids', () => {
    expect(written.headlineFindingIds).toEqual([
      'never-fixated-primary-action@B',
      'competing-first-fixation@A',
      'competing-first-fixation@B',
    ]);
    const ids = new Set(runFindings.map((finding) => finding.id));
    for (const id of written.headlineFindingIds) expect(ids.has(id)).toBe(true);
  });

  it('leads with two reasons, both of them about the version it is not shipping', () => {
    const headline = runFindings.filter((finding) =>
      written.headlineFindingIds.includes(finding.id),
    );
    expect(written.reasons).toHaveLength(2);

    for (const reason of written.reasons) {
      // The reason is the claim's own leading clause, so a headline finding's claim starts
      // with it — the words on the lead screen and the words in the findings list are one.
      const source = headline.find((finding) =>
        finding.claim.startsWith(reason.replace(/\.$/, '')),
      );
      expect(source, `no headline finding produced "${reason}"`).toBeDefined();
      expect(source?.variant).toBe('B');
      expect(source?.attribution).toBe('product');
    }
  });

  it('points the one heatmap at the area the verdict turns on', () => {
    expect(written.heroEvidence).toEqual({
      variant: 'B',
      step: 'review',
      aoiId: 'b-review-place-order',
    });
    const area = fixtureAois.find((aoi) => aoi.id === written.heroEvidence.aoiId);
    expect(area?.variant).toBe(written.heroEvidence.variant);
    expect(area?.step).toBe(written.heroEvidence.step);
  });

  it('is a verdict the artifact contract accepts, inside the run it was measured on', () => {
    expect(verdictSchema.parse(written)).toEqual(written);
    expect(() => runSchema.parse(buildFixtureRun(scores, written))).not.toThrow();
  });
});
