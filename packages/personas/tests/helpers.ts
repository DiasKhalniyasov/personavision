import type { Audience, AudienceDevice, Persona } from '@personavision/contract';
import { GENERATOR_VERSION } from '../src/audience.js';

/** The two device classes the demo audience is authored with, as `audienceSchema` spells them. */
export const MOBILE_CLASS: AudienceDevice = {
  name: 'mobile',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  touch: true,
  share: 0.6,
};

export const DESKTOP_CLASS: AudienceDevice = {
  name: 'desktop',
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  touch: false,
  share: 0.4,
};

/**
 * A valid audience with every field at a stated value, so a test can move exactly one of
 * them and attribute what changed to that move.
 */
export const audienceWith = (overrides: Partial<Audience> = {}): Audience => ({
  id: 'test-audience',
  name: 'Test audience',
  ageRange: { min: 30, max: 50 },
  roles: ['First-time buyer'],
  regions: ['United Kingdom'],
  goals: ['Buy one item quickly'],
  devices: [MOBILE_CLASS, DESKTOP_CLASS],
  techSavviness: 0.5,
  priceSensitivity: 0.5,
  size: 12,
  generatedFrom: { seed: 1, generatorVersion: GENERATOR_VERSION },
  ...overrides,
});

/** A device class with its share rewritten, so a mix always sums to one. */
export const withShare = (device: AudienceDevice, share: number): AudienceDevice => ({
  ...device,
  share,
});

export const traitValues = (personas: readonly Persona[], trait: keyof Persona['traits']) =>
  personas.map((persona) => persona.traits[trait]);

export const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  const low = sorted[sorted.length % 2 === 0 ? middle - 1 : middle];
  const high = sorted[middle];
  if (low === undefined || high === undefined) throw new Error('no values to take a median of');
  return (low + high) / 2;
};

export const spread = (values: readonly number[]): number =>
  Math.max(...values) - Math.min(...values);
