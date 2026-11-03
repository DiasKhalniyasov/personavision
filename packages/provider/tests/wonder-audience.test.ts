import { audienceSchema } from '@personavision/contract';
import type { Audience } from '@personavision/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeAudience as writeAudienceFromIndex } from '../src/index.js';
import { estimateCostUsd, WONDER_MODEL_ID } from '../src/meta-pricing.js';
import { WonderReplyError } from '../src/wonder.js';
import {
  AUDIENCE_DEVICE_CLASSES,
  AUDIENCE_EFFORT,
  AUDIENCE_REPLY_SCHEMA_NAME,
  audienceAsk,
  DEFAULT_AUDIENCE_SIZE,
  SHARE_ROUNDING_TOLERANCE,
  writeAudience,
} from '../src/wonder-audience.js';
import type { AudienceAskInput } from '../src/wonder-audience.js';
import { createMetaWonderProvider, WONDER_PROVIDER_MODE } from '../src/wonder-model.js';
import { createOfflineWonderProvider } from '../src/wonder-offline.js';
import { fakeTransport, FAKE_TOKENS, TEST_ENV } from './wonder-fake.js';

/**
 * The structured audience Muse Wonder writes from one sentence (#257): the same object the
 * Audience form produces, refused with the path when a field is missing or the wrong type,
 * when a device class was never offered, or when a set of shares is not a distribution — and
 * made into a distribution where it misses one by rounding.
 *
 * Nothing here reaches the network or reads a key: the offline implementation is the default
 * and the model implementation is driven by the recorded transport the whole package is
 * tested through.
 */

const SENTENCE = 'busy parents in Almaty who shop on their phones';

const input = (overrides: Partial<AudienceAskInput> = {}): AudienceAskInput => ({
  sentence: SENTENCE,
  id: 'A-01',
  seed: 7,
  generatorVersion: 'persona-gen-1',
  ...overrides,
});

/** The described audience as a cooperative model answers it: class names, no provenance. */
const DESCRIBED = {
  name: 'Busy parents in Almaty',
  ageRange: { min: 28, max: 44 },
  roles: ['busy parent'],
  regions: ['Almaty'],
  languages: ['Russian', 'Kazakh'],
  genderSplit: { male: 0.4, female: 0.6 },
  ageGroups: [
    { group: '25–34', share: 0.55 },
    { group: '35–44', share: 0.45 },
  ],
  goals: ['order groceries on a phone'],
  devices: [
    { class: 'mobile', share: 0.72 },
    { class: 'desktop', share: 0.28 },
  ],
  techSavviness: 0.55,
  priceSensitivity: 0.8,
  size: 100,
} as const;

const reply = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...DESCRIBED, ...overrides });

/** The same reply with one field taken off altogether. */
const replyWithout = (field: keyof typeof DESCRIBED): string => {
  const { [field]: dropped, ...rest } = DESCRIBED;
  void dropped;
  return JSON.stringify(rest);
};

const refusalOf = async (promise: Promise<unknown>): Promise<WonderReplyError> => {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(WonderReplyError);
  return error as WonderReplyError;
};

/** The model implementation, answering one recorded reply. */
const throughModel = (replyText: string, usage: unknown = FAKE_TOKENS) =>
  createMetaWonderProvider({
    env: TEST_ENV,
    transport: fakeTransport({ replyText: () => replyText, usage }).transport,
  });

const asked = (replyText: string, given: AudienceAskInput = input()): Promise<unknown> =>
  writeAudience(throughModel(replyText), given);

const offline = async (given: AudienceAskInput = input()): Promise<Audience> =>
  (await writeAudience(createOfflineWonderProvider(), given)).value;

const sumOf = (shares: readonly number[]): number =>
  shares.reduce((total, share) => total + share, 0);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the ask one audience is written through', () => {
  it('is the audience use, at the effort the live call was answered at', () => {
    const ask = audienceAsk(input());

    expect(ask.use).toBe('audience');
    expect(ask.effort).toBe(AUDIENCE_EFFORT);
    expect(AUDIENCE_EFFORT).toBe('minimal');
    expect(ask.replySchema.name).toBe(AUDIENCE_REPLY_SCHEMA_NAME);
    expect(ask.seed).toBe(7);
  });

  it('asks for the contract’s own fields, in the strict subset the protocol requires', () => {
    const schema = audienceAsk(input()).replySchema.schema as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;

    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$schema).toBeUndefined();
    // Every key of `properties` in `required`, which is what `strict: true` validates
    // against (`docs/meta-model-api.md`) — the three fields the artifact leaves optional
    // included, because an audience out of Wonder states all three.
    expect(schema.required).toEqual(Object.keys(properties));
    expect(schema.required).toContain('languages');
    expect(schema.required).toContain('genderSplit');
    expect(schema.required).toContain('ageGroups');
    // The two fields that are the caller's are not the model's to write.
    expect(properties.id).toBeUndefined();
    expect(properties.generatedFrom).toBeUndefined();
    // The brackets come from `audienceSchema`'s own enumeration rather than from a list
    // restated here.
    const brackets = properties.ageGroups.items as Record<string, Record<string, unknown>>;
    const group = brackets.properties.group as Record<string, unknown>;
    expect(group.enum).toEqual(['18–24', '25–34', '35–44', '45–54', '55–64', '65+']);
  });

  it('closes the device mix to the classes it was given, and asks for no viewport', () => {
    const schema = audienceAsk(input()).replySchema.schema as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const device = properties.devices.items as Record<string, unknown> as Record<
      string,
      Record<string, Record<string, unknown>>
    >;

    expect(Object.keys(device.properties)).toEqual(['class', 'share']);
    expect(device.properties.class.enum).toEqual(['mobile', 'desktop', 'tablet']);
  });

  it('refuses to be built with no sentence, or with no device class to be a mix of', () => {
    expect(() => audienceAsk(input({ sentence: '   ' }))).toThrow(/sentence/);
    expect(() => audienceAsk(input({ deviceClasses: [] }))).toThrow(/device class/);
  });

  it('shows the model the sentence and the class names, and never a viewport', () => {
    const document = audienceAsk(input()).document;

    expect(document).toContain(SENTENCE);
    expect(document).toContain('"mobile"');
    expect(document).toContain('25–34');
    expect(document).toContain(String(DEFAULT_AUDIENCE_SIZE));
    // A class is a word here, and the geometry behind it is this file's: a model shown a
    // viewport is a model that can invent one, which is the failure the live change call
    // produced.
    expect(document).not.toContain('390');
    expect(document).not.toContain('844');
    expect(document).toContain('do not describe a screen, a viewport or a model of phone');
  });
});

describe('one audience, offline', () => {
  it('answers an audience the contract accepts, with no key and no network', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('the offline audience reaches no network');
    });

    const { value, model, usage } = await writeAudience(createOfflineWonderProvider(), input());

    expect(() => audienceSchema.parse(value)).not.toThrow();
    expect(model).toBeNull();
    expect(usage.estimatedCostUsd).toBe(0);
    expect(value.id).toBe('A-01');
    expect(value.size).toBe(DEFAULT_AUDIENCE_SIZE);
    expect(value.generatedFrom).toEqual({ seed: 7, generatorVersion: 'persona-gen-1' });
  });

  it('gives the same audience twice for the same sentence and the same seed, field for field', async () => {
    expect(await offline()).toEqual(await offline());

    // A fresh provider, and a provider that has already answered, answer alike: the seed is
    // on the ask and nothing is kept between calls.
    const provider = createOfflineWonderProvider();
    await writeAudience(provider, input({ sentence: 'students who read reviews', seed: 99 }));
    expect((await writeAudience(provider, input())).value).toEqual(await offline());
  });

  it('gives a different audience for a different sentence on the same seed', async () => {
    const other = await offline(input({ sentence: 'retired men in Astana who use a laptop' }));

    expect(other).not.toEqual(await offline());
    expect(other.regions).toEqual(['Astana']);
    // The sentence names a laptop, so the majority of the audience is on the desktop class.
    expect([...other.devices].sort((a, b) => b.share - a.share)[0].name).toBe('desktop');
  });

  it('takes the role, the place and what they are doing out of the sentence itself', async () => {
    const value = await offline();

    expect(value.name).toBe('Busy parents');
    expect(value.roles).toEqual(['busy parents']);
    expect(value.regions).toEqual(['Almaty']);
    expect(value.goals).toEqual(['shop on their phones']);
    expect([...value.devices].sort((a, b) => b.share - a.share)[0].name).toBe('mobile');
  });

  it('states the three fields the artifact leaves optional, as distributions', async () => {
    const value = await offline();

    expect(value.languages?.length).toBeGreaterThan(0);
    expect(sumOf([value.genderSplit?.male ?? 0, value.genderSplit?.female ?? 0])).toBeCloseTo(
      1,
      10,
    );
    expect(sumOf((value.ageGroups ?? []).map((group) => group.share))).toBeCloseTo(1, 10);
    expect(sumOf(value.devices.map((device) => device.share))).toBeCloseTo(1, 10);
  });

  it('answers in the class geometry it was offered, for every sentence a seed can reach', async () => {
    // The age brackets are the seed's, and the open `65+` bracket has no measured end to
    // derive an age range from: every seed has to produce an audience the contract accepts.
    for (let seed = 0; seed < 40; seed += 1) {
      const value = await offline(input({ seed }));
      expect(() => audienceSchema.parse(value)).not.toThrow();
      for (const device of value.devices) {
        expect(AUDIENCE_DEVICE_CLASSES.map((offered) => offered.name)).toContain(device.name);
      }
    }
  });
});

describe('a reply that is not an audience', () => {
  it('refuses a missing field with the path named, rather than filling it in', async () => {
    const error = await refusalOf(asked(replyWithout('languages')));

    expect(error.paths).toContain('languages');
    expect(error.message).not.toContain('English');
  });

  it('refuses a missing scale and a missing size in the same reply, each at its path', async () => {
    const { techSavviness, size, ...rest } = DESCRIBED;
    void techSavviness;
    void size;

    const error = await refusalOf(asked(JSON.stringify(rest)));

    expect(error.paths).toContain('techSavviness');
    expect(error.paths).toContain('size');
  });

  it('refuses a field carrying the wrong type, at its path', async () => {
    const error = await refusalOf(asked(reply({ techSavviness: 'high', size: '100' })));

    expect(error.paths).toContain('techSavviness');
    expect(error.paths).toContain('size');
  });

  it('refuses a device class it was never offered, with the path named', async () => {
    const error = await refusalOf(asked(reply({ devices: [{ class: 'smart fridge', share: 1 }] })));

    expect(error.paths).toContain('devices[0].class');
  });

  it('refuses a reply that is not an object at all', async () => {
    const error = await refusalOf(asked(JSON.stringify('busy parents, but as prose')));

    expect(error.message).toContain('the reply itself');
  });

  it('refuses an age range the brackets do not derive to, with the path named', async () => {
    const error = await refusalOf(asked(reply({ ageRange: { min: 18, max: 80 } })));

    expect(error.paths).toContain('ageGroups');
    expect(error.message).toContain('derived');
  });

  it('refuses a reply that states no gender split, at its path', async () => {
    const error = await refusalOf(asked(replyWithout('genderSplit')));

    expect(error.paths).toContain('genderSplit');
    expect(error.message).toContain('expected object');
  });

  it('refuses an audience-shaped reply the artifact itself would accept', async () => {
    // `genderSplit`, `languages` and `ageGroups` are optional on `audienceSchema` — an
    // audience described before they existed carries none — so this reply passes the
    // artifact's own schema. An audience written from a sentence states all three, and the
    // one thing this use may not do is fill one in itself.
    const whole = await offline();
    const { genderSplit, ...half } = whole;
    void genderSplit;

    expect(() => audienceSchema.parse(half)).not.toThrow();
    const error = await refusalOf(asked(JSON.stringify(half)));

    expect(error.paths).toContain('genderSplit');
    expect(error.message).toContain('states no genderSplit');
  });
});

describe('shares that are a hair off one, and shares that are not a distribution', () => {
  it('is a tolerance of half a percentage point per share', () => {
    expect(SHARE_ROUNDING_TOLERANCE).toBe(0.005);
  });

  it('scales three brackets written to two decimals into a distribution', async () => {
    // 0.33 three times is 0.99, which is what two decimals costs and not a different
    // audience: 3 × 0.005 = 0.015 of room, and the ratios the reply chose are kept.
    const { value } = (await asked(
      reply({
        ageRange: { min: 25, max: 54 },
        ageGroups: [
          { group: '25–34', share: 0.33 },
          { group: '35–44', share: 0.33 },
          { group: '45–54', share: 0.33 },
        ],
      }),
    )) as { value: Audience };

    const shares = (value.ageGroups ?? []).map((group) => group.share);
    expect(sumOf(shares)).toBeCloseTo(1, 12);
    expect(shares[0]).toBeCloseTo(1 / 3, 12);
    expect(shares[1]).toBeCloseTo(shares[2], 12);
  });

  it('scales a device mix and a gender split that each miss one by a hair', async () => {
    const { value } = (await asked(
      reply({
        devices: [
          { class: 'mobile', share: 0.715 },
          { class: 'desktop', share: 0.28 },
        ],
        genderSplit: { male: 0.4, female: 0.595 },
      }),
    )) as { value: Audience };

    expect(sumOf(value.devices.map((device) => device.share))).toBeCloseTo(1, 12);
    expect(sumOf([value.genderSplit?.male ?? 0, value.genderSplit?.female ?? 0])).toBeCloseTo(
      1,
      12,
    );
    // Scaled, not rewritten: the mix is still the ratio the reply chose.
    expect(value.devices[0].share / value.devices[1].share).toBeCloseTo(0.715 / 0.28, 10);
  });

  it('refuses a device mix that is not a distribution, with the sum named', async () => {
    const error = await refusalOf(
      asked(
        reply({
          devices: [
            { class: 'mobile', share: 0.5 },
            { class: 'desktop', share: 0.3 },
          ],
        }),
      ),
    );

    expect(error.paths).toContain('devices');
    expect(error.message).toContain('0.8');
    expect(error.message).toContain('refused rather than normalised');
  });

  it('refuses shares just past the band rather than scaling them', async () => {
    // Two shares have 2 × 0.005 = 0.01 of room. These sum to 0.98.
    const error = await refusalOf(
      asked(
        reply({
          ageGroups: [
            { group: '25–34', share: 0.55 },
            { group: '35–44', share: 0.43 },
          ],
        }),
      ),
    );

    expect(error.paths).toContain('ageGroups');
    expect(error.message).toContain('0.98');
    expect(error.message).toContain('0.01');
  });

  it('refuses a gender split that is not a distribution', async () => {
    const error = await refusalOf(asked(reply({ genderSplit: { male: 0.3, female: 0.3 } })));

    expect(error.paths).toContain('genderSplit');
    expect(error.message).toContain('0.6');
  });
});

describe('the same audience through the model implementation', () => {
  it('reads the documented envelope into the audience, and counts what it cost', async () => {
    const { value, model, usage } = await writeAudience(throughModel(reply()), input());

    expect(() => audienceSchema.parse(value)).not.toThrow();
    expect(value.name).toBe('Busy parents in Almaty');
    expect(value.languages).toEqual(['Russian', 'Kazakh']);
    expect(value.size).toBe(100);
    expect(value.generatedFrom).toEqual({ seed: 7, generatorVersion: 'persona-gen-1' });
    expect(model).toEqual({ mode: WONDER_PROVIDER_MODE, modelId: WONDER_MODEL_ID });

    const tokens = {
      inputTokens: FAKE_TOKENS.input_tokens,
      cachedInputTokens: FAKE_TOKENS.input_tokens_details.cached_tokens,
      outputTokens: FAKE_TOKENS.output_tokens,
      reasoningTokens: FAKE_TOKENS.output_tokens_details.reasoning_tokens,
    };
    expect(usage).toEqual({
      ...tokens,
      estimatedCostUsd: estimateCostUsd(WONDER_MODEL_ID, tokens),
    });
    expect(usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('expands the class the model named into the geometry it was offered under', async () => {
    const { value } = await writeAudience(throughModel(reply()), input());

    expect(value.devices.map((device) => device.name)).toEqual(['mobile', 'desktop']);
    expect(value.devices[0]).toEqual({ ...AUDIENCE_DEVICE_CLASSES[0], share: 0.72 });
    expect(value.devices[1].viewport).toEqual(AUDIENCE_DEVICE_CLASSES[1].viewport);
  });

  it('expands a class the caller handed in rather than one of its own', async () => {
    const watch = {
      name: 'watch',
      viewport: { width: 396, height: 484 },
      deviceScaleFactor: 2,
      touch: true,
    };

    const { value } = await writeAudience(
      throughModel(reply({ devices: [{ class: 'watch', share: 1 }] })),
      input({ deviceClasses: [watch] }),
    );

    expect(value.devices).toEqual([{ ...watch, share: 1 }]);
  });

  it('is the call the package index publishes', async () => {
    const { value } = await writeAudienceFromIndex(throughModel(reply()), input());

    expect(value.id).toBe('A-01');
  });
});
