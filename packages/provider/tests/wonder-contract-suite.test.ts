import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeWonderProviderContract } from '../src/testing.js';
import {
  createOfflineWonderProvider,
  OFFLINE_WONDER_PROVIDER_NAME,
} from '../src/wonder-offline.js';

/**
 * The exported one-shot suite, run against the offline implementation — which is the
 * project's default, so this file is where "the default is held to the contract" is true.
 * It is also the worked example for #255: a new Wonder implementation is five lines here and
 * inherits every guarantee.
 */
describeWonderProviderContract({
  name: OFFLINE_WONDER_PROVIDER_NAME,
  createProvider: () => createOfflineWonderProvider(),
  deterministic: true,
  free: true,
});

describe('what the one-shot suite deliberately does not assert', () => {
  it('asserts no prompt text: no assertion in it reads the ask’s document or any wording', () => {
    const source = readFileSync(new URL('../src/testing.ts', import.meta.url), 'utf8');
    const at = source.indexOf('export const describeWonderProviderContract');

    // Found, before anything is read from it: a renamed suite would otherwise slice from
    // `-1`, find no assertion to object to, and pass this test by having read one character.
    expect(at).toBeGreaterThan(0);
    // From the exported suite to the end of the file: the Wonder half of this module.
    const suite = source.slice(at);
    const assertions = suite.split('\n').filter((line) => line.includes('expect('));

    expect(assertions.length).toBeGreaterThan(10);
    // A prompt is an implementation's own business and changes whenever its model does. A
    // suite that asserted one would fail every time a use improved its wording, and an
    // implementation would be held to words rather than to behaviour.
    expect(
      assertions.filter((line) => /document|prompt|instruction|wording|developer/i.test(line)),
    ).toEqual([]);
  });
});
