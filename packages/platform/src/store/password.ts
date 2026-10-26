import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { PasswordVerifier } from './types.js';

/**
 * Passwords, stored only as a verifier produced by a slow hash from Node's own `crypto`.
 *
 * scrypt with a per-account salt, and the parameters recorded beside the verifier so they
 * can be raised later without invalidating the records that already exist. No dependency
 * is added for this, and the plaintext is never written anywhere — not to the store, not
 * to a log, not into an error message.
 *
 * Sign-in itself is #101's; this is what seeding needs in order not to store a password.
 */

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Node's interactive-login defaults: 16 MiB of memory per verification. */
const PARAMETERS = { cost: 16_384, blockSize: 8, parallelization: 1, keyLength: 64 } as const;

const SALT_BYTES = 16;

/** scrypt refuses to run unless it is allowed more than `128 * N * r` bytes. */
const maxmem = (cost: number, blockSize: number): number => 256 * cost * blockSize;

export const hashPassword = async (password: string): Promise<PasswordVerifier> => {
  const salt = randomBytes(SALT_BYTES);
  const verifier = await derive(password, salt, PARAMETERS.keyLength, {
    N: PARAMETERS.cost,
    r: PARAMETERS.blockSize,
    p: PARAMETERS.parallelization,
    maxmem: maxmem(PARAMETERS.cost, PARAMETERS.blockSize),
  });
  return {
    algorithm: 'scrypt',
    salt: salt.toString('hex'),
    ...PARAMETERS,
    verifier: verifier.toString('hex'),
  };
};

export const verifyPassword = async (
  password: string,
  record: PasswordVerifier,
): Promise<boolean> => {
  const expected = Buffer.from(record.verifier, 'hex');
  const actual = await derive(password, Buffer.from(record.salt, 'hex'), record.keyLength, {
    N: record.cost,
    r: record.blockSize,
    p: record.parallelization,
    maxmem: maxmem(record.cost, record.blockSize),
  });
  // Equal lengths first: `timingSafeEqual` throws on a mismatch rather than returning false.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

/**
 * The alphabet the generated password is drawn from: no `0`/`O` and no `1`/`l`, because
 * this one is printed once and typed in by hand.
 */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const GROUPS = 4;
const GROUP_LENGTH = 5;

/** ~98 bits over the alphabet above. Drawn from the system's own entropy, never a seed. */
export const generatePassword = (): string =>
  Array.from({ length: GROUPS }, () =>
    Array.from({ length: GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
  ).join('-');
