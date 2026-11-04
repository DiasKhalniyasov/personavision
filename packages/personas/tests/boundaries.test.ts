import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as personas from '../src/index.js';

/**
 * What this package is not. Generation is the whole of its behaviour: the trait-to-sampling
 * parameter table belongs to `@personavision/engine` (#56) and the decision layer reads the
 * six traits directly, so a sampling parameter or a decision computed here would be a second
 * place for a number the calibration step has to be able to fit.
 *
 * Asserted over the sources, in the same shape as the engine's own purity suite, because the
 * line is about what the package contains rather than about one call.
 */
describe('the package holds generation and nothing else', () => {
  const srcDir = new URL('../src/', import.meta.url);
  const sources = readdirSync(srcDir, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => ({ entry, text: readFileSync(new URL(entry, srcDir), 'utf8') }));

  it.each([
    'fixationDurationScale',
    'fixationCountScale',
    'dwellScale',
    'rolePriorScale',
    'screenPersistenceScale',
    'verificationScale',
  ])('implements no %s: the trait-to-sampling-parameter table is the engine own', (parameter) => {
    for (const { entry, text } of sources) expect(`${entry}: ${text}`).not.toContain(parameter);
  });

  it.each(['DecisionProvider', 'decidedAction', 'sampleFixations', 'runSession', 'EngineConfig'])(
    'implements no decision logic: no %s here',
    (symbol) => {
      for (const { entry, text } of sources) expect(`${entry}: ${text}`).not.toContain(symbol);
    },
  );

  it('never uses Math.random, so the same audience and seed give the same people', () => {
    for (const { entry, text } of sources) expect(`${entry}: ${text}`).not.toContain('Math.random');
  });

  it.each(['node:fs', 'node:net', 'node:http', 'node:dns', 'fetch(', 'process.env'])(
    'never reaches for %s: generation needs no file, no socket and no key',
    (forbidden) => {
      for (const { entry, text } of sources) expect(`${entry}: ${text}`).not.toContain(forbidden);
    },
  );

  it('declares the contract as its only dependency', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const { dependencies } = manifest as { dependencies: Record<string, string> };

    expect(Object.keys(dependencies)).toEqual(['@personavision/contract']);
  });

  it('restates no artifact field name of its own: the shapes come from the contract', () => {
    const generator = sources.find(({ entry }) => entry === 'generate.ts');

    expect(generator?.text).toContain("from '@personavision/contract'");
    // The generated person is parsed by the contract's own schema on the way out, so a
    // field this package mis-spelled could not reach a caller.
    expect(generator?.text).toContain('personaSchema.parse');
  });

  /**
   * The package's whole surface. A source grep can only say that the symbols it names are
   * absent; this says what the package offers, so behaviour cannot be added to the interface
   * without this list changing and somebody reading why.
   */
  it('exports generation, the holdout, the preset, the audience validation and the region table, and nothing else', () => {
    expect(Object.keys(personas).sort()).toStrictEqual([
      'AudienceValidationError',
      'BROWSING_REGIONS',
      'DEMO_AUDIENCE_SEED',
      'GENERATOR_VERSION',
      'OUTDOOR_GEAR_SHOPPERS',
      'browsingFor',
      'browsingRegion',
      'generateHoldout',
      'generatePersonas',
      'holdoutSize',
      'languageSubtag',
      'parseAudience',
    ]);
  });

  /**
   * The one copy of the mapping. A region name becomes a locale, a time zone and a location
   * in exactly one place, and the swarm opens its sessions with what that place says: a
   * second table anywhere would be free to drift, and the drift would be a session reporting
   * a locale it did not run under (#421).
   */
  it.each(['Europe/London', 'America/New_York', 'Asia/Almaty'])(
    'is the only module here that names %s',
    (timeZone) => {
      const naming = sources
        .filter(({ text }) => text.includes(timeZone))
        .map(({ entry }) => entry);

      expect(naming).toStrictEqual(['regions.ts']);
    },
  );
});
