/**
 * Which engine this is.
 *
 * `ENGINE_VERSION` is the string a run artifact records as `engine.version` (#92) and the
 * one every row of the committed calibration report carries (#89), so what matters is that
 * it is the package's own and that the committed calibrated configuration was fitted against
 * it. A version restated anywhere else would be a second answer to one question.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../src/index.js';

const readJson = <Parsed>(file: string): Parsed =>
  JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')) as Parsed;

describe('the engine’s version', () => {
  it('is the one the package manifest declares', () => {
    const { version } = readJson<{ version: string }>('../package.json');

    expect(ENGINE_VERSION).toBe(version);
    expect(ENGINE_VERSION.length).toBeGreaterThan(0);
  });

  it('is the engine the committed calibrated configuration was fitted against', () => {
    // The tie the header badge rests on: the figures in that file were measured on this
    // engine, and a run that quotes them names this version. An engine that moved on
    // without a refit fails here rather than shipping a figure another engine earned.
    const record = readJson<{ engine: { version: string } }>('../config/calibrated.json');

    expect(ENGINE_VERSION).toBe(record.engine.version);
  });
});
