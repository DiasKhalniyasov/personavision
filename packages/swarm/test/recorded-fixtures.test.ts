/**
 * The committed capture set, held to the pages it was recorded from.
 *
 * `../fixtures/site/` and `../fixtures/captures/` are one thing: the behaviour suite measures
 * what is in the pixels and the words of those pages, and nothing in a capture says which
 * page it came from. So `record-fixtures.ts` writes a digest of the pages beside the set, and
 * this is where it is compared — a page edited without a re-recording fails here rather than
 * leaving `behaviour.test.ts` measuring a screen that is no longer there.
 *
 * A digest rather than a second recording, because re-recording needs Chromium and a server
 * and this has to run on a cold clone with nothing installed. `recordFixtures` is exported
 * for a ticket that wants the stronger check, as `packages/browser` has for its own set.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  BEHAVIOUR_CAPTURES,
  BEHAVIOUR_DEVICE,
  RECORDED_FROM,
  RECORDED_FROM_FORMAT_VERSION,
  SCENARIOS,
  siteDigest,
} from './fixtures.js';
import type { RecordedFrom } from './fixtures.js';

const RE_RECORD = 'run `pnpm -F @personavision/swarm record:fixtures`';

it('was recorded from the pages as they stand', async () => {
  const committed = JSON.parse(await readFile(RECORDED_FROM, 'utf8')) as RecordedFrom;

  expect(committed.formatVersion).toBe(RECORDED_FROM_FORMAT_VERSION);
  expect(
    committed.site,
    `a page of the behaviour fixture site has changed since the capture set was recorded: ${RE_RECORD}`,
  ).toEqual((await siteDigest()).site);
});

it('records every scenario the suite walks, at the one device', async () => {
  const index = JSON.parse(
    await readFile(join(BEHAVIOUR_CAPTURES, 'capture-set.json'), 'utf8'),
  ) as {
    variants: { id: string; device: unknown; steps: { step: string }[] }[];
  };

  expect(
    index.variants.map((variant) => ({
      variant: variant.id,
      steps: variant.steps.map((step) => step.step),
    })),
    `the capture set does not hold the scenarios test/fixtures.ts declares: ${RE_RECORD}`,
  ).toEqual(SCENARIOS.map(({ variant, steps }) => ({ variant, steps: [...steps] })));
  // One device for every variant: the same people walk all three, and a person has one.
  for (const variant of index.variants) expect(variant.device).toEqual(BEHAVIOUR_DEVICE);
});
