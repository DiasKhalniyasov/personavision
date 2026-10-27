import { readFile } from 'node:fs/promises';
import {
  AudienceValidationError,
  OUTDOOR_GEAR_SHOPPERS,
  parseAudience,
} from '@personavision/personas';
import { CliError } from '../cli-error.js';
import type { Audience } from '@personavision/contract';

/**
 * The audience a test is for: a committed preset by name, or a JSON file.
 *
 * An audience is the product's first-class object — the user describes the customers their
 * business serves and the simulated people are generated from that description
 * (`docs/FLOW.md` section 1) — and the hosted product resolves one out of the workspace's
 * own store. This command is an internal tool with no workspace, so it resolves the one
 * **committed** audience by name, or reads a file: that is how a developer runs a swarm for
 * an audience nobody has stored yet, and it is what the tests and the demo run on.
 *
 * Whatever it resolves is written into `run.json` **by value**, so a later edit to a stored
 * audience cannot restate a finished test.
 */

/** Every audience this command can name. One, today: the demo shop's customers (#31). */
export const AUDIENCE_PRESETS: readonly Audience[] = [OUTDOOR_GEAR_SHOPPERS];

/** The preset a command that names no audience runs for. */
export const DEFAULT_AUDIENCE = OUTDOOR_GEAR_SHOPPERS;

/**
 * The names that mean "the default audience".
 *
 * `default` is one of them because it is the value `personavision run --help` has always
 * printed in its own example, and the published argument surface is a promise to the New
 * test form and to anybody who copied that line.
 */
const DEFAULT_NAMES = new Set(['', 'default', DEFAULT_AUDIENCE.id]);

/**
 * Whether a name is meant as a file rather than as a preset: a path separator, a leading
 * dot, or a `.json` ending. A bare word is never opened as a file, so a typo in a preset
 * name is reported as a name this command does not know rather than as a missing file.
 */
const looksLikeAFile = (named: string): boolean =>
  named.endsWith('.json') || named.includes('/') || named.includes('\\') || named.startsWith('.');

const presetNames = (): string => AUDIENCE_PRESETS.map((preset) => preset.id).join(', ');

/** What this command needed and did not get, with the ways of giving it. */
const noSuchAudience = (named: string): CliError =>
  new CliError(
    [
      `The test was not started: there is no audience "${named}".`,
      `Pass --audience with one of the committed presets (${presetNames()}), or with the path of a JSON file holding an audience.`,
      'Nothing was written: no run directory was created.',
    ].join('\n'),
  );

/** An audience file that is not one, reported at the path of each field that is wrong. */
const notAnAudience = (file: string, error: AudienceValidationError): CliError =>
  new CliError(
    [
      `The test was not started: ${file} is not an audience the people can be generated from.`,
      ...error.issues.map((issue) => `  ${issue.path} — ${issue.message}`),
      'Nothing was written: no run directory was created.',
    ].join('\n'),
  );

/**
 * The audience named on the command line, read and validated before anything is written.
 *
 * It throws rather than defaulting to something else: a run started for an audience nobody
 * asked for would report numbers about the wrong people, which is worse than not running.
 */
export const resolveAudience = async (named: string): Promise<Audience> => {
  const trimmed = named.trim();
  if (DEFAULT_NAMES.has(trimmed)) return DEFAULT_AUDIENCE;

  const preset = AUDIENCE_PRESETS.find((candidate) => candidate.id === trimmed);
  if (preset !== undefined) return preset;

  if (!looksLikeAFile(trimmed)) throw noSuchAudience(trimmed);

  let text: string;
  try {
    text = await readFile(trimmed, 'utf8');
  } catch (error) {
    throw new CliError(
      [
        `The test was not started: ${trimmed} could not be read (${(error as Error).message}).`,
        'Nothing was written: no run directory was created.',
      ].join('\n'),
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new CliError(
      [
        `The test was not started: ${trimmed} is not JSON (${(error as Error).message}).`,
        'Nothing was written: no run directory was created.',
      ].join('\n'),
    );
  }

  try {
    return parseAudience(json);
  } catch (error) {
    if (error instanceof AudienceValidationError) throw notAnAudience(trimmed, error);
    throw error;
  }
};
