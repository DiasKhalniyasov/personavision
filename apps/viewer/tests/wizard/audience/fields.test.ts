import { describe, expect, it } from 'vitest';
import {
  audienceWithEdits,
  byField,
  FIELD_KEYS,
  FIELD_LABELS,
  TECH_CHOICES,
  textsOf,
} from '../../../src/screens/newtest/wizard/audience/fields';
import { FIRST_TIME_CREATORS } from './fixture';
import type { Audience } from '@personavision/contract';
import type { FieldTexts } from '../../../src/screens/newtest/wizard/audience/fields';

/**
 * The six fields of *"What we read from that sentence"*, read off the audience and read back.
 *
 * What is asserted here is the conversion alone — the screen that renders it is
 * `audience.test.tsx`'s. The audience under test is `#screen-newtest-feature`'s own, so the
 * lines these assertions expect are the lines the prototype draws.
 */

const texts = (over: Partial<FieldTexts> = {}): FieldTexts => ({
  ...textsOf(FIRST_TIME_CREATORS),
  ...over,
});

const edited = (over: Partial<FieldTexts>): Audience => {
  const result = audienceWithEdits(FIRST_TIME_CREATORS, texts(over));
  if (!result.ok) throw new Error(`refused: ${result.issues.map((i) => i.message).join('; ')}`);
  return result.audience;
};

const refusedAt = (over: Partial<FieldTexts>): readonly string[] => {
  const result = audienceWithEdits(FIRST_TIME_CREATORS, texts(over));
  if (result.ok) throw new Error('that edit was accepted');
  return result.issues.map((issue) => issue.path);
};

describe('the six lines', () => {
  it('is one line per field, in the prototype’s order and its labels', () => {
    expect([...FIELD_KEYS]).toEqual(['size', 'age', 'gender', 'region', 'devices', 'tech']);
    expect(FIELD_KEYS.map((key) => FIELD_LABELS[key])).toEqual([
      'Participants',
      'Age groups',
      'Gender split',
      'Region and language',
      'Device mix',
      'How tech-confident',
    ]);
  });

  it('reads the audience the way `#screen-newtest-feature` prints it', () => {
    expect(textsOf(FIRST_TIME_CREATORS)).toEqual({
      size: '100',
      age: '18–24 30% · 25–34 45% · 35–44 25%',
      gender: '54% female · 46% male',
      region: 'Kazakhstan, Uzbekistan · Russian, Kazakh, English',
      devices: '72% mobile · 28% desktop',
      tech: 'not very tech-confident',
    });
  });

  it('says so in the audience’s own word when a field declares nothing', () => {
    const { genderSplit, languages, ...rest } = FIRST_TIME_CREATORS;
    void genderSplit;
    void languages;

    expect(textsOf(rest).gender).toBe('—');
    expect(textsOf(rest).region).toBe('Kazakhstan, Uzbekistan · —');
  });

  it('prints the range alone for an audience that declares no brackets', () => {
    const { ageGroups, ...rest } = FIRST_TIME_CREATORS;
    void ageGroups;

    expect(textsOf(rest).age).toBe('18–44');
  });
});

describe('an edit to one line', () => {
  it('changes that field and leaves every other one exactly as it was', () => {
    expect(edited({ size: '40' })).toEqual({ ...FIRST_TIME_CREATORS, size: 40 });
  });

  it('keeps a field nobody touched off the rounding the line it is printed on does', () => {
    // Three brackets at a third each print as 33%; re-reading that text would hand the
    // platform a mix summing to 0.99 and have it refuse an audience nobody edited.
    const thirds: Audience = {
      ...FIRST_TIME_CREATORS,
      ageGroups: [
        { group: '18–24', share: 1 / 3 },
        { group: '25–34', share: 1 / 3 },
        { group: '35–44', share: 1 / 3 },
      ],
    };
    const result = audienceWithEdits(thirds, { ...textsOf(thirds), size: '40' });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.audience.ageGroups : null).toEqual(thirds.ageGroups);
  });

  it('reads the age brackets back, and derives the range from the ones that carry somebody', () => {
    const audience = edited({ age: '25–34 50% · 45–54 50%' });

    expect(audience.ageGroups).toEqual([
      { group: '25–34', share: 0.5 },
      { group: '45–54', share: 0.5 },
    ]);
    expect(audience.ageRange).toEqual({ min: 25, max: 54 });
  });

  it('reads a hyphen as the dash the brackets are named with', () => {
    expect(edited({ age: '18-24 40% · 25-34 60%' }).ageGroups).toEqual([
      { group: '18–24', share: 0.4 },
      { group: '25–34', share: 0.6 },
    ]);
  });

  it('ends the open bracket where it begins, because a range needs a top', () => {
    expect(edited({ age: '55–64 50% · 65+ 50%' }).ageRange).toEqual({ min: 55, max: 65 });
  });

  it('reads the gender split either way round on the line', () => {
    expect(edited({ gender: '40% male · 60% female' }).genderSplit).toEqual({
      male: 0.4,
      female: 0.6,
    });
  });

  it('takes the split away when the line says the audience declares none', () => {
    expect(Object.hasOwn(edited({ gender: '—' }), 'genderSplit')).toBe(false);
  });

  it('splits the regions from the languages at the line’s own divider', () => {
    const audience = edited({ region: 'Kazakhstan · Kazakh' });

    expect(audience.regions).toEqual(['Kazakhstan']);
    expect(audience.languages).toEqual(['Kazakh']);
  });

  it('leaves the language field out rather than empty when none is named', () => {
    const audience = edited({ region: 'Kazakhstan, Georgia · —' });

    expect(audience.regions).toEqual(['Kazakhstan', 'Georgia']);
    expect(Object.hasOwn(audience, 'languages')).toBe(false);
  });

  it('reads a device mix back onto the class geometry, so no viewport is invented', () => {
    expect(edited({ devices: '50% mobile · 50% tablet' }).devices).toEqual([
      {
        name: 'mobile',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        touch: true,
        share: 0.5,
      },
      {
        name: 'tablet',
        viewport: { width: 820, height: 1180 },
        deviceScaleFactor: 2,
        touch: true,
        share: 0.5,
      },
    ]);
  });

  it('reads the prototype’s own word for a phone as the class it means', () => {
    expect(edited({ devices: '100% phone' }).devices.map((device) => device.name)).toEqual([
      'mobile',
    ]);
  });

  it('takes how tech-confident they are from the three answers the field offers', () => {
    expect(TECH_CHOICES.map((choice) => choice.text)).toEqual([
      'not very tech-confident',
      'moderately tech-confident',
      'highly tech-confident',
    ]);
    expect(edited({ tech: 'highly tech-confident' }).techSavviness).toBe(0.9);
  });
});

describe('a line nobody can read', () => {
  it('is refused at the path in the audience it is written on', () => {
    expect(refusedAt({ size: 'a hundred' })).toEqual(['size']);
    expect(refusedAt({ age: 'young people mostly' })).toEqual(['ageGroups']);
    expect(refusedAt({ gender: 'mostly women' })).toEqual(['genderSplit']);
    expect(refusedAt({ devices: 'phones' })).toEqual(['devices']);
    expect(refusedAt({ tech: 'quite good with computers' })).toEqual(['techSavviness']);
  });

  it('names the device classes this audience can be a mix of', () => {
    const result = audienceWithEdits(FIRST_TIME_CREATORS, texts({ devices: '100% fax machine' }));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : (result.issues[0]?.message ?? '')).toContain('mobile, desktop, tablet');
  });

  it('refuses a line that names no device at all rather than storing an empty mix', () => {
    expect(refusedAt({ devices: '—' })).toEqual(['devices']);
  });

  it('does not check a share against one: that is the platform’s word, at the same path', () => {
    // 30 + 30 is not an audience, and it is sent as it was typed so that the refusal the
    // reader gets is the contract's own (decision 22) rather than a second set of words.
    const result = audienceWithEdits(FIRST_TIME_CREATORS, texts({ age: '18–24 30% · 25–34 30%' }));

    expect(result.ok).toBe(true);
    expect(result.ok ? result.audience.ageGroups : null).toEqual([
      { group: '18–24', share: 0.3 },
      { group: '25–34', share: 0.3 },
    ]);
  });
});

describe('where a refusal is rendered', () => {
  it('lands every path either validator reports on one of the six lines', () => {
    expect(
      byField([
        { path: 'size', message: 'a' },
        { path: 'ageGroups', message: 'b' },
        { path: 'ageRange', message: 'c' },
        { path: 'genderSplit', message: 'd' },
        { path: 'regions', message: 'e' },
        { path: 'languages', message: 'f' },
        { path: 'devices', message: 'g' },
        { path: 'techSavviness', message: 'h' },
      ]),
    ).toEqual({
      size: 'a',
      age: 'b',
      gender: 'd',
      region: 'e',
      devices: 'g',
      tech: 'h',
    });
  });

  it('lands a path inside a list on the field that list is', () => {
    expect(
      byField([{ path: 'ageGroups[1].group', message: 'that bracket is not one of six' }]),
    ).toEqual({ age: 'that bracket is not one of six' });
    expect(byField([{ path: 'devices.0.share', message: 'a share is a share' }])).toEqual({
      devices: 'a share is a share',
    });
  });

  it('puts a path no line owns above the card rather than dropping it', () => {
    expect(byField([{ path: 'generatedFrom', message: 'another generator wrote that' }])).toEqual({
      form: 'generatedFrom: another generator wrote that',
    });
  });
});
