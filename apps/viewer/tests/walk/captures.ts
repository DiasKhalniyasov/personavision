import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPaths } from '@personavision/contract';
import { DERIVED_STEP_ID } from '../../../../packages/cli/src/run/task.js';
import { ONE_URL_VARIANT_ID } from '../../../../packages/platform/src/index.js';
import type { CaptureSource, Device } from '../../../../packages/browser/src/index.js';

/**
 * The committed capture set, rewritten as the **one page** a test launched through the
 * product walks: one variant named `site` and one step named `page`.
 *
 * A run started over HTTP carries no step declaration — the request is a sentence and a
 * URL, so `packages/cli/src/run/task.ts` derives the page as one step — and a capture
 * source answers by the variant and step it recorded. So neither name can be invented
 * here: the variant is the platform's `ONE_URL_VARIANT_ID` and the step is the task
 * module's `DERIVED_STEP_ID`, and a session replays geometry, elements and a screenshot
 * that were really recorded rather than written out by a test.
 *
 * `tests/acceptance/helpers/harness.ts` has the four-step sibling of this, for the walk
 * that declares its own steps; the two differ in exactly that, which is why this one is
 * small enough to stand beside the walk that uses it rather than being folded into it.
 */

/** The capture set `pnpm -F @personavision/browser record:captures` wrote. */
const COMMITTED = fileURLToPath(
  new URL('../../../../packages/browser/test/fixtures/captures', import.meta.url),
);

/**
 * The variant of that set this one replays: `A`, the one recorded on a phone, so an
 * audience put on that device replays bytes recorded at that viewport. A replay refuses a
 * device its variant was not recorded under, since every `belowFold` in a capture came
 * from one fold.
 */
const RECORDED_VARIANT = 'A';

/** The address the committed captures were recorded against — the URL a one-URL test gets. */
export const FIXTURE_SITE = 'https://fixture.test/cart.html';

/** The index of a capture set, as the recorder writes it and the replay reads it. */
interface CaptureSetIndex {
  readonly formatVersion: number;
  readonly variants: readonly {
    readonly id: string;
    readonly device: Device;
    readonly steps: readonly { readonly step: string; readonly path: string }[];
  }[];
}

export interface OnePageCaptures {
  /** The temporary capture set — call `discard` when done with it. */
  readonly dir: string;
  /** The device the variant was recorded under, which is the device the audience must use. */
  readonly device: Device;
  readonly discard: () => Promise<void>;
}

export const onePageCaptureSet = async (): Promise<OnePageCaptures> => {
  const dir = await mkdtemp(join(tmpdir(), 'personavision-one-page-captures-'));
  const discard = (): Promise<void> => rm(dir, { recursive: true, force: true });

  try {
    const index = JSON.parse(
      await readFile(join(COMMITTED, 'capture-set.json'), 'utf8'),
    ) as CaptureSetIndex;
    const recorded = index.variants.find((variant) => variant.id === RECORDED_VARIANT);
    if (recorded === undefined) {
      throw new Error(`${COMMITTED} records no variant "${RECORDED_VARIANT}"`);
    }
    const first = recorded.steps[0];
    if (first === undefined) {
      throw new Error(`${COMMITTED} records no step for variant "${RECORDED_VARIANT}"`);
    }

    await writeFile(
      join(dir, 'capture-set.json'),
      JSON.stringify(
        {
          formatVersion: index.formatVersion,
          variants: [
            {
              id: ONE_URL_VARIANT_ID,
              device: recorded.device,
              steps: [{ step: DERIVED_STEP_ID, path: first.path }],
            },
          ],
        },
        null,
        2,
      ),
    );

    const capture = JSON.parse(
      await readFile(join(COMMITTED, 'captures', RECORDED_VARIANT, `${first.step}.json`), 'utf8'),
    ) as Record<string, unknown>;
    const screenshot = runPaths('').screenshot(ONE_URL_VARIANT_ID, DERIVED_STEP_ID);
    await mkdir(join(dir, 'captures', ONE_URL_VARIANT_ID), { recursive: true });
    await mkdir(dirname(join(dir, screenshot)), { recursive: true });
    await writeFile(
      join(dir, 'captures', ONE_URL_VARIANT_ID, `${DERIVED_STEP_ID}.json`),
      JSON.stringify(
        { ...capture, variant: ONE_URL_VARIANT_ID, step: DERIVED_STEP_ID, screenshot },
        null,
        2,
      ),
    );
    await copyFile(
      join(COMMITTED, runPaths('').screenshot(RECORDED_VARIANT, first.step)),
      join(dir, screenshot),
    );

    return { dir, device: recorded.device, discard };
  } catch (error) {
    // Handed back only finished, so a caller has nothing to remove when a guard above
    // fires — which one will the day the committed set stops recording a phone variant.
    await discard();
    throw error;
  }
};

/**
 * The same source, holding every session at its first capture until the walk lets go.
 *
 * It is what makes *"the id is answered while the run is still running"* an assertion rather
 * than a race: no session can land while the gate is shut, so a run that says `open` at the
 * moment of the `201` says so because it is still running and not because the test was quick
 * enough to look first.
 */
export const heldAtFirstCapture = (
  inner: CaptureSource,
): { source: CaptureSource; release: () => void } => {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    release: () => {
      open();
    },
    source: {
      ...inner,
      capture: async (page, context) => {
        await gate;
        return await inner.capture(page, context);
      },
    },
  };
};
