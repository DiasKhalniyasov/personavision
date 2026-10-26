import { describeDecisionProviderContract } from '../src/testing.js';
import { createOfflineDeterministicProvider, OFFLINE_PROVIDER_NAME } from '../src/offline.js';

/**
 * The exported suite, run against the offline provider. This file is also the worked
 * example for #43: a new provider is five lines here and inherits every guarantee.
 */
describeDecisionProviderContract({
  name: OFFLINE_PROVIDER_NAME,
  createProvider: ({ seed }) => createOfflineDeterministicProvider({ seed }),
  deterministic: true,
  free: true,
});
