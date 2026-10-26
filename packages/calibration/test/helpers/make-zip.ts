/**
 * A zip archive built in the test process, so the unpacking is asserted against bytes this
 * repository produced rather than against a 12.9 GB download.
 *
 * It writes the format rather than calling the reader's own code — including its own
 * CRC-32 — so a reader that is wrong in both directions at once cannot pass. `zip64: true`
 * emits the 64-bit records the real archive needs, which is the only way those paths are
 * exercised without a four-gigabyte fixture.
 */

import { deflateRawSync } from 'node:zlib';

export interface ZipEntryInput {
  /** The member's path inside the archive, forward slashes, as a zip stores it. */
  readonly path: string;
  /** Absent for a directory. */
  readonly data?: Buffer;
  readonly kind?: 'file' | 'directory';
  /** Deflated rather than stored. The real archive uses both. */
  readonly deflate?: boolean;
  /** An external attributes word, for a member that is not a plain file. */
  readonly externalAttributes?: number;
  /** A `versionMadeBy`, whose high byte is the host system. */
  readonly versionMadeBy?: number;
  /** Written into the central directory in place of the real one. */
  readonly brokenCrc?: number;
}

export interface MakeZipOptions {
  /** Emit the zip64 end-of-directory record and 64-bit per-entry fields. */
  readonly zip64?: boolean;
}

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

export const crc32 = (bytes: Buffer): number => {
  let value = 0 ^ -1;
  for (const byte of bytes) value = (CRC_TABLE[(value ^ byte) & 0xff] as number) ^ (value >>> 8);
  return (value ^ -1) >>> 0;
};

const UTF8_NAME_FLAG = 0x0800;
const NEEDS_ZIP64 = 0xffffffff;

interface Placed {
  readonly input: ZipEntryInput;
  readonly name: string;
  readonly stored: Buffer;
  readonly size: number;
  readonly crc: number;
  readonly method: number;
  readonly offset: number;
}

const zip64Extra = (values: readonly number[]): Buffer => {
  const body = Buffer.alloc(8 * values.length);
  values.forEach((value, index) => body.writeBigUInt64LE(BigInt(value), index * 8));
  const field = Buffer.alloc(4 + body.length);
  field.writeUInt16LE(0x0001, 0);
  field.writeUInt16LE(body.length, 2);
  body.copy(field, 4);
  return field;
};

export const makeZip = (
  entries: readonly ZipEntryInput[],
  { zip64 = false }: MakeZipOptions = {},
): Buffer => {
  const parts: Buffer[] = [];
  const placed: Placed[] = [];
  let offset = 0;

  for (const input of entries) {
    const directory = input.kind === 'directory';
    const data = directory ? Buffer.alloc(0) : (input.data ?? Buffer.alloc(0));
    const stored = input.deflate === true ? deflateRawSync(data) : data;
    const method = input.deflate === true ? 8 : 0;
    const name = Buffer.from(directory ? `${input.path}/` : input.path, 'utf8');
    const extra = zip64 && !directory ? zip64Extra([data.length, stored.length]) : Buffer.alloc(0);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(UTF8_NAME_FLAG, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(zip64 && !directory ? NEEDS_ZIP64 : stored.length, 18);
    header.writeUInt32LE(zip64 && !directory ? NEEDS_ZIP64 : data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);

    placed.push({
      input,
      name: name.toString('utf8'),
      stored,
      size: data.length,
      crc: input.brokenCrc ?? crc32(data),
      method,
      offset,
    });
    parts.push(header, name, extra, stored);
    offset += header.length + name.length + extra.length + stored.length;
  }

  const directoryStart = offset;
  for (const entry of placed) {
    const name = Buffer.from(entry.name, 'utf8');
    const extra = zip64
      ? zip64Extra([entry.size, entry.stored.length, entry.offset])
      : Buffer.alloc(0);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(entry.input.versionMadeBy ?? (3 << 8) | 20, 4);
    header.writeUInt16LE(zip64 ? 45 : 20, 6);
    header.writeUInt16LE(UTF8_NAME_FLAG, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(zip64 ? NEEDS_ZIP64 : entry.stored.length, 20);
    header.writeUInt32LE(zip64 ? NEEDS_ZIP64 : entry.size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt32LE(entry.input.externalAttributes ?? 0, 38);
    header.writeUInt32LE(zip64 ? NEEDS_ZIP64 : entry.offset, 42);
    parts.push(header, name, extra);
    offset += header.length + name.length + extra.length;
  }
  const directorySize = offset - directoryStart;

  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(BigInt(44), 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(placed.length), 24);
    record.writeBigUInt64LE(BigInt(placed.length), 32);
    record.writeBigUInt64LE(BigInt(directorySize), 40);
    record.writeBigUInt64LE(BigInt(directoryStart), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : placed.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : placed.length, 10);
  end.writeUInt32LE(zip64 ? NEEDS_ZIP64 : directorySize, 12);
  end.writeUInt32LE(zip64 ? NEEDS_ZIP64 : directoryStart, 16);
  parts.push(end);

  return Buffer.concat(parts);
};
