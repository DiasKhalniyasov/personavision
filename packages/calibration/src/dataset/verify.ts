/**
 * Checking a downloaded file before anything uses it, and recording what was checked.
 *
 * Three things live here, and they share one rule: **verification never silently passes**.
 *
 * - **The checksum.** A downloaded file is hashed and compared with the manifest's recorded
 *   checksum. A mismatch quarantines the file and names the reason; a file the manifest
 *   records as unverified has nothing to compare against and is reported as unverified
 *   rather than waved through.
 * - **The receipt.** A file that verified leaves a receipt beside it, so a second run can
 *   say "already present" without hashing 12.9 GB again — and so that a file touched since
 *   is hashed afresh rather than trusted on its name.
 * - **The layout.** An archive's real tree is compared with the one the manifest declares,
 *   before a byte is unpacked. A difference is named, not accommodated: the manifest is the
 *   thing to correct.
 *
 * `--record-checksums` also lives here. Recording a checksum is an **edit to
 * `manifest.json`**, reviewed like any other change — `loadManifest()` hands out a frozen
 * graph precisely so that nothing can record one in memory instead.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArchiveEntry } from './archive.js';
import type {
  ArchiveLayout,
  ArchiveRoot,
  ChecksumAlgorithm,
  FileChecksum,
  RecordedChecksum,
} from './manifest.js';

/** A file that cannot be trusted, and why. */
export class VerificationError extends Error {
  /** The manifest path of the file the defect is in. */
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(message);
    this.name = 'VerificationError';
    this.filePath = filePath;
  }
}

/** What hashing a file established. */
export type ChecksumVerdict =
  /** The bytes hash to the checksum the manifest records. */
  | { readonly state: 'verified'; readonly algorithm: ChecksumAlgorithm; readonly value: string }
  /** They hash to something else. The file is quarantined, never reused. */
  | {
      readonly state: 'mismatch';
      readonly algorithm: ChecksumAlgorithm;
      readonly expected: string;
      readonly actual: string;
    }
  /**
   * There is nothing to compare against. Not a pass: the caller refuses the file unless it
   * was asked to record the hash as a reviewable change to the manifest.
   */
  | {
      readonly state: 'unverified';
      readonly algorithm: ChecksumAlgorithm;
      readonly value: string;
      readonly reason: string;
    };

/** The hash used for a file the manifest has no checksum for. */
export const DEFAULT_CHECKSUM_ALGORITHM: ChecksumAlgorithm = 'sha256';

/** Hashes a file in a stream: the archive is 12.9 GB and never fits in memory. */
export const hashFile = async (path: string, algorithm: ChecksumAlgorithm): Promise<string> => {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
};

/** Hashes a file and says what that establishes about it, given what the manifest records. */
export const verifyFile = async (
  path: string,
  checksum: FileChecksum,
): Promise<ChecksumVerdict> => {
  if (checksum.state === 'unverified') {
    const algorithm = DEFAULT_CHECKSUM_ALGORITHM;
    return {
      state: 'unverified',
      algorithm,
      value: await hashFile(path, algorithm),
      reason: checksum.reason,
    };
  }

  const actual = await hashFile(path, checksum.algorithm);
  return actual === checksum.value
    ? { state: 'verified', algorithm: checksum.algorithm, value: actual }
    : { state: 'mismatch', algorithm: checksum.algorithm, expected: checksum.value, actual };
};

/** What a successful verification leaves beside the file it verified. */
export interface VerificationReceipt {
  readonly algorithm: ChecksumAlgorithm;
  readonly value: string;
  readonly sizeBytes: number;
  /** The file's modification time when it was hashed: a file touched since is hashed again. */
  readonly mtimeMs: number;
  /** `YYYY-MM-DD`. */
  readonly verifiedOn: string;
}

const RECEIPT_SUFFIX = '.verified.json';

/** Where a file's receipt sits: beside it, in the downloads directory, never in the tree. */
export const receiptPath = (filePath: string): string => `${filePath}${RECEIPT_SUFFIX}`;

/** Writes the receipt for a file that has just verified. */
export const writeReceipt = async (
  filePath: string,
  receipt: VerificationReceipt,
): Promise<void> => {
  await writeFile(receiptPath(filePath), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
};

/**
 * The receipt beside a file, or `null` when there is none, it is unreadable, or the file has
 * changed since it was written.
 *
 * Deliberately forgiving about *why* it cannot be used: every reason leads to the same
 * place, which is hashing the file again.
 */
export const readReceipt = async (filePath: string): Promise<VerificationReceipt | null> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(receiptPath(filePath), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const receipt = parsed as Partial<VerificationReceipt>;
  if (
    typeof receipt.algorithm !== 'string' ||
    typeof receipt.value !== 'string' ||
    typeof receipt.sizeBytes !== 'number' ||
    typeof receipt.mtimeMs !== 'number' ||
    typeof receipt.verifiedOn !== 'string'
  ) {
    return null;
  }

  try {
    const file = await stat(filePath);
    if (file.size !== receipt.sizeBytes || file.mtimeMs !== receipt.mtimeMs) return null;
  } catch {
    return null;
  }
  return receipt as VerificationReceipt;
};

/**
 * Moves a file that failed its checksum out of the way.
 *
 * Kept rather than deleted — a corrupt 12.9 GB download is evidence, and a person may want
 * to look at it — but moved, so that the next run downloads afresh instead of finding
 * something that merely has the right name. The returned path is named in the failure.
 */
export const quarantineFile = async (
  filePath: string,
  quarantineDirectory: string,
  fileName: string,
  when: Date,
): Promise<string> => {
  await mkdir(quarantineDirectory, { recursive: true });
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  const destination = join(quarantineDirectory, `${fileName.replaceAll('/', '-')}.${stamp}`);
  await rename(filePath, destination);
  return destination;
};

/** What the archive's own directory says about the tree the manifest declares. */
export interface LayoutComparison {
  /**
   * Where the entries really sit, read from the archive. The manifest's `unknown` is not a
   * claim, so resolving it is a fact to record rather than a difference to report.
   */
  readonly root: ArchiveRoot;
  /** One line per way the archive contradicts the manifest. Empty when it does not. */
  readonly differences: readonly string[];
}

/** The most undeclared entries named in a difference before the rest are counted. */
const MOST_NAMED = 8;

const topLevelNames = (paths: readonly string[]): readonly string[] => [
  ...new Set(paths.map((path) => path.split('/')[0] as string)),
];

const resolveRoot = (entries: readonly ArchiveEntry[]): ArchiveRoot => {
  const names = topLevelNames(entries.map((entry) => entry.path));
  const only = names[0];
  if (names.length !== 1 || only === undefined) return { state: 'root' };
  // One top-level name is a wrapping directory only if something sits inside it; an archive
  // of a single file has one top-level name too.
  const wraps = entries.some((entry) => entry.path.startsWith(`${only}/`));
  return wraps ? { state: 'directory', path: only } : { state: 'root' };
};

const describeRoot = (root: ArchiveRoot): string =>
  root.state === 'directory'
    ? `under \`${root.path}/\``
    : root.state === 'root'
      ? 'at the archive root'
      : 'somewhere nobody has looked';

/**
 * Compares the archive's real tree with the layout the manifest declares.
 *
 * Called with the central directory alone, before anything is unpacked, so that an archive
 * that contradicts the manifest leaves no half-extracted tree behind. A directory counts as
 * present when anything sits inside it: a zip need not carry an entry for a directory whose
 * children it already lists.
 */
export const compareArchiveLayout = (
  layout: ArchiveLayout,
  entries: readonly ArchiveEntry[],
): LayoutComparison => {
  const root = resolveRoot(entries);
  const prefix = root.state === 'directory' ? `${root.path}/` : '';
  const inside = entries
    .filter((entry) => entry.path.startsWith(prefix) && entry.path !== prefix.slice(0, -1))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));

  const differences: string[] = [];

  if (layout.root.state !== 'unknown') {
    const declared = describeRoot(layout.root);
    const found = describeRoot(root);
    if (declared !== found) {
      differences.push(
        `the manifest says the entries sit ${declared}; the archive has them ${found}`,
      );
    }
  }

  for (const declared of layout.entries) {
    const exact = inside.find((entry) => entry.path === declared.path);
    const children = inside.filter((entry) => entry.path.startsWith(`${declared.path}/`));

    if (exact === undefined && children.length === 0) {
      differences.push(
        `the manifest declares \`${declared.path}\` and the archive has no such ${declared.kind}`,
      );
      continue;
    }
    const kind = exact?.kind ?? 'directory';
    const reallyDirectory = kind === 'directory' || children.length > 0;
    if (declared.kind === 'directory' && !reallyDirectory) {
      differences.push(`the manifest declares \`${declared.path}\` a directory; it is a file`);
    }
    if (declared.kind === 'file' && reallyDirectory) {
      differences.push(`the manifest declares \`${declared.path}\` a file; it is a directory`);
    }
  }

  const declaredPaths = layout.entries.map((entry) => entry.path);
  const covered = (path: string): boolean =>
    layout.entries.some(
      (declared) =>
        declared.path === path ||
        (declared.kind === 'directory' && path.startsWith(`${declared.path}/`)),
    ) ||
    // An ancestor of a declared entry is the tree holding it, not an extra: the manifest
    // declares `saliency_maps/fixmaps_1s` without declaring `saliency_maps`.
    declaredPaths.some((declared) => declared.startsWith(`${path}/`));

  /** The shallowest part of a path that the manifest does not account for. */
  const firstUndeclared = (path: string): string => {
    const segments = path.split('/');
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const prefix = segments.slice(0, depth).join('/');
      if (!covered(prefix)) return prefix;
    }
    return path;
  };

  const undeclared = [
    ...new Set(
      inside.filter((entry) => !covered(entry.path)).map((entry) => firstUndeclared(entry.path)),
    ),
  ];

  if (undeclared.length > 0) {
    const named = undeclared.slice(0, MOST_NAMED).map((path) => `\`${path}\``);
    const rest = undeclared.length - named.length;
    differences.push(
      `the archive holds ${undeclared.length} entr${undeclared.length === 1 ? 'y' : 'ies'} the manifest does not declare: ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`,
    );
  }

  return { root, differences };
};

/**
 * Prints a JSON document the way this repository's formatter does, so that a recorded
 * checksum is a one-field change in a pull request and not a reformatting of the file.
 *
 * The rule is the formatter's own: a value goes on one line when it fits inside the print
 * width at the column it starts at, and is broken across lines when it does not.
 * `test/fetch.test.ts` holds the committed manifest to it, so a change of formatter is a
 * failing test rather than a surprising diff.
 */
export const formatJsonDocument = (value: unknown, printWidth = 100): string =>
  `${renderJson(value, 0, 0, 0, printWidth)}\n`;

const compactJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.map(compactJson).join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const pairs = Object.entries(value).map(
      ([key, entry]) => `${JSON.stringify(key)}: ${compactJson(entry)}`,
    );
    return pairs.length === 0 ? '{}' : `{ ${pairs.join(', ')} }`;
  }
  return JSON.stringify(value) ?? 'null';
};

const renderJson = (
  value: unknown,
  indent: number,
  column: number,
  tail: number,
  printWidth: number,
): string => {
  const pad = ' '.repeat(indent);
  const inline = compactJson(value);
  if (column + inline.length + tail <= printWidth) return inline;

  if (Array.isArray(value)) {
    const lines = value.map((entry, position) => {
      const comma = position < value.length - 1 ? 1 : 0;
      const body = renderJson(entry, indent + 2, indent + 2, comma, printWidth);
      return `${pad}  ${body}${comma === 1 ? ',' : ''}`;
    });
    return `[\n${lines.join('\n')}\n${pad}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const pairs = Object.entries(value);
    const lines = pairs.map(([key, entry], position) => {
      const comma = position < pairs.length - 1 ? 1 : 0;
      const prefix = `${JSON.stringify(key)}: `;
      const body = renderJson(entry, indent + 2, indent + 2 + prefix.length, comma, printWidth);
      return `${pad}  ${prefix}${body}${comma === 1 ? ',' : ''}`;
    });
    return `{\n${lines.join('\n')}\n${pad}}`;
  }
  return inline;
};

/** A checksum the manifest would gain, as a change a person can read before committing it. */
export interface ManifestChecksumChange {
  /** The manifest path of the file whose checksum this is. */
  readonly filePath: string;
  readonly before: FileChecksum;
  readonly after: RecordedChecksum;
  /** The change as `-`/`+` lines, for the command's own output. */
  readonly diff: readonly string[];
  /** Whether `manifest.json` was rewritten, and why not when it was not. */
  readonly written: boolean;
  readonly notWrittenBecause?: string;
}

const isoDate = (when: Date): string => when.toISOString().slice(0, 10);

const diffLines = (before: FileChecksum, after: RecordedChecksum): readonly string[] => [
  ...formatJsonDocument(before)
    .trimEnd()
    .split('\n')
    .map((line) => `- ${line}`),
  ...formatJsonDocument(after)
    .trimEnd()
    .split('\n')
    .map((line) => `+ ${line}`),
];

/** The checksum a locally hashed copy earns, and the note that says it was hashed here. */
export const localChecksum = (
  algorithm: ChecksumAlgorithm,
  value: string,
  when: Date,
  note: string,
): RecordedChecksum => ({
  state: 'recorded',
  algorithm,
  value,
  source: 'local-download',
  recordedOn: isoDate(when),
  note,
});

export interface RecordChecksumOptions {
  /** The manifest file to edit — the committed one, in a source checkout. */
  readonly manifestPath: string;
  /** The `files[].path` whose checksum is being recorded. */
  readonly filePath: string;
  readonly checksum: RecordedChecksum;
}

/**
 * Writes a checksum into `manifest.json` and describes the change.
 *
 * It refuses to touch a manifest that is not in the repository's own formatting, because
 * rewriting one would bury a one-field change in a reformatting diff — the change is
 * reported either way, so nothing is lost but the automatic edit.
 */
export const recordChecksum = async ({
  manifestPath,
  filePath,
  checksum,
}: RecordChecksumOptions): Promise<ManifestChecksumChange> => {
  const text = await readFile(manifestPath, 'utf8');
  const document = JSON.parse(text) as { files?: { path?: string; checksum?: FileChecksum }[] };
  const file = document.files?.find((entry) => entry.path === filePath);
  if (file === undefined || file.checksum === undefined) {
    throw new VerificationError(
      filePath,
      `${manifestPath} declares no file at ${filePath}, so there is no checksum to record`,
    );
  }

  const before = file.checksum;
  const diff = diffLines(before, checksum);
  if (formatJsonDocument(document) !== text) {
    return {
      filePath,
      before,
      after: checksum,
      diff,
      written: false,
      notWrittenBecause: `${manifestPath} is not in this repository's formatting, and rewriting it would bury this change in a reformatted file — run \`pnpm format\` and try again, or apply the change below by hand`,
    };
  }

  file.checksum = checksum;
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, formatJsonDocument(document), 'utf8');
  return { filePath, before, after: checksum, diff, written: true };
};
