import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultEngineConfig, resolveEngineConfig, resolveFrom } from '../src/config.js';
import type { EngineConfigOverrides } from '../src/config.js';

/** Every leaf of the configuration object, as `group.subgroup.key`, sorted. */
const leafKeys = (value: unknown, prefix = ''): string[] => {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => leafKeys(child, prefix === '' ? key : `${prefix}.${key}`))
    .sort();
};

/**
 * The calibration step (#11) fits this object, and the nine tickets after #56 read their
 * numbers from it, so the set of leaves is a published contract: a leaf added or renamed
 * without saying so on the step issue fails here rather than silently leaving a number
 * out of calibration's reach.
 */
const EXPECTED_LEAF_KEYS = [
  'alpha',
  'beta',
  'fixationDuration.logSigma',
  'fixationDuration.maxMs',
  'fixationDuration.medianMs',
  'fixationDuration.minMs',
  'fixationsPerScreen.logSigma',
  'fixationsPerScreen.max',
  'fixationsPerScreen.mean',
  'fixationsPerScreen.min',
  'gamma',
  'inhibitionOfReturn.decayPerFixation',
  'inhibitionOfReturn.deliberateReturnAfterFixations',
  'inhibitionOfReturn.deliberateReturnRelevance',
  'inhibitionOfReturn.immediateRepeatAllowance',
  'inhibitionOfReturn.penalty',
  'interFixation.gapMs',
  'interFixation.gapSigmaMs',
  'interFixation.minGapMs',
  'landing.minInsetPx',
  'landing.spreadShare',
  'persona.dwellScale.atOne',
  'persona.dwellScale.atZero',
  'persona.fixationCountScale.atOne',
  'persona.fixationCountScale.atZero',
  'persona.fixationDurationScale.atOne',
  'persona.fixationDurationScale.atZero',
  'persona.rolePriorScale.atOne',
  'persona.rolePriorScale.atZero',
  'persona.screenPersistenceScale.atOne',
  'persona.screenPersistenceScale.atZero',
  'persona.verificationScale.atOne',
  'persona.verificationScale.atZero',
  'prediction.map.cellPx',
  'prediction.map.dwellWeightExponent',
  'prediction.map.kernelRadiusSigmas',
  'prediction.map.kernelSigmaShare',
  'prediction.neutralTrait',
  'prediction.priorGridCellsAcross',
  'relevance.floor',
  'relevance.goalVerbRoleWeights.compare.control',
  'relevance.goalVerbRoleWeights.compare.prose',
  'relevance.goalVerbRoleWeights.compare.value',
  'relevance.goalVerbRoleWeights.complete.control',
  'relevance.goalVerbRoleWeights.complete.prose',
  'relevance.goalVerbRoleWeights.complete.value',
  'relevance.goalVerbRoleWeights.find.control',
  'relevance.goalVerbRoleWeights.find.prose',
  'relevance.goalVerbRoleWeights.find.value',
  'relevance.goalVerbRoleWeights.other.control',
  'relevance.goalVerbRoleWeights.other.prose',
  'relevance.goalVerbRoleWeights.other.value',
  'relevance.hintWeight',
  'relevance.nameMatchWeight',
  'relevance.roleWeight',
  'relevance.textMatchWeight',
  'saccade.amplitude.logSigma',
  'saccade.amplitude.medianPx',
  'saccade.duration.baseMs',
  'saccade.duration.maxMs',
  'saccade.duration.minMs',
  'saccade.duration.msPerPixel',
  'salience.rolePriors.button',
  'salience.rolePriors.checkbox',
  'salience.rolePriors.combobox',
  'salience.rolePriors.control',
  'salience.rolePriors.heading',
  'salience.rolePriors.img',
  'salience.rolePriors.link',
  'salience.rolePriors.menuitem',
  'salience.rolePriors.option',
  'salience.rolePriors.other',
  'salience.rolePriors.radio',
  'salience.rolePriors.searchbox',
  'salience.rolePriors.slider',
  'salience.rolePriors.switch',
  'salience.rolePriors.tab',
  'salience.rolePriors.text',
  'salience.rolePriors.textbox',
  'salience.surround.minRingPx',
  'salience.surround.ringShare',
  'salience.weights.centreBias',
  'salience.weights.colourContrast',
  'salience.weights.luminanceContrast',
  'salience.weights.relativeArea',
  'salience.weights.rolePrior',
  'salience.weights.topBias',
  'segmentation.background.bucketLevels',
  'segmentation.background.colourDistance',
  'segmentation.background.luminanceDistance',
  'segmentation.cellPx',
  'segmentation.maxRegions',
  'segmentation.minAreaShare',
  'segmentation.minAspectRatio',
  'segmentation.minRectangularity',
  'segmentation.minSidePx',
  'segmentation.similarity.colourDistance',
  'segmentation.similarity.luminanceDistance',
].sort();

describe('the configuration object', () => {
  it('reaches every weight, distribution parameter and prior the engine uses', () => {
    expect(leafKeys(defaultEngineConfig)).toEqual(EXPECTED_LEAF_KEYS);
  });

  it('holds only numbers at its leaves, so calibration can fit all of them', () => {
    const leaves = (value: unknown): unknown[] =>
      typeof value === 'object' && value !== null
        ? Object.values(value as Record<string, unknown>).flatMap(leaves)
        : [value];
    for (const leaf of leaves(defaultEngineConfig)) expect(typeof leaf).toBe('number');
  });
});

describe('resolveEngineConfig', () => {
  it('is pure: the same overrides produce a deeply equal result', () => {
    const overrides: EngineConfigOverrides = { alpha: 2, fixationDuration: { medianMs: 300 } };
    expect(resolveEngineConfig(overrides)).toEqual(resolveEngineConfig(overrides));
  });

  it('mutates neither the overrides nor the defaults', () => {
    const overrides: EngineConfigOverrides = { beta: 3, salience: { weights: { topBias: 0.9 } } };
    const overridesBefore = structuredClone(overrides);
    const defaultsBefore = structuredClone(defaultEngineConfig);

    resolveEngineConfig(overrides);

    expect(overrides).toEqual(overridesBefore);
    expect(defaultEngineConfig).toEqual(defaultsBefore);
  });

  it('lets a run engine.weights override of alpha, beta and gamma win', () => {
    const weights = { alpha: 1.7, beta: 0.3, gamma: -0.5 };
    const { config } = resolveEngineConfig(weights);

    expect(config.alpha).toBe(1.7);
    expect(config.beta).toBe(0.3);
    expect(config.gamma).toBe(-0.5);
  });

  it('merges a nested override key by key, keeping its siblings', () => {
    const { config } = resolveEngineConfig({ salience: { weights: { centreBias: 0.42 } } });

    expect(config.salience.weights.centreBias).toBe(0.42);
    expect(config.salience.weights.topBias).toBe(defaultEngineConfig.salience.weights.topBias);
    expect(config.salience.rolePriors).toEqual(defaultEngineConfig.salience.rolePriors);
  });

  it('shares no sub-object with the defaults, so a later mutation cannot reach them', () => {
    const { config } = resolveEngineConfig();

    expect(config.salience.rolePriors).not.toBe(defaultEngineConfig.salience.rolePriors);
    expect(config.persona).not.toBe(defaultEngineConfig.persona);
    expect(config.salience.rolePriors).toEqual(defaultEngineConfig.salience.rolePriors);
  });

  it('ignores a prototype key in the overrides rather than writing through it', () => {
    const overrides = JSON.parse(
      '{"__proto__": {"alpha": 99}, "beta": 4}',
    ) as EngineConfigOverrides;
    const { config } = resolveEngineConfig(overrides);

    expect(config.alpha).toBe(defaultEngineConfig.alpha);
    expect(config.beta).toBe(4);
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
  });

  it('answers the defaults with no record and no overrides at all', () => {
    // Since #90 committed `config/calibrated.json`, `resolveEngineConfig()` answers the
    // fitted layer; the uncalibrated answer is what this one is about, and the calibrated
    // seam below has the other half.
    const resolved = resolveFrom(null);

    expect(resolved.config).toEqual(defaultEngineConfig);
    expect(resolved.calibrated).toBe(false);
    expect(resolved.metrics).toBeNull();
  });
});

describe('the calibrated-configuration seam', () => {
  const recordPath = new URL('../config/calibrated.json', import.meta.url);
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
    weights: EngineConfigOverrides;
    metrics: Record<string, unknown>;
  };

  it('holds the fitted values the calibration step committed (#90)', () => {
    expect(existsSync(recordPath)).toBe(true);
    expect(Object.keys(record.weights).length).toBeGreaterThan(0);
  });

  it('layers them over the defaults and reports the configuration as calibrated', () => {
    const resolved = resolveEngineConfig();

    expect(resolved.calibrated).toBe(true);
    expect(resolved.config.fixationDuration.medianMs).toBe(
      record.weights.fixationDuration?.medianMs,
    );
    // A leaf the fit did not move is still the engine's own default, key by key.
    expect(resolved.config.saccade.amplitude.medianPx).toBe(
      defaultEngineConfig.saccade.amplitude.medianPx,
    );
  });

  it('surfaces the figures those values were measured at, so a run loop reads no file', () => {
    const { metrics } = resolveEngineConfig();

    // The run artifact's calibration block (#92) is written from this and nothing else, and
    // `packages/contract` admits one benchmark name.
    expect(metrics?.benchmark).toBe('UEyes');
    expect(metrics).toEqual({ benchmark: 'UEyes', ...record.metrics });
    for (const figure of ['cc', 'nss', 'scanMatch'] as const) {
      expect(typeof metrics?.[figure], figure).toBe('number');
    }
    // A figure measured over generated records is not a published benchmark score, and the
    // surface says so rather than leaving the badge to imply otherwise.
    expect(metrics?.corpus.synthetic).toBe(true);
    expect(metrics?.scope).toBe('webpage');
  });

  it('and a run’s own weights still win over the fitted ones', () => {
    const resolved = resolveEngineConfig({ fixationDuration: { medianMs: 211 } });

    expect(resolved.config.fixationDuration.medianMs).toBe(211);
    expect(resolved.calibrated).toBe(true);
  });

  it('with no record at all: the defaults stand, calibrated is false and there are no metrics', () => {
    // The committed file is a build-time import and cannot be made to disappear from one,
    // so the branch behind the badge's "not calibrated" state is exercised here (#90).
    const resolved = resolveFrom(null);

    expect(resolved.config).toEqual(defaultEngineConfig);
    expect(resolved.calibrated).toBe(false);
    expect(resolved.metrics).toBeNull();
  });
});

describe('purity', () => {
  const srcDir = new URL('../src/', import.meta.url);
  const sources = readdirSync(srcDir, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => ({ entry, text: readFileSync(new URL(entry, srcDir), 'utf8') }));

  /**
   * The engine reads no file and opens no socket — at import time or at any other time —
   * and the calibrated values arrive as a build-time import. Asserted over the sources
   * rather than by spying at run time, because an ESM import reads its own module file
   * from disk by definition: what can be proved is that no module here asks for one.
   */
  it.each(['node:fs', 'node:net', 'node:http', 'node:dns', 'fetch(', 'XMLHttpRequest'])(
    'never reaches for %s',
    (forbidden) => {
      for (const { entry, text } of sources) expect(`${entry}: ${text}`).not.toContain(forbidden);
    },
  );

  it('never uses Math.random, so every draw is seeded', () => {
    for (const { entry, text } of sources) expect(`${entry}: ${text}`).not.toContain('Math.random');
  });

  it('declares only contract and sharp as dependencies', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const { dependencies } = manifest as { dependencies: Record<string, string> };

    expect(Object.keys(dependencies).sort()).toEqual(['@personavision/contract', 'sharp']);
  });
});
