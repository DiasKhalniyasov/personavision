/**
 * Reading a zip archive: its directory first, its bytes second.
 *
 * The dataset arrives as one 12.9 GB zip, so this reader is written for an archive too
 * large to hold in memory and for one whose layout has to be checked **before** anything is
 * written to disk. It reads the central directory at the end of the file — a few megabytes
 * at most — and hands back the entries; `verify.ts` compares them with the manifest's
 * declared layout, and only then is `extractZip` called. An archive whose tree contradicts
 * the manifest is therefore never half-unpacked: nothing is unpacked at all.
 *
 * Zip64 is supported because the archive needs it: a 12.9 GB member and a central directory
 * past the four-gigabyte mark cannot be described by the 1989 header fields.
 *
 * Nothing here is a general-purpose zip library. Stored and deflated entries are read,
 * encryption, multi-disk archives and the other compression methods are refused by name,
 * and every member path is put through `isContainedRelativePath` before it reaches the
 * filesystem — a hostile archive member is the one way a download could write outside the
 * cache.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { isContainedRelativePath } from './cache.js';

/** `PK\x05\x06` — the end-of-central-directory record. */
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** `PK\x06\x06` — its zip64 replacement. */
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
/** `PK\x06\x07` — the locator that says where the zip64 record is. */
const ZIP64_LOCATOR = 0x07064b50;
/** `PK\x01\x02` — one entry of the central directory. */
const CENTRAL_FILE_HEADER = 0x02014b50;
/** `PK\x03\x04` — the header in front of one entry's bytes. */
const LOCAL_FILE_HEADER = 0x04034b50;

const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const CENTRAL_FILE_HEADER_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;
/** The archive comment is a 16-bit length, so the record cannot start further back. */
const MOST_TRAILING_BYTES = END_OF_CENTRAL_DIRECTORY_SIZE + 0xffff;

/** A field whose 32-bit slot says "read me from the zip64 extra field instead". */
const NEEDS_ZIP64_32 = 0xffffffff;
const NEEDS_ZIP64_16 = 0xffff;

/** Stored, and deflated. Every other method is refused by name. */
const STORED = 0;
const DEFLATED = 8;

/** General-purpose bit 0: the entry is encrypted. */
const ENCRYPTED_FLAG = 0x0001;
/** General-purpose bit 11: the name is UTF-8 rather than CP437. */
const UTF8_NAME_FLAG = 0x0800;

/** Host system 3 in `versionMadeBy`: the external attributes carry a Unix mode. */
const UNIX_HOST = 3;
/** `S_IFMT` and `S_IFLNK`: a member that is a symbolic link rather than a file. */
const FILE_TYPE_MASK = 0xf000;
const SYMLINK_TYPE = 0xa000;

/** One member of the archive, as the central directory describes it. */
export interface ArchiveEntry {
  /** Forward slashes, relative, contained — a trailing slash is stripped. */
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /** The size once unpacked. Zero for a directory. */
  readonly sizeBytes: number;
  /** The size as stored. */
  readonly compressedBytes: number;
  readonly method: typeof STORED | typeof DEFLATED;
  /** The CRC-32 the unpacked bytes must hash to. */
  readonly crc32: number;
  /** Where this entry's local header sits in the file. */
  readonly localHeaderOffset: number;
}

/** An archive this reader will not read, and why. */
export class ArchiveError extends Error {
  /** The member the defect is in, or `null` for a defect in the archive as a whole. */
  readonly entryPath: string | null;

  constructor(message: string, entryPath: string | null = null) {
    // The member's path is part of the message, not only a field: this error travels into
    // the download's failure list, where a reason without the entry it is about is a reason
    // nobody can act on.
    super(entryPath === null ? message : `${entryPath}: ${message}`);
    this.name = 'ArchiveError';
    this.entryPath = entryPath;
  }
}

/** The CRC-32 table, built once: the check every unpacked entry is held to. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const updateCrc = (crc: number, bytes: Uint8Array): number => {
  let value = crc;
  for (const byte of bytes) {
    value = (CRC_TABLE[(value ^ byte) & 0xff] as number) ^ (value >>> 8);
  }
  return value >>> 0;
};

/** A 64-bit field read as a JavaScript number, refused when it cannot be one exactly. */
const readU64 = (buffer: Buffer, offset: number, what: string): number => {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveError(`${what} is ${value} bytes, past what this reader can address`);
  }
  return Number(value);
};

const readAt = async (handle: FileHandle, position: number, length: number): Promise<Buffer> => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new ArchiveError(
      `the archive ends after ${position + bytesRead} bytes, in the middle of a header that claims to run to ${position + length}`,
    );
  }
  return buffer;
};

/** Where the central directory is and how many entries it holds. */
interface DirectoryLocation {
  readonly offset: number;
  readonly sizeBytes: number;
  readonly entries: number;
}

const findEndOfCentralDirectory = async (
  handle: FileHandle,
  fileSize: number,
): Promise<{ record: Buffer; position: number }> => {
  const length = Math.min(fileSize, MOST_TRAILING_BYTES);
  const start = fileSize - length;
  const tail = Buffer.alloc(length);
  await handle.read(tail, 0, length, start);

  for (let index = length - END_OF_CENTRAL_DIRECTORY_SIZE; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength !== length) continue;
    return { record: tail.subarray(index), position: start + index };
  }
  throw new ArchiveError(
    'this is not a zip archive: no end-of-central-directory record in its last 64 KiB',
  );
};

const locateDirectory = async (
  handle: FileHandle,
  fileSize: number,
): Promise<DirectoryLocation> => {
  const { record, position } = await findEndOfCentralDirectory(handle, fileSize);

  if (record.readUInt16LE(4) !== 0 || record.readUInt16LE(6) !== 0) {
    throw new ArchiveError('this archive is split across disks, which this reader does not read');
  }

  const entries = record.readUInt16LE(10);
  const sizeBytes = record.readUInt32LE(12);
  const offset = record.readUInt32LE(16);
  const needsZip64 =
    entries === NEEDS_ZIP64_16 || sizeBytes === NEEDS_ZIP64_32 || offset === NEEDS_ZIP64_32;
  if (!needsZip64) return { offset, sizeBytes, entries };

  const locatorPosition = position - ZIP64_LOCATOR_SIZE;
  if (locatorPosition < 0) {
    throw new ArchiveError('the archive needs zip64 fields but carries no zip64 locator');
  }
  const locator = await readAt(handle, locatorPosition, ZIP64_LOCATOR_SIZE);
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR) {
    throw new ArchiveError('the archive needs zip64 fields but carries no zip64 locator');
  }

  const zip64Position = readU64(locator, 8, "the zip64 record's position");
  const zip64 = await readAt(handle, zip64Position, 56);
  if (zip64.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
    throw new ArchiveError('the zip64 locator does not point at a zip64 end-of-directory record');
  }

  return {
    entries: readU64(zip64, 32, 'the entry count'),
    sizeBytes: readU64(zip64, 40, "the central directory's size"),
    offset: readU64(zip64, 48, "the central directory's position"),
  };
};

/** The four fields zip64 moves out of the 46-byte header, in the order they appear. */
const readZip64Extra = (
  extra: Buffer,
  needed: { size: boolean; compressed: boolean; offset: boolean },
  entryPath: string,
): { sizeBytes?: number; compressedBytes?: number; localHeaderOffset?: number } => {
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    const body = extra.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    if (id !== 0x0001) continue;

    const read: { sizeBytes?: number; compressedBytes?: number; localHeaderOffset?: number } = {};
    let cursor = 0;
    const next = (what: string): number => {
      if (cursor + 8 > body.length) {
        throw new ArchiveError(`the zip64 extra field is too short to hold ${what}`, entryPath);
      }
      const value = readU64(body, cursor, what);
      cursor += 8;
      return value;
    };
    if (needed.size) read.sizeBytes = next('the unpacked size');
    if (needed.compressed) read.compressedBytes = next('the stored size');
    if (needed.offset) read.localHeaderOffset = next('the header position');
    return read;
  }
  throw new ArchiveError('a header asks for zip64 fields that the entry does not carry', entryPath);
};

const decodeName = (bytes: Buffer, utf8: boolean): string =>
  // CP437 is the zip format's pre-UTF-8 default, and `latin1` is the closest decoding Node
  // has for the ASCII range every entry of a dataset archive stays inside. A name outside
  // it without the UTF-8 flag would be mojibake here — and it fails containment below
  // rather than reaching the filesystem mis-decoded.
  utf8 ? bytes.toString('utf8') : bytes.toString('latin1');

const parseCentralDirectory = (directory: Buffer, expected: number): readonly ArchiveEntry[] => {
  const entries: ArchiveEntry[] = [];
  let at = 0;

  while (at + CENTRAL_FILE_HEADER_SIZE <= directory.length) {
    const headerAt = at;
    if (directory.readUInt32LE(headerAt) !== CENTRAL_FILE_HEADER) {
      throw new ArchiveError(
        `the central directory is malformed: no entry header at byte ${headerAt} of it`,
      );
    }

    const versionMadeBy = directory.readUInt16LE(headerAt + 4);
    const flags = directory.readUInt16LE(headerAt + 8);
    const method = directory.readUInt16LE(headerAt + 10);
    const crc32 = directory.readUInt32LE(headerAt + 16);
    const nameLength = directory.readUInt16LE(headerAt + 28);
    const extraLength = directory.readUInt16LE(headerAt + 30);
    const commentLength = directory.readUInt16LE(headerAt + 32);
    const externalAttributes = directory.readUInt32LE(headerAt + 38);

    const nameAt = headerAt + CENTRAL_FILE_HEADER_SIZE;
    const rawName = decodeName(
      directory.subarray(nameAt, nameAt + nameLength),
      (flags & UTF8_NAME_FLAG) !== 0,
    );
    const extra = directory.subarray(nameAt + nameLength, nameAt + nameLength + extraLength);
    at = nameAt + nameLength + extraLength + commentLength;
    if (at > directory.length) {
      throw new ArchiveError(
        `the central directory ends in the middle of the entry at byte ${headerAt} of it`,
      );
    }

    let compressedBytes = directory.readUInt32LE(headerAt + 20);
    let sizeBytes = directory.readUInt32LE(headerAt + 24);
    let localHeaderOffset = directory.readUInt32LE(headerAt + 42);

    const needed = {
      size: sizeBytes === NEEDS_ZIP64_32,
      compressed: compressedBytes === NEEDS_ZIP64_32,
      offset: localHeaderOffset === NEEDS_ZIP64_32,
    };
    if (needed.size || needed.compressed || needed.offset) {
      const zip64 = readZip64Extra(extra, needed, rawName);
      sizeBytes = zip64.sizeBytes ?? sizeBytes;
      compressedBytes = zip64.compressedBytes ?? compressedBytes;
      localHeaderOffset = zip64.localHeaderOffset ?? localHeaderOffset;
    }

    const isDirectory = rawName.endsWith('/');
    const path = isDirectory ? rawName.slice(0, -1) : rawName;

    if ((flags & ENCRYPTED_FLAG) !== 0) {
      throw new ArchiveError('this entry is encrypted, and this dataset needs no password', path);
    }
    if (!isDirectory && method !== STORED && method !== DEFLATED) {
      throw new ArchiveError(
        `this entry uses compression method ${method}; this reader reads stored (0) and deflated (8)`,
        path,
      );
    }
    if (
      versionMadeBy >> 8 === UNIX_HOST &&
      ((externalAttributes >>> 16) & FILE_TYPE_MASK) === SYMLINK_TYPE
    ) {
      throw new ArchiveError(
        'this entry is a symbolic link, which would point the cache at a path outside it',
        path,
      );
    }
    if (!isContainedRelativePath(path)) {
      throw new ArchiveError(
        `this entry's path would be written outside the cache: it must be relative, use forward slashes and hold no \`..\` segment`,
        path,
      );
    }

    entries.push({
      path,
      kind: isDirectory ? 'directory' : 'file',
      sizeBytes: isDirectory ? 0 : sizeBytes,
      compressedBytes: isDirectory ? 0 : compressedBytes,
      method: method === STORED ? STORED : DEFLATED,
      crc32,
      localHeaderOffset,
    });
  }

  if (entries.length !== expected) {
    throw new ArchiveError(
      `the archive declares ${expected} entries and its central directory holds ${entries.length}`,
    );
  }
  return entries;
};

/**
 * Every member of the archive, read from its central directory.
 *
 * Reads the tail of the file and the directory itself — a few megabytes of a 12.9 GB
 * archive — and no member's bytes. This is what makes "fail naming the difference rather
 * than extracting anyway" possible: the layout is known before a byte is written.
 */
export const readArchiveDirectory = async (
  archivePath: string,
): Promise<readonly ArchiveEntry[]> => {
  const handle = await open(archivePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < END_OF_CENTRAL_DIRECTORY_SIZE) {
      throw new ArchiveError(`this is not a zip archive: it is only ${size} bytes long`);
    }
    const location = await locateDirectory(handle, size);
    const directory = await readAt(handle, location.offset, location.sizeBytes);
    return parseCentralDirectory(directory, location.entries);
  } finally {
    await handle.close();
  }
};

/** How much of a member is read at a time. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * One member's stored bytes, a chunk at a time.
 *
 * Read through the handle rather than through a stream per entry: a read stream of a
 * `FileHandle` holds a listener on it for as long as it lives, and an archive of twenty
 * thousand members unpacked through one handle would gather twenty thousand of them.
 */
async function* readRange(
  handle: FileHandle,
  start: number,
  length: number,
): AsyncGenerator<Buffer> {
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(length, 1)));
  let position = start;
  let remaining = length;
  while (remaining > 0) {
    const want = Math.min(buffer.length, remaining);
    const { bytesRead } = await handle.read(buffer, 0, want, position);
    if (bytesRead === 0) {
      throw new ArchiveError(
        `the archive ends after ${position} bytes, ${remaining} short of an entry it declares`,
      );
    }
    // Copied, because the read buffer is reused for the next chunk.
    yield Buffer.from(buffer.subarray(0, bytesRead));
    position += bytesRead;
    remaining -= bytesRead;
  }
}

/** Counts bytes and CRC-32s them on the way past, so a corrupt member is caught as it lands. */
class CrcCounter extends Transform {
  crc = 0 ^ -1;
  bytes = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.crc = updateCrc(this.crc, chunk);
    this.bytes += chunk.length;
    done(null, chunk);
  }

  get digest(): number {
    return (this.crc ^ -1) >>> 0;
  }
}

export interface ExtractOptions {
  readonly archivePath: string;
  readonly entries: readonly ArchiveEntry[];
  /** The directory the tree is written into. It is created if it is not there. */
  readonly into: string;
  /**
   * A prefix every entry sits under in the archive and must not sit under on disk — the
   * directory the manifest's layout is declared relative to. Entries outside it are an
   * error, not a silent skip.
   */
  readonly stripPrefix?: string;
  readonly onEntry?: (entry: ArchiveEntry, done: number, total: number) => void;
}

const withoutPrefix = (path: string, prefix: string): string => {
  if (prefix === '') return path;
  if (path === prefix) return '';
  if (!path.startsWith(`${prefix}/`)) {
    throw new ArchiveError(
      `this entry sits outside ${prefix}, which every other entry of the archive is under`,
      path,
    );
  }
  return path.slice(prefix.length + 1);
};

const extractEntry = async (
  handle: FileHandle,
  entry: ArchiveEntry,
  destination: string,
): Promise<void> => {
  await mkdir(dirname(destination), { recursive: true });

  if (entry.compressedBytes === 0 && entry.sizeBytes === 0) {
    await writeFile(destination, '');
    return;
  }

  const local = await readAt(handle, entry.localHeaderOffset, LOCAL_FILE_HEADER_SIZE);
  if (local.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
    throw new ArchiveError(
      `the central directory points at byte ${entry.localHeaderOffset}, where there is no entry header`,
      entry.path,
    );
  }
  // The local header carries its own name and extra lengths, which need not be the central
  // directory's: the bytes begin after whichever this copy declares.
  const dataAt =
    entry.localHeaderOffset +
    LOCAL_FILE_HEADER_SIZE +
    local.readUInt16LE(26) +
    local.readUInt16LE(28);

  const counter = new CrcCounter();
  await pipeline([
    Readable.from(readRange(handle, dataAt, entry.compressedBytes)),
    ...(entry.method === DEFLATED ? [createInflateRaw()] : []),
    counter,
    createWriteStream(destination),
  ]);

  if (counter.bytes !== entry.sizeBytes) {
    throw new ArchiveError(
      `this entry unpacked to ${counter.bytes} bytes where the archive declares ${entry.sizeBytes}`,
      entry.path,
    );
  }
  if (counter.digest !== entry.crc32) {
    throw new ArchiveError(
      'this entry is corrupt: its unpacked bytes do not match the checksum the archive records for them',
      entry.path,
    );
  }
};

/**
 * Writes the archive's members into a directory, one at a time.
 *
 * Streamed rather than buffered: a member of this dataset is an image, but the archive as a
 * whole is 12.9 GB and the reader must not depend on any member fitting in memory. Every
 * member's CRC-32 is checked as it lands, so a truncated or corrupted archive fails on the
 * entry that is wrong rather than producing a tree that merely looks complete.
 */
export const extractArchive = async ({
  archivePath,
  entries,
  into,
  stripPrefix = '',
  onEntry,
}: ExtractOptions): Promise<void> => {
  const handle = await open(archivePath, 'r');
  try {
    await mkdir(into, { recursive: true });
    let done = 0;
    for (const entry of entries) {
      const relative = withoutPrefix(entry.path, stripPrefix);
      done += 1;
      if (relative === '') continue;
      const destination = join(into, ...relative.split('/'));
      if (entry.kind === 'directory') {
        await mkdir(destination, { recursive: true });
      } else {
        await extractEntry(handle, entry, destination);
      }
      onEntry?.(entry, done, entries.length);
    }
  } finally {
    await handle.close();
  }
};
