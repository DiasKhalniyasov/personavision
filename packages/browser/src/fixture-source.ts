/**
 * A capture source that replays committed captures from a directory.
 *
 * This is the default in tests and in the engine's offline mode: no network, no Chromium
 * navigation, and the same bytes every time, so the engine, the swarm and their tests are
 * deterministic. It answers the same `CaptureSource` interface as the live source, so
 * nothing downstream knows which one it has.
 *
 * **Neutral seam.** Nothing can be replayed yet. The fixture-mode ticket of this step fills
 * this file and no other.
 */

import { notImplemented } from './errors.js';
import type { CaptureSource } from './types.js';

export type CreateFixtureSource = (dir: string) => CaptureSource;

export const createFixtureSource: CreateFixtureSource = () => {
  throw notImplemented('fixture source');
};
