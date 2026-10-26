import { createSeededRandom } from '@personavision/contract';
import type { Audience } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { deviceQuota } from '../src/devices.js';
import { generatePersonas } from '../src/index.js';
import { audienceWith } from './helpers.js';

/**
 * The device mix over the whole input space, rather than over the handful of mixes a demo
 * happens to use. The apportionment has a loop in it and a floor that moves people between
 * devices, so "the counts are the shares" is asserted against random share vectors at every
 * size a swarm plausibly runs at, including the sizes where the floor has to intervene.
 */

const random = createSeededRandom(4242);

/** A share vector of `count` devices summing to exactly one, as `audienceSchema` demands. */
const randomShares = (count: number): number[] => {
  const raw = Array.from({ length: count }, () => random() + 1e-9);
  const total = raw.reduce((running, share) => running + share, 0);
  const shares = raw.map((share) => share / total);
  const residue = 1 - shares.reduce((running, share) => running + share, 0);
  shares[count - 1] = (shares[count - 1] ?? 0) + residue;
  return shares;
};

const audienceOf = (size: number, shares: readonly number[]): Audience =>
  audienceWith({
    size,
    devices: shares.map((share, index) => ({
      name: `device-${index}`,
      viewport: { width: 400 + index, height: 800 },
      deviceScaleFactor: 1,
      // Alternating, so both archetype affinities compete for the mix at every length.
      touch: index % 2 === 0,
      share,
    })),
  });

const SIZES = [1, 2, 3, 4, 5, 7, 11, 24, 97];
const MIXES = Array.from({ length: 6 }, (_unused, index) =>
  Array.from({ length: 30 }, () => randomShares(index + 1)),
);

describe.each(MIXES.map((mixes, index) => [index + 1, mixes] as const))(
  'a mix of %i device(s), over 30 random share vectors',
  (deviceCount, mixes) => {
    it.each(SIZES)('apportions all %i people and leaves none on a negative count', (size) => {
      for (const shares of mixes) {
        const quota = deviceQuota(audienceOf(size, shares));

        expect(quota.reduce((running, count) => running + count, 0)).toBe(size);
        expect(quota.every((count) => count >= 0)).toBe(true);
      }
    });

    it.each(SIZES)('gives every declared device somebody at size %i, when it can', (size) => {
      if (size < deviceCount) return;
      for (const shares of mixes) {
        expect(deviceQuota(audienceOf(size, shares))).not.toContain(0);
      }
    });

    it.each(SIZES)('spends its few people on the largest shares at size %i', (size) => {
      if (size >= deviceCount) return;
      for (const shares of mixes) {
        const quota = deviceQuota(audienceOf(size, shares));
        const covered = shares.filter((_unused, index) => (quota[index] ?? 0) > 0);
        const uncovered = shares.filter((_unused, index) => (quota[index] ?? 0) === 0);

        // With fewer people than devices some device has nobody on it. Which one is not
        // arbitrary: nobody is left out while a smaller share is covered. A share worth
        // more than one of the few people still takes more than one of them, which is why
        // this is about who is covered and not about how many are.
        expect(uncovered.length).toBeGreaterThan(0);
        expect(Math.max(...uncovered)).toBeLessThanOrEqual(Math.min(...covered));
      }
    });

    it.each(SIZES)('hands out exactly the quota it computed, at size %i', (size) => {
      for (const shares of mixes) {
        const audience = audienceOf(size, shares);
        const quota = deviceQuota(audience);
        const people = generatePersonas(audience);
        const given = audience.devices.map(
          (device) => people.filter((person) => person.device.name === device.name).length,
        );

        expect(given).toStrictEqual(quota);
        expect(new Set(people.map((person) => person.id)).size).toBe(size);
      }
    });

    it.each(SIZES)('stays within one person of every declared share, at size %i', (size) => {
      for (const shares of mixes) {
        // The representation floor is allowed to overrule a share, and does so only for a
        // device with less than one person's worth of it. Those mixes are checked above.
        if (size >= deviceCount && shares.some((share) => share * size < 1)) continue;
        const quota = deviceQuota(audienceOf(size, shares));

        for (const [index, count] of quota.entries()) {
          expect(Math.abs(count - size * (shares[index] ?? 0))).toBeLessThan(1);
        }
      }
    });
  },
);

/**
 * The contract holds a device mix to summing to one within `1e-6`, which is a tolerance and
 * not an equality: `size * share` summed over a legal mix need not be `size` at all, and over
 * millions of people it is out by whole people. The apportionment promises to account for
 * every person regardless, because the assignment relies on it to always have a device left
 * to hand out — without it, the last person of a very large audience got no device and the
 * failure arrived as a `TypeError` from inside a `reduce`.
 */
describe('a mix whose shares only nearly sum to one', () => {
  const nearly = [
    { what: 'a whisker under one', shares: [0.5, 0.499999] },
    { what: 'a whisker over one', shares: [0.5, 0.500001] },
    { what: 'under one across three devices', shares: [0.4, 0.3, 0.299999] },
    { what: 'over one on a single device', shares: [1.000001] },
  ];

  for (const { what, shares } of nearly) {
    it.each([3, 1_000, 2_000_000, 6_000_000])(
      `accounts for every one of %i people with shares ${what}`,
      (size) => {
        const quota = deviceQuota(audienceOf(size, shares));

        expect(quota.reduce((running, count) => running + count, 0)).toBe(size);
        expect(quota.every((count) => count >= 0)).toBe(true);
      },
    );
  }

  it('still hands every person a device at a size where the drift is whole people', () => {
    // 2000 people is enough to run, and the repair is the same code path the millions take.
    const audience = audienceOf(2_000, [0.5, 0.499999]);

    expect(generatePersonas(audience)).toHaveLength(audience.size);
  });
});
