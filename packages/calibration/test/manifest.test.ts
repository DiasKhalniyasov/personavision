import { describe, expect, it } from 'vitest';
import {
  ManifestError,
  describeChecksum,
  loadManifest,
  parseManifest,
  recordedChecksum,
  unverifiedFiles,
} from '../src/dataset/manifest.js';
import { RECORD_CATEGORIES, VIEWING_DURATIONS_SECONDS } from '../src/types.js';
import committed from '../src/dataset/manifest.json' with { type: 'json' };

/** The committed manifest as plain data, so a case can break one field and leave the rest. */
const valid = (): Record<string, unknown> => structuredClone(committed) as Record<string, unknown>;

/** Sets `files[0].checksum`, the field most of the checksum cases need. */
const withChecksum = (checksum: unknown): unknown => {
  const manifest = valid();
  (manifest.files as Record<string, unknown>[])[0]!.checksum = checksum;
  return manifest;
};

describe('the committed UEyes manifest', () => {
  it('names the dataset, its scale and the paper it accompanies', () => {
    const { dataset } = loadManifest();

    expect(dataset.name).toBe('UEyes');
    expect(dataset.participants).toBe(62);
    expect(dataset.screenshots).toBe(1980);
    expect(dataset.paper.doi).toBe('10.1145/3544548.3581096');
  });

  it('pins one resolved download location, by version and not by concept DOI', () => {
    const { source, files } = {
      source: loadManifest().dataset.source,
      files: loadManifest().files,
    };

    expect(source.host).toBe('Zenodo');
    expect(source.versionDoi).toBe('10.5281/zenodo.8010312');
    // The concept DOI follows the newest upload; a score has to name the bytes it was
    // measured against, so the version DOI is what this manifest pins.
    expect(source.conceptDoi).not.toBe(source.versionDoi);
    expect(source.resolvedFrom.length).toBeGreaterThan(0);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('UEyes_dataset.zip');
    expect(files[0]!.sizeBytes).toBe(12_912_746_325);
    expect(files[0]!.url.startsWith('https://')).toBe(true);
  });

  it('records the licence, what it requires and what it forbids', () => {
    const { licence } = loadManifest().dataset;

    expect(licence.spdxId).toBe('CC-BY-4.0');
    expect(licence.url).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(licence.attribution).toContain('CC BY 4.0');
    expect(licence.requires.length).toBeGreaterThan(0);
    expect(licence.forbids.length).toBeGreaterThan(0);
    expect(licence.notVendoredBecause).not.toBe('');
  });

  it('agrees with the types every later ticket reads: the categories and the viewing durations', () => {
    const { dataset } = loadManifest();

    expect(dataset.categories).toEqual(RECORD_CATEGORIES);
    expect(dataset.viewingDurationsSeconds).toEqual(VIEWING_DURATIONS_SECONDS);
  });

  it('describes the archive layout and says plainly that it is unverified', () => {
    const { layout } = loadManifest();

    // Nothing in this ticket opened the 12.9 GB archive, so the layout is the authors'
    // documentation rather than a reading of the bytes. #85 is the first to know.
    expect(layout.verifiedAgainstArchive).toBe(false);
    expect(layout.entries.map((entry) => entry.path)).toContain('images');
    expect(layout.entries.map((entry) => entry.path)).toContain('scanpaths/paths_7s');
    expect(layout.entries.map((entry) => entry.path)).toContain('info.csv');
  });

  it('carries a checksum shaped as the algorithm it names', () => {
    const checksum = recordedChecksum(loadManifest().files[0]!);

    expect(checksum).not.toBeNull();
    expect(checksum!.algorithm).toBe('md5');
    expect(checksum!.value).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is loaded once and returns the same object', () => {
    expect(loadManifest()).toBe(loadManifest());
  });
});

describe('a malformed manifest', () => {
  const cases: readonly { readonly name: string; readonly value: unknown; readonly at: string }[] =
    [
      { name: 'is not an object at all', value: 'UEyes', at: '' },
      { name: 'is null', value: null, at: '' },
      {
        name: 'has no schemaVersion',
        value: (() => {
          const manifest = valid();
          delete manifest.schemaVersion;
          return manifest;
        })(),
        at: 'schemaVersion',
      },
      {
        name: 'was written against a newer schema',
        value: { ...valid(), schemaVersion: 2 },
        at: 'schemaVersion',
      },
      {
        name: 'lists no file to download',
        value: { ...valid(), files: [] },
        at: 'files',
      },
      {
        name: 'gives a file a negative size',
        value: (() => {
          const manifest = valid();
          (manifest.files as Record<string, unknown>[])[0]!.sizeBytes = -1;
          return manifest;
        })(),
        at: 'files[0].sizeBytes',
      },
      {
        name: 'gives a file an absolute path, which would write outside the cache',
        value: (() => {
          const manifest = valid();
          (manifest.files as Record<string, unknown>[])[0]!.path = '/etc/passwd';
          return manifest;
        })(),
        at: 'files[0].path',
      },
      {
        name: 'gives a file a path that climbs out of the cache',
        value: (() => {
          const manifest = valid();
          (manifest.files as Record<string, unknown>[])[0]!.path = '../../UEyes_dataset.zip';
          return manifest;
        })(),
        at: 'files[0].path',
      },
      {
        name: 'would download over plain HTTP',
        value: (() => {
          const manifest = valid();
          (manifest.files as Record<string, unknown>[])[0]!.url =
            'http://zenodo.org/records/8010312';
          return manifest;
        })(),
        at: 'files[0].url',
      },
      {
        name: 'names a checksum algorithm nothing can compute',
        value: withChecksum({
          state: 'recorded',
          algorithm: 'crc32',
          value: 'deadbeef',
          source: 'publisher-metadata',
          recordedOn: '2026-10-26',
        }),
        at: 'files[0].checksum.algorithm',
      },
      {
        name: 'carries a checksum of the wrong length for its algorithm',
        value: withChecksum({
          state: 'recorded',
          algorithm: 'md5',
          value: 'c2d53e6a',
          source: 'publisher-metadata',
          recordedOn: '2026-10-26',
        }),
        at: 'files[0].checksum.value',
      },
      {
        name: 'carries a checksum in a state that is neither recorded nor unverified',
        value: withChecksum({ state: 'probably-fine' }),
        at: 'files[0].checksum.state',
      },
      {
        name: 'leaves a checksum unverified without saying why',
        value: withChecksum({ state: 'unverified' }),
        at: 'files[0].checksum.reason',
      },
      {
        name: 'claims a checksum came from somewhere unrecognised',
        value: withChecksum({
          state: 'recorded',
          algorithm: 'md5',
          value: 'c2d53e6af0a47e1f459416d6839ec2c1',
          source: 'a colleague said so',
          recordedOn: '2026-10-26',
        }),
        at: 'files[0].checksum.source',
      },
      {
        name: 'has no licence identifier',
        value: (() => {
          const manifest = valid();
          delete (manifest.dataset as Record<string, unknown>).licence;
          return manifest;
        })(),
        at: 'dataset.licence',
      },
      {
        name: 'names a category this project has no word for',
        value: (() => {
          const manifest = valid();
          (manifest.dataset as Record<string, unknown>).categories = ['webpage', 'smartwatch'];
          return manifest;
        })(),
        at: 'dataset.categories[1]',
      },
      {
        name: 'names a viewing duration the dataset does not publish',
        value: (() => {
          const manifest = valid();
          (manifest.dataset as Record<string, unknown>).viewingDurationsSeconds = [1, 5];
          return manifest;
        })(),
        at: 'dataset.viewingDurationsSeconds[1]',
      },
      {
        name: 'describes a layout entry that is neither a file nor a directory',
        value: (() => {
          const manifest = valid();
          (
            (manifest.layout as Record<string, unknown>).entries as Record<string, unknown>[]
          )[0]!.kind = 'symlink';
          return manifest;
        })(),
        at: 'layout.entries[0].kind',
      },
    ];

  it.each(cases)('is rejected at the offending field when it $name', ({ value, at }) => {
    let thrown: unknown;
    try {
      parseManifest(value);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestError);
    expect((thrown as ManifestError).path).toBe(at);
    // The message a person reads has to name the field, not only the rule.
    if (at !== '') expect((thrown as ManifestError).message).toContain(at);
  });

  it('accepts the committed manifest unchanged', () => {
    expect(() => parseManifest(valid())).not.toThrow();
  });
});

describe('an unverified checksum', () => {
  const unverified = withChecksum({
    state: 'unverified',
    reason: 'no copy of the archive has been downloaded yet, so nothing has been computed',
  });

  it('is never reported as a checksum a download could be verified against', () => {
    const manifest = parseManifest(unverified);

    expect(recordedChecksum(manifest.files[0]!)).toBeNull();
  });

  it('is described as unverified, with the reason, and never as valid', () => {
    const description = describeChecksum(parseManifest(unverified).files[0]!);

    expect(description).toContain('unverified');
    expect(description).toContain('no copy of the archive has been downloaded yet');
    expect(description).not.toContain('valid');
  });

  it('is listed among the manifest files a download must refuse by default', () => {
    expect(unverifiedFiles(parseManifest(unverified)).map((file) => file.path)).toEqual([
      'UEyes_dataset.zip',
    ]);
    expect(unverifiedFiles(loadManifest())).toEqual([]);
  });

  it('is distinguished from a recorded one, which says whose claim it is', () => {
    const description = describeChecksum(loadManifest().files[0]!);

    expect(description).toContain('md5');
    expect(description).toContain('c2d53e6af0a47e1f459416d6839ec2c1');
    // The value came from the publisher's record, not from a local computation, and the
    // description says which: #85 is the first ticket able to confirm the bytes.
    expect(description).toContain("the publisher's record");
    expect(description).not.toContain('unverified');
  });
});
