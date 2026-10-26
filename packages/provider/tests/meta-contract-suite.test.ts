import { createMetaModelApiProvider, META_MODEL_PROVIDER_NAME } from '../src/meta-model.js';
import { describeDecisionProviderContract } from '../src/testing.js';
import { fakeTransport, TEST_ENV } from './meta-fake.js';

/**
 * The shared provider-contract suite, run against the Meta Model API provider with the
 * transport injected: no key, no network, and every guarantee the interface publishes.
 *
 * `deterministic: false` because the real provider's answer comes from a sampler, not
 * because this fake's does — the rest of the suite is unchanged, which is the point of the
 * suite. `free: false` because a model call costs money and the usage it reports is checked
 * for shape rather than for zeroes.
 */
describeDecisionProviderContract({
  name: `${META_MODEL_PROVIDER_NAME} (contributor, injected transport)`,
  createProvider: () =>
    createMetaModelApiProvider({
      mode: 'contributor',
      env: TEST_ENV,
      transport: fakeTransport().transport,
    }),
  deterministic: false,
  free: false,
});

describeDecisionProviderContract({
  name: `${META_MODEL_PROVIDER_NAME} (standard, injected transport)`,
  createProvider: () =>
    createMetaModelApiProvider({
      mode: 'standard',
      env: TEST_ENV,
      transport: fakeTransport().transport,
    }),
  deterministic: false,
  free: false,
  // The mode changes the model id and the prices, not the behaviour, so a smaller band is
  // enough here: the contributor run above covers the band.
  seedBand: 4,
});
