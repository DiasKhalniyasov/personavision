import type { Audience, AudienceDevice, Persona } from '@personavision/contract';

/**
 * The device mix: how many people are on each device the audience declares, and which
 * concrete device each of them ran on.
 *
 * An audience's `devices[]` is a mix of device **classes** with a nominal viewport and a
 * share — `mobile` 390 × 844 at 60%, `desktop` 1280 × 800 at 40%, which is what the Audience
 * screen draws as chips. A generated person carries the **concrete** device it ran on, which
 * is what a session records and what gaze is projected from, so the two may differ on the
 * viewport. That reading is the project's (decision 3 on #105/#106), and the rule it leaves
 * for this file is: honour the shares, not the viewports.
 */

/** A concrete device, as `personaSchema` records it: the class's `share` is not part of it. */
export type ConcreteDevice = Persona['device'];

/**
 * The device each class is run on. The three entries are the ones the design contract names
 * — the Audience screen offers Mobile, Desktop and Tablet — and the geometry is what the
 * committed example run's sessions were captured at.
 *
 * A class this table does not know keeps its own name and geometry, so an audience may
 * declare any device without this file being edited first; and a known class whose declared
 * `touch` disagrees with the model's keeps its own too, because a touch device implies the
 * mobile viewport and the fold that goes with it (`docs/FLOW.md` section 1) and a table is
 * not allowed to overrule what the audience said about that.
 */
export const CONCRETE_DEVICES: Readonly<Record<string, ConcreteDevice>> = {
  mobile: {
    name: 'iPhone 15',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    touch: true,
  },
  desktop: {
    name: 'MacBook Air 13',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    touch: false,
  },
  tablet: {
    name: 'iPad (10th generation)',
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    touch: true,
  },
};

/** The class as its own device: the audience's word for it, without the share. */
const asItself = (device: AudienceDevice): ConcreteDevice => ({
  name: device.name,
  viewport: device.viewport,
  deviceScaleFactor: device.deviceScaleFactor,
  touch: device.touch,
});

export const concreteDeviceFor = (device: AudienceDevice): ConcreteDevice => {
  const known = CONCRETE_DEVICES[device.name.toLowerCase()];
  return known === undefined || known.touch !== device.touch ? asItself(device) : known;
};

/**
 * How many of `size` people are on each declared device, in the mix's own order.
 *
 * Largest remainder, so the counts are the shares rather than a sample of them: a declared
 * 60% is 60% of the people the audience generates, to within one person, at every size and
 * for every seed. Drawing each person's device independently would leave the mix a test
 * reports some way from the mix the user authored, and at the demo's size of four it could
 * leave a declared device with nobody on it at all.
 *
 * **The representation floor.** Once an audience has at least as many people as devices,
 * every declared device gets at least one of them, taken from the largest count. A device
 * declared at 1% is part of the audience; a swarm that puts nobody on it reports nothing
 * about it, and the user who added it would not know. Below that size the people go to the
 * largest shares, because there is no honest way to cover every device with fewer people
 * than devices.
 */
export const deviceQuota = (audience: Audience): number[] => {
  const exact = audience.devices.map((device) => audience.size * device.share);
  const quota = exact.map(Math.floor);
  const assigned = quota.reduce((total, count) => total + count, 0);

  // The spare people go to the largest remainders, with the mix's own order breaking a tie.
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const { index } of byRemainder.slice(0, audience.size - assigned)) {
    quota[index] = (quota[index] ?? 0) + 1;
  }

  if (audience.size < audience.devices.length) return quota;

  // The floor. Taking from the largest count can never empty it: with one count at zero the
  // rest hold `size >= devices.length` people between them, so one of them holds two.
  for (;;) {
    const empty = quota.findIndex((count) => count === 0);
    if (empty === -1) return quota;
    const fullest = quota.reduce(
      (best, count, index) => (count > (quota[best] ?? 0) ? index : best),
      0,
    );
    quota[fullest] = (quota[fullest] ?? 0) - 1;
    quota[empty] = 1;
  }
};
