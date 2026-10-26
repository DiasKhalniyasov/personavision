/**
 * The dataset manifest: where UEyes is, what it is made of, what each file's bytes should
 * hash to, and under what licence.
 *
 * `manifest.json` beside this file is the committed data; this module is the only thing that
 * reads it. No later ticket writes a URL, an archive path or a checksum in code: the
 * download (#85), the conversion (#86) and the CLI (#91) all read them from here, so the
 * dataset moving is a reviewable change to one JSON file.
 *
 * The loader validates, because committed data is still data: a hand-edited manifest fails
 * at the field that is wrong, naming it, rather than reaching a downloader as `undefined`.
 */

import {
  RECORD_CATEGORIES,
  VIEWING_DURATIONS_SECONDS,
  type RecordCategory,
  type ViewingDurationSeconds,
} from '../types.js';
import { isContainedRelativePath, isDatasetId } from './cache.js';
import committedManifest from './manifest.json' with { type: 'json' };

/** The schema version this reader understands. A newer manifest is refused, not guessed at. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** The hashes a download can be checked with, and the hex length each one produces. */
const CHECKSUM_HEX_LENGTHS = { md5: 32, sha256: 64 } as const;

export type ChecksumAlgorithm = keyof typeof CHECKSUM_HEX_LENGTHS;

/** Where a recorded checksum's value came from. Neither is a guess; only one is local. */
export type ChecksumSource =
  /** Read from the publisher's own record metadata — their claim about the bytes. */
  | 'publisher-metadata'
  /** Computed from a copy of the file on this machine. */
  | 'local-download';

/** A checksum a download can be verified against. */
export interface RecordedChecksum {
  readonly state: 'recorded';
  readonly algorithm: ChecksumAlgorithm;
  /** Lower-case hex, as long as the algorithm produces. */
  readonly value: string;
  readonly source: ChecksumSource;
  /** `YYYY-MM-DD`. */
  readonly recordedOn: string;
  readonly note?: string;
}

/**
 * No checksum yet, and the reason.
 *
 * An invented checksum is worse than a missing one: it reports a corrupt download as sound.
 * A file in this state is reported as unverified and refused by a download that has not
 * been told to record one (#85).
 */
export interface UnverifiedChecksum {
  readonly state: 'unverified';
  readonly reason: string;
}

export type FileChecksum = RecordedChecksum | UnverifiedChecksum;

/** One file to fetch into the cache. */
export interface ManifestFile {
  /** Where it lands inside the cache, relative and contained — never absolute, never `..`. */
  readonly path: string;
  /** An HTTPS URL. */
  readonly url: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  /** The archive format to unpack, or `null` for a file used as it is. */
  readonly archive: 'zip' | null;
  readonly checksum: FileChecksum;
}

/** The paper the dataset accompanies, so a reported figure can cite it. */
export interface DatasetPaper {
  readonly citation: string;
  readonly doi: string;
  readonly url: string;
}

/** Where the dataset was resolved from, and when. */
export interface DatasetSource {
  readonly host: string;
  readonly recordUrl: string;
  /** The DOI of the one version this manifest pins. */
  readonly versionDoi: string;
  /** The DOI that follows the newest version, recorded so the two are never confused. */
  readonly conceptDoi: string;
  readonly publishedOn: string;
  readonly resolvedOn: string;
  /** The pages the facts above were read from. */
  readonly resolvedFrom: readonly string[];
  readonly note: string;
}

/** The licence, in enough detail that a reader need not go and look it up. */
export interface DatasetLicence {
  readonly spdxId: string;
  readonly name: string;
  readonly url: string;
  /** Where the licence was read from. */
  readonly source: string;
  /** The credit to carry wherever a figure measured on this dataset is published. */
  readonly attribution: string;
  readonly requires: readonly string[];
  readonly forbids: readonly string[];
  /** Why this repository commits no byte of the dataset even so. */
  readonly notVendoredBecause: string;
}

export interface DatasetDescription {
  /** One lower-case word, used as the dataset's directory inside the cache. */
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly participants: number;
  readonly screenshots: number;
  readonly categories: readonly RecordCategory[];
  readonly viewingDurationsSeconds: readonly ViewingDurationSeconds[];
  readonly paper: DatasetPaper;
  readonly source: DatasetSource;
  readonly licence: DatasetLicence;
}

/** One entry of the archive's documented layout. */
export interface LayoutEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly holds: string;
}

/**
 * Where the entries sit inside the archive.
 *
 * `unknown` is a third state rather than an absent prefix, for the reason
 * `UnverifiedChecksum` is not a zeroed hash: "the entries are at the archive root" and
 * "nobody has opened the archive" are different claims, and a reader that cannot tell them
 * apart reports a layout difference for a prefix the manifest never asserted.
 */
export type ArchiveRoot =
  /** The entries sit at the archive root, confirmed. */
  | { readonly state: 'root' }
  /** They sit under this one directory, confirmed. */
  | { readonly state: 'directory'; readonly path: string }
  /** Nobody has looked yet, and why. #85 is the first that can. */
  | { readonly state: 'unknown'; readonly reason: string };

/** What the archive is expected to contain once unpacked. */
export interface ArchiveLayout {
  readonly root: ArchiveRoot;
  /**
   * `false` while the layout is the publisher's documentation rather than a reading of the
   * archive. A download that finds a different tree fails naming the difference (#85).
   */
  readonly verifiedAgainstArchive: boolean;
  readonly note: string;
  readonly entries: readonly LayoutEntry[];
}

export interface DatasetManifest {
  readonly schemaVersion: number;
  readonly dataset: DatasetDescription;
  readonly files: readonly ManifestFile[];
  readonly layout: ArchiveLayout;
}

/** A manifest that does not hold together, with the field that does not. */
export class ManifestError extends Error {
  /** `files[0].checksum.algorithm` — empty for a defect in the manifest as a whole. */
  readonly path: string;

  constructor(path: string, expectation: string) {
    super(
      path === ''
        ? `the dataset manifest is malformed: ${expectation}`
        : `the dataset manifest is malformed at ${path}: ${expectation}`,
    );
    this.name = 'ManifestError';
    this.path = path;
  }
}

const fail = (path: string, expectation: string): never => {
  throw new ManifestError(path, expectation);
};

const asObject = (value: unknown, path: string): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(path, 'expected an object');

const asText = (value: unknown, path: string): string =>
  typeof value === 'string' && value.trim() !== ''
    ? value
    : fail(path, 'expected a non-empty string');

const asBoolean = (value: unknown, path: string): boolean =>
  typeof value === 'boolean' ? value : fail(path, 'expected true or false');

const asCount = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : fail(path, 'expected a whole number of zero or more');

const asList = (value: unknown, path: string, least: number): readonly unknown[] =>
  Array.isArray(value) && value.length >= least
    ? value
    : fail(path, `expected a list of at least ${least}`);

const asOneOf = <T extends string | number>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T =>
  (allowed as readonly unknown[]).includes(value)
    ? (value as T)
    : fail(path, `expected one of ${allowed.map((option) => JSON.stringify(option)).join(', ')}`);

const asDate = (value: unknown, path: string): string => {
  const text = asText(value, path);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text))
    ? text
    : fail(path, 'expected a date as YYYY-MM-DD');
};

const asHttpsUrl = (value: unknown, path: string): string => {
  const text = asText(value, path);
  if (!text.startsWith('https://')) {
    return fail(path, 'expected an https:// URL — a dataset is not fetched over plain HTTP');
  }
  return URL.canParse(text) ? text : fail(path, 'expected a URL that parses');
};

const asTextList = (value: unknown, path: string, least: number): readonly string[] =>
  asList(value, path, least).map((entry, position) => asText(entry, `${path}[${position}]`));

const asCachePath = (value: unknown, path: string): string => {
  const text = asText(value, path);
  return isContainedRelativePath(text)
    ? text
    : fail(
        path,
        'expected a relative path inside the cache: an absolute path or a `..` segment would write outside it',
      );
};

const parseChecksum = (value: unknown, path: string): FileChecksum => {
  const checksum = asObject(value, path);
  const state = asOneOf(checksum.state, `${path}.state`, ['recorded', 'unverified'] as const);

  if (state === 'unverified') {
    return {
      state,
      reason: asText(checksum.reason, `${path}.reason`),
    };
  }

  const algorithm = asOneOf(
    checksum.algorithm,
    `${path}.algorithm`,
    Object.keys(CHECKSUM_HEX_LENGTHS) as ChecksumAlgorithm[],
  );
  const hexLength = CHECKSUM_HEX_LENGTHS[algorithm];
  const digest = asText(checksum.value, `${path}.value`);
  if (!new RegExp(`^[0-9a-f]{${hexLength}}$`).test(digest)) {
    fail(`${path}.value`, `expected ${hexLength} lower-case hex characters for ${algorithm}`);
  }

  const recorded: RecordedChecksum = {
    state,
    algorithm,
    value: digest,
    source: asOneOf(checksum.source, `${path}.source`, [
      'publisher-metadata',
      'local-download',
    ] as const),
    recordedOn: asDate(checksum.recordedOn, `${path}.recordedOn`),
  };
  return checksum.note === undefined
    ? recorded
    : { ...recorded, note: asText(checksum.note, `${path}.note`) };
};

const parseFile = (value: unknown, path: string): ManifestFile => {
  const file = asObject(value, path);
  const sizeBytes = asCount(file.sizeBytes, `${path}.sizeBytes`);
  if (sizeBytes === 0) fail(`${path}.sizeBytes`, 'expected more than zero bytes');

  return {
    path: asCachePath(file.path, `${path}.path`),
    url: asHttpsUrl(file.url, `${path}.url`),
    sizeBytes,
    mediaType: asText(file.mediaType, `${path}.mediaType`),
    archive:
      file.archive === null ? null : asOneOf(file.archive, `${path}.archive`, ['zip'] as const),
    checksum: parseChecksum(file.checksum, `${path}.checksum`),
  };
};

const parseLicence = (value: unknown, path: string): DatasetLicence => {
  const licence = asObject(value, path);
  return {
    spdxId: asText(licence.spdxId, `${path}.spdxId`),
    name: asText(licence.name, `${path}.name`),
    url: asHttpsUrl(licence.url, `${path}.url`),
    source: asText(licence.source, `${path}.source`),
    attribution: asText(licence.attribution, `${path}.attribution`),
    requires: asTextList(licence.requires, `${path}.requires`, 1),
    forbids: asTextList(licence.forbids, `${path}.forbids`, 1),
    notVendoredBecause: asText(licence.notVendoredBecause, `${path}.notVendoredBecause`),
  };
};

const parseSource = (value: unknown, path: string): DatasetSource => {
  const source = asObject(value, path);
  return {
    host: asText(source.host, `${path}.host`),
    recordUrl: asHttpsUrl(source.recordUrl, `${path}.recordUrl`),
    versionDoi: asText(source.versionDoi, `${path}.versionDoi`),
    conceptDoi: asText(source.conceptDoi, `${path}.conceptDoi`),
    publishedOn: asDate(source.publishedOn, `${path}.publishedOn`),
    resolvedOn: asDate(source.resolvedOn, `${path}.resolvedOn`),
    resolvedFrom: asTextList(source.resolvedFrom, `${path}.resolvedFrom`, 1),
    note: asText(source.note, `${path}.note`),
  };
};

const parseDataset = (value: unknown, path: string): DatasetDescription => {
  const dataset = asObject(value, path);
  const paper = asObject(dataset.paper, `${path}.paper`);
  const id = asText(dataset.id, `${path}.id`);
  if (!isDatasetId(id)) {
    fail(`${path}.id`, 'expected lower-case letters, digits and hyphens: it names a directory');
  }

  return {
    id,
    name: asText(dataset.name, `${path}.name`),
    title: asText(dataset.title, `${path}.title`),
    participants: asCount(dataset.participants, `${path}.participants`),
    screenshots: asCount(dataset.screenshots, `${path}.screenshots`),
    categories: asList(dataset.categories, `${path}.categories`, 1).map((entry, position) =>
      asOneOf(entry, `${path}.categories[${position}]`, RECORD_CATEGORIES),
    ),
    viewingDurationsSeconds: asList(
      dataset.viewingDurationsSeconds,
      `${path}.viewingDurationsSeconds`,
      1,
    ).map((entry, position) =>
      asOneOf(entry, `${path}.viewingDurationsSeconds[${position}]`, VIEWING_DURATIONS_SECONDS),
    ),
    paper: {
      citation: asText(paper.citation, `${path}.paper.citation`),
      doi: asText(paper.doi, `${path}.paper.doi`),
      url: asHttpsUrl(paper.url, `${path}.paper.url`),
    },
    source: parseSource(dataset.source, `${path}.source`),
    licence: parseLicence(dataset.licence, `${path}.licence`),
  };
};

const parseArchiveRoot = (value: unknown, path: string): ArchiveRoot => {
  const root = asObject(value, path);
  const state = asOneOf(root.state, `${path}.state`, ['root', 'directory', 'unknown'] as const);

  if (state === 'directory') return { state, path: asCachePath(root.path, `${path}.path`) };
  if (state === 'unknown') return { state, reason: asText(root.reason, `${path}.reason`) };
  return { state };
};

const parseLayout = (value: unknown, path: string): ArchiveLayout => {
  const layout = asObject(value, path);
  const entries = asList(layout.entries, `${path}.entries`, 1).map((entry, position) => {
    const at = `${path}.entries[${position}]`;
    const item = asObject(entry, at);
    return {
      path: asCachePath(item.path, `${at}.path`),
      kind: asOneOf(item.kind, `${at}.kind`, ['file', 'directory'] as const),
      holds: asText(item.holds, `${at}.holds`),
    };
  });

  // The entries describe one tree, so they have to be able to be one: #85 compares the
  // extracted archive against them, and a layout no archive could hold would have it report
  // a difference whose cause is this file rather than the download.
  const duplicate = entries.find(
    (entry, position) => entries.findIndex((other) => other.path === entry.path) !== position,
  );
  if (duplicate !== undefined) {
    fail(`${path}.entries`, `two entries describe the same path: ${duplicate.path}`);
  }

  const files = new Set(entries.filter((entry) => entry.kind === 'file').map(({ path }) => path));
  const nested = entries.find((entry) => {
    const segments = entry.path.split('/');
    return segments
      .slice(0, -1)
      .some((_, depth) => files.has(segments.slice(0, depth + 1).join('/')));
  });
  if (nested !== undefined) {
    fail(`${path}.entries`, `${nested.path} is nested under an entry declared a file`);
  }

  return {
    root: parseArchiveRoot(layout.root, `${path}.root`),
    verifiedAgainstArchive: asBoolean(
      layout.verifiedAgainstArchive,
      `${path}.verifiedAgainstArchive`,
    ),
    note: asText(layout.note, `${path}.note`),
    entries,
  };
};

/**
 * Validates a manifest, whatever its origin, and returns it typed.
 *
 * Throws a `ManifestError` naming the offending field at the first defect — one defect at a
 * time, because a manifest is hand-edited and the first thing wrong is the thing to fix.
 */
export const parseManifest = (value: unknown): DatasetManifest => {
  const manifest = asObject(value, '');
  const schemaVersion = asCount(manifest.schemaVersion, 'schemaVersion');
  if (schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(
      'schemaVersion',
      `expected ${MANIFEST_SCHEMA_VERSION}: this reader does not understand version ${schemaVersion}`,
    );
  }

  const files = asList(manifest.files, 'files', 1).map((file, position) =>
    parseFile(file, `files[${position}]`),
  );
  const duplicate = files.find(
    (file, position) => files.findIndex((other) => other.path === file.path) !== position,
  );
  if (duplicate !== undefined) {
    fail('files', `two files land on the same cache path: ${duplicate.path}`);
  }

  return {
    schemaVersion,
    dataset: parseDataset(manifest.dataset, 'dataset'),
    files,
    layout: parseLayout(manifest.layout, 'layout'),
  };
};

/** `readonly` is a compile-time promise only, and this object graph is shared. */
const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as object)) deepFreeze(child);
  return Object.freeze(value);
};

let loaded: DatasetManifest | undefined;

/**
 * The committed manifest, validated once.
 *
 * Pure: the manifest is a build-time import, so nothing here reads the filesystem or the
 * network, and a malformed committed manifest fails the first test that loads it.
 *
 * Every caller is handed the **same frozen** object. Frozen because they share it: #85
 * writing a confirmed checksum back onto `files[0].checksum` would otherwise change what
 * #86 and the CLI read, in-process and with no validation pass. Recording a checksum is an
 * edit to `manifest.json`, reviewed like any other.
 */
export const loadManifest = (): DatasetManifest =>
  (loaded ??= deepFreeze(parseManifest(committedManifest)));

/**
 * The checksum a download can be verified against, or `null` when there is none.
 *
 * `null` is the whole point: an unverified file has no checksum, and a caller that wants one
 * has to handle its absence rather than receive something that looks like a hash.
 */
export const recordedChecksum = (file: ManifestFile): RecordedChecksum | null =>
  file.checksum.state === 'recorded' ? file.checksum : null;

/** The files whose checksum is unverified — the ones a download refuses by default (#85). */
export const unverifiedFiles = (manifest: DatasetManifest): readonly ManifestFile[] =>
  manifest.files.filter((file) => file.checksum.state === 'unverified');

/** One line about a file's checksum, for a person reading a download's progress. */
export const describeChecksum = (file: ManifestFile): string => {
  const { checksum } = file;
  if (checksum.state === 'unverified') {
    return `unverified — ${checksum.reason}`;
  }
  const provenance =
    checksum.source === 'publisher-metadata'
      ? "from the publisher's record, not computed from a local copy"
      : 'from a local copy of the file';
  return `${checksum.algorithm} ${checksum.value} — recorded on ${checksum.recordedOn} ${provenance}`;
};
