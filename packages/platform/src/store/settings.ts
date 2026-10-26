import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The data directory's own record: the session-signing key and when the directory was
 * seeded. Its presence is what "this data directory has been started before" means, so a
 * restart does not re-seed and does not generate a second password.
 *
 * The key is a secret at rest. It is never logged, never returned to a request and never
 * leaves this process other than as an HMAC.
 */

const SETTINGS_FILE = 'settings.json';
const SIGNING_KEY_BYTES = 32;

export interface PlatformSettings {
  /** Hexadecimal. Signs the session cookie; rotating it signs every session out. */
  signingKey: string;
  seededAt: string;
}

export const settingsPath = (dataDir: string): string => join(dataDir, SETTINGS_FILE);

/** The settings of a data directory that has been started before, or `null` if it has not. */
export const readSettings = async (dataDir: string): Promise<PlatformSettings | null> => {
  try {
    return JSON.parse(await readFile(settingsPath(dataDir), 'utf8')) as PlatformSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

/** Writes the settings of a data directory being seeded, creating the directory. */
export const writeSettings = async (dataDir: string): Promise<PlatformSettings> => {
  const settings: PlatformSettings = {
    signingKey: randomBytes(SIGNING_KEY_BYTES).toString('hex'),
    seededAt: new Date().toISOString(),
  };
  await mkdir(dataDir, { recursive: true });
  await writeFile(settingsPath(dataDir), `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return settings;
};
