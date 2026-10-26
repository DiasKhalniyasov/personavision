import type { Persona } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { CONCRETE_DEVICES, generatePersonas } from '../src/index.js';
import { DESKTOP_CLASS, MOBILE_CLASS, audienceWith, withShare } from './helpers.js';

const countBy = (personas: readonly Persona[]) => {
  const counts = new Map<string, number>();
  for (const persona of personas) {
    counts.set(persona.device.name, (counts.get(persona.device.name) ?? 0) + 1);
  }
  return counts;
};

const TABLET_CLASS = {
  name: 'tablet',
  viewport: { width: 820, height: 1180 },
  deviceScaleFactor: 2,
  touch: true,
  share: 0.2,
};

describe('the device each person gets is drawn from the mix by share', () => {
  it('matches the declared shares within one person over a large audience', () => {
    const audience = audienceWith({ size: 500 });
    const counts = countBy(generatePersonas(audience, { seed: 2 }));

    for (const device of audience.devices) {
      const observed =
        (counts.get(CONCRETE_DEVICES[device.name]?.name ?? device.name) ?? 0) / audience.size;
      expect(Math.abs(observed - device.share)).toBeLessThanOrEqual(1 / audience.size);
    }
  });

  it('matches the declared shares within one person over a three-device mix', () => {
    const audience = audienceWith({
      size: 97,
      devices: [withShare(MOBILE_CLASS, 0.5), withShare(DESKTOP_CLASS, 0.3), TABLET_CLASS],
    });
    const counts = countBy(generatePersonas(audience, { seed: 2 }));

    for (const device of audience.devices) {
      const observed =
        (counts.get(CONCRETE_DEVICES[device.name]?.name ?? device.name) ?? 0) / audience.size;
      expect(Math.abs(observed - device.share)).toBeLessThanOrEqual(1 / audience.size);
    }
  });

  it('gives every declared device at least one person once the audience is big enough to hold them', () => {
    const audience = audienceWith({
      size: 3,
      devices: [
        withShare(MOBILE_CLASS, 0.97),
        withShare(DESKTOP_CLASS, 0.02),
        withShare(TABLET_CLASS, 0.01),
      ],
    });

    expect(countBy(generatePersonas(audience, { seed: 2 })).size).toBe(3);
  });

  it('spends the few people it has on the largest shares when the mix is longer than the audience', () => {
    const audience = audienceWith({
      size: 2,
      devices: [
        withShare(MOBILE_CLASS, 0.6),
        withShare(DESKTOP_CLASS, 0.3),
        withShare(TABLET_CLASS, 0.1),
      ],
    });
    const counts = countBy(generatePersonas(audience, { seed: 2 }));

    expect([...counts.keys()].sort()).toStrictEqual(
      ['mobile', 'desktop'].map((name) => CONCRETE_DEVICES[name]?.name ?? name).sort(),
    );
  });

  it('does not move the device split when the seed changes, so two runs of one audience compare', () => {
    const audience = audienceWith({ size: 40 });

    expect(countBy(generatePersonas(audience, { seed: 1 }))).toStrictEqual(
      countBy(generatePersonas(audience, { seed: 2 })),
    );
  });
});

describe('a generated person carries the concrete device it ran on', () => {
  it('resolves the mobile and desktop classes to the models the demo run records', () => {
    const personas = generatePersonas(audienceWith({ size: 4 }), { seed: 1 });

    expect(new Set(personas.map((persona) => persona.device.name))).toStrictEqual(
      new Set(['iPhone 15', 'MacBook Air 13']),
    );
  });

  it('keeps the class own geometry when the mix names a device the table does not know', () => {
    const own = {
      name: 'kiosk',
      viewport: { width: 1024, height: 1366 },
      deviceScaleFactor: 1,
      touch: true,
      share: 1,
    };
    const personas = generatePersonas(audienceWith({ size: 2, devices: [own] }), { seed: 1 });

    for (const persona of personas) {
      expect(persona.device).toStrictEqual({
        name: own.name,
        viewport: own.viewport,
        deviceScaleFactor: own.deviceScaleFactor,
        touch: own.touch,
      });
    }
  });

  it('never flips the touch flag the audience declared', () => {
    const untouchableMobile = { ...MOBILE_CLASS, touch: false, share: 1 };
    const personas = generatePersonas(audienceWith({ size: 2, devices: [untouchableMobile] }), {
      seed: 1,
    });

    for (const persona of personas) {
      expect(persona.device.touch).toBe(false);
      expect(persona.device.name).toBe('mobile');
    }
  });

  it('names the device class in the segment, so results group by how people browsed', () => {
    const personas = generatePersonas(audienceWith({ size: 4 }), { seed: 1 });

    for (const persona of personas) {
      expect(persona.segment).toMatch(/^(mobile|desktop) · /);
    }
  });
});
