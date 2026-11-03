import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeWonderProviderContract } from '../src/testing.js';
import {
  createOfflineWonderProvider,
  OFFLINE_WONDER_PROVIDER_NAME,
} from '../src/wonder-offline.js';
import { createMetaWonderProvider, WONDER_PROVIDER_NAME } from '../src/wonder-model.js';
import { fakeTransport, TEST_ENV } from './wonder-fake.js';

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

/**
 * The same suite, against the model implementation with its transport injected: no key, no
 * network, and every guarantee the seam publishes (#255). Running both from one file is what
 * stops the offline default and the model implementation drifting apart — a guarantee one
 * keeps and the other does not is a red test here rather than a surprise in a run.
 *
 * `deterministic: false` because the real model's answer comes from a sampler, not because
 * this fake's does. `free: false` because a Wonder call costs money and the usage it reports
 * is checked for shape and for its price rather than for zeroes.
 */
describeWonderProviderContract({
  name: `${WONDER_PROVIDER_NAME} (injected transport)`,
  createProvider: () =>
    createMetaWonderProvider({ env: TEST_ENV, transport: fakeTransport().transport }),
  deterministic: false,
  free: false,
});
