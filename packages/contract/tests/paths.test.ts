import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listRunDirs, runDirName, runPaths } from '../src/index.js';
import { temporaryRunDir } from './fixtures.js';

/**
 * The layout is written out literally here, once, and nowhere else: every other test in
 * this package addresses files through these helpers.
 */
describe('the run-directory layout', () => {
  const layout = runPaths('');

  it('is run.json, findings.json, sessions/S-NN.json and screenshots/<variant>/<step>.png', () => {
    expect(layout.run).toBe('run.json');
    expect(layout.findings).toBe('findings.json');
    expect(layout.sessionsDir).toBe('sessions');
    expect(layout.screenshotsDir).toBe('screenshots');
    expect(layout.session('S-01')).toBe('sessions/S-01.json');
    expect(layout.screenshot('A', 'cart')).toBe('screenshots/A/cart.png');
  });

  it('hangs the same layout off a run directory', () => {
    const paths = runPaths('/tmp/runs/2026-10-24-1402-northwind-demo');

    expect(paths.dir).toBe('/tmp/runs/2026-10-24-1402-northwind-demo');
    expect(paths.run).toBe(`/tmp/runs/2026-10-24-1402-northwind-demo/${layout.run}`);
    expect(paths.session('S-02')).toBe(
      `/tmp/runs/2026-10-24-1402-northwind-demo/${layout.session('S-02')}`,
    );
  });

  it('spells one file one way, whether or not the run directory was given with a slash', () => {
    expect(runPaths('/tmp/runs/2026-10-24-1402-northwind-demo/').run).toBe(
      runPaths('/tmp/runs/2026-10-24-1402-northwind-demo').run,
    );
    expect(runPaths('/').run).toBe(`/${layout.run}`);
  });
});

describe('a run directory is named for when the run was created', () => {
  it('stamps the name in UTC, so one run has one name on every machine', () => {
    expect(runDirName(new Date('2026-10-24T14:02:33.000Z'), 'Northwind Demo')).toBe(
      '2026-10-24-1402-northwind-demo',
    );
  });

  it('still produces a name a runs root can be listed by when nothing in it survives slugging', async () => {
    const named = runDirName(new Date('2026-10-24T14:02:33.000Z'), 'Проверка!');
    const { dir, cleanup } = await temporaryRunDir();
    const runsRoot = join(dir, '..');
    try {
      await mkdir(join(runsRoot, named), { recursive: true });

      expect(named).toBe('2026-10-24-1402-run');
      expect(await listRunDirs(runsRoot)).toEqual([named]);
    } finally {
      await cleanup();
    }
  });
});

describe('listing the run directories under a runs root', () => {
  it('returns them newest first, ignoring anything not named like a run', async () => {
    const { dir, cleanup } = await temporaryRunDir();
    const runsRoot = join(dir, '..');
    try {
      for (const name of [
        '2026-10-24-1402-northwind-demo',
        '2026-10-25-0915-northwind-demo',
        '2026-10-23-1100-earlier-run',
        'not-a-run',
      ]) {
        await mkdir(join(runsRoot, name), { recursive: true });
      }
      await writeFile(join(runsRoot, '2026-10-26-0900-a-file-not-a-dir'), '');

      expect(await listRunDirs(runsRoot)).toEqual([
        '2026-10-25-0915-northwind-demo',
        '2026-10-24-1402-northwind-demo',
        '2026-10-23-1100-earlier-run',
      ]);
    } finally {
      await cleanup();
    }
  });

  it('reports no runs rather than failing when the runs root does not exist', async () => {
    expect(await listRunDirs(join('/tmp', 'personavision-no-such-root-9d3f'))).toEqual([]);
  });
});
