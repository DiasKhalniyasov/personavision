import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliError } from '../src/cli-error.js';
import { AUDIENCE_PRESETS, DEFAULT_AUDIENCE, resolveAudience } from '../src/run/audience.js';
import { audienceOf } from './run-swarm.js';

/**
 * Which audience a test is for, resolved from one argument.
 *
 * The hosted product resolves a stored audience against the workspace that asked; this
 * command has no workspace, so what it accepts is the committed preset by name or a file —
 * and `default` keeps meaning the preset, because that is the value the published
 * `--personas` example has always printed.
 */

describe('the audience a command names', () => {
  it('defaults to the demo shop’s customers', async () => {
    expect(await resolveAudience('')).toBe(DEFAULT_AUDIENCE);
    expect(await resolveAudience('default')).toBe(DEFAULT_AUDIENCE);
    expect(await resolveAudience(' outdoor-gear-shoppers ')).toBe(DEFAULT_AUDIENCE);
    expect(AUDIENCE_PRESETS).toContain(DEFAULT_AUDIENCE);
  });

  it('names a preset it does not know rather than opening it as a file', async () => {
    await expect(resolveAudience('outdoor-gear-shopper')).rejects.toThrow(CliError);
    await expect(resolveAudience('outdoor-gear-shopper')).rejects.toThrow(
      /there is no audience "outdoor-gear-shopper"/,
    );
  });

  describe('from a file', () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'personavision-audience-'));
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const fileHolding = async (name: string, contents: string): Promise<string> => {
      const file = join(dir, name);
      await writeFile(file, contents);
      return file;
    };

    it('reads one the generator can generate people from', async () => {
      const file = await fileHolding('good.json', JSON.stringify(audienceOf(3)));

      expect((await resolveAudience(file)).size).toBe(3);
    });

    it('reports a field it got wrong at that field’s own path', async () => {
      const file = await fileHolding(
        'wrong.json',
        JSON.stringify({ ...audienceOf(2), devices: [] }),
      );

      await expect(resolveAudience(file)).rejects.toThrow(/devices —/);
    });

    it('says what it found rather than throwing a parse error', async () => {
      const file = await fileHolding('broken.json', '{ not json');

      await expect(resolveAudience(file)).rejects.toThrow(/is not JSON/);
    });

    it('says which file it could not read', async () => {
      await expect(resolveAudience(join(dir, 'absent.json'))).rejects.toThrow(
        /absent\.json could not be read/,
      );
    });
  });
});
