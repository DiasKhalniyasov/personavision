import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultEngineConfig, resolveEngineConfig } from '../src/config.js';
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
  'salience.rolePriors.heading',
  'salience.rolePriors.img',
  'salience.rolePriors.link',
  'salience.rolePriors.other',
  'salience.rolePriors.radio',
  'salience.rolePriors.text',
  'salience.rolePriors.textbox',
  'salience.weights.centreBias',
  'salience.weights.colourContrast',
  'salience.weights.luminanceContrast',
  'salience.weights.relativeArea',
  'salience.weights.rolePrior',
  'salience.weights.topBias',
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

  it('answers the defaults, uncalibrated, when no overrides are given', () => {
    const resolved = resolveEngineConfig();

    expect(resolved.config).toEqual(defaultEngineConfig);
    expect(resolved.calibrated).toBe(false);
  });
});

describe('the calibrated-configuration seam', () => {
  const configDir = new URL('../config/', import.meta.url);

  it('has no calibrated.json yet, so the defaults stand and calibrated is false', () => {
    expect(existsSync(new URL('calibrated.json', configDir))).toBe(false);
    expect(resolveEngineConfig().calibrated).toBe(false);
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
