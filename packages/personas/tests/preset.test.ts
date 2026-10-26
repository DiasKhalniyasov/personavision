import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { audienceSchema, listRunDirs, runPaths, runSchema } from '@personavision/contract';
import type { Persona } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { DEMO_AUDIENCE_SEED, OUTDOOR_GEAR_SHOPPERS, generatePersonas } from '../src/index.js';

/** The repository's runs root, as the viewer's tests reach it: no path is restated here. */
const RUNS_ROOT = fileURLToPath(new URL('../../../runs', import.meta.url));

/**
 * The committed example run, read through the contract rather than by a hand-written path.
 * The demo directory is the only one in the repository, and the newest either way.
 */
const exampleRun = async () => {
  const [runId] = await listRunDirs(RUNS_ROOT);
  if (runId === undefined) throw new Error(`no run directory under ${RUNS_ROOT}`);
  return runSchema.parse(JSON.parse(await readFile(runPaths(`${RUNS_ROOT}/${runId}`).run, 'utf8')));
};

/** What the preset pins about a person: who they are, not the numbers sampled for them. */
const identity = (persona: Persona) => ({
  id: persona.id,
  name: persona.name,
  segment: persona.segment,
  device: persona.device.name,
});

/**
 * The four people the demo has always had. `docs/design/prototype.html`'s `PERSONAS`
 * constant is the source: the prototype's own screens, the committed example run and every
 * fixture address these ids and print these names, so the generator reproducing them is
 * what keeps the audience preset and the demo one thing rather than two.
 */
const DEMO_FOUR = [
  { id: 'rushed', name: 'Rushed buyer', device: 'iPhone 15', segment: 'mobile · in a hurry' },
  {
    id: 'careful',
    name: 'Careful comparer',
    device: 'MacBook Air 13',
    segment: 'desktop · compares carefully',
  },
  {
    id: 'firsttime',
    name: 'First-time visitor',
    device: 'MacBook Air 13',
    segment: 'desktop · first visit',
  },
  {
    id: 'price',
    name: 'Price-sensitive scanner',
    device: 'iPhone 15',
    segment: 'mobile · price-sensitive',
  },
] as const;

describe('the committed Outdoor-gear shoppers preset', () => {
  it('is a valid audience', () => {
    expect(audienceSchema.safeParse(OUTDOOR_GEAR_SHOPPERS)).toMatchObject({ success: true });
  });

  it('states the demo shop audience the design contract describes', () => {
    expect(OUTDOOR_GEAR_SHOPPERS).toMatchObject({
      id: 'outdoor-gear-shoppers',
      name: 'Outdoor-gear shoppers',
      ageRange: { min: 25, max: 45 },
      regions: ['United Kingdom', 'Ireland'],
      techSavviness: 0.55,
      priceSensitivity: 0.75,
      size: 4,
      generatedFrom: { seed: DEMO_AUDIENCE_SEED },
    });
    expect(OUTDOOR_GEAR_SHOPPERS.devices.map(({ name, share }) => ({ name, share }))).toStrictEqual(
      [
        { name: 'mobile', share: 0.6 },
        { name: 'desktop', share: 0.4 },
      ],
    );
  });

  it('generates exactly the four demo people, with their ids, names, segments and devices', () => {
    const personas = generatePersonas(OUTDOOR_GEAR_SHOPPERS, { seed: DEMO_AUDIENCE_SEED });

    expect(personas.map(identity)).toStrictEqual(DEMO_FOUR.map((person) => ({ ...person })));
  });

  it('generates them from the audience own seed with no seed passed', () => {
    expect(JSON.stringify(generatePersonas(OUTDOOR_GEAR_SHOPPERS))).toBe(
      JSON.stringify(generatePersonas(OUTDOOR_GEAR_SHOPPERS, { seed: DEMO_AUDIENCE_SEED })),
    );
  });

  it('gives each of the four the device geometry the committed example run records', () => {
    const personas = generatePersonas(OUTDOOR_GEAR_SHOPPERS);
    const byName = new Map(personas.map((persona) => [persona.device.name, persona.device]));

    expect(byName.get('iPhone 15')).toStrictEqual({
      name: 'iPhone 15',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      touch: true,
    });
    expect(byName.get('MacBook Air 13')).toStrictEqual({
      name: 'MacBook Air 13',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      touch: false,
    });
  });
});

describe('the preset against the committed example run', () => {
  it('matches the audience the example run was tested for, field for field', async () => {
    expect((await exampleRun()).audience).toStrictEqual(OUTDOOR_GEAR_SHOPPERS);
  });

  it('generates the people the example run records, by id, name, segment and device', async () => {
    const run = await exampleRun();

    expect(generatePersonas(run.audience).map(identity)).toStrictEqual(run.personas.map(identity));
  });
});
