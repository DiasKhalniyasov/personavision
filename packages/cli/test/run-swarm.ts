import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureSource } from '@personavision/browser';
import { GENERATOR_VERSION } from '@personavision/personas';
import { createDecisionSession, FREE_USAGE, MODEL_ID_BY_MODE } from '@personavision/provider';
import { oneDeviceCaptureSet, TASK } from '../../swarm/test/harness.js';
import type { Audience } from '@personavision/contract';
import type {
  Decision,
  DecisionProvider,
  DecisionSession,
  ModelMode,
} from '@personavision/provider';
import type { RunCommandOptions } from '../src/commands/run.js';

/**
 * What `personavision run` is driven with in these tests: the committed capture set of
 * `packages/browser`, the fixture task it was recorded against, and an audience of people
 * on the one device it was recorded under.
 *
 * Nothing here starts a browser or opens a socket: the capture source replays the recorded
 * bytes, which is what makes the suite deterministic and what lets it assert the whole
 * command on a machine with no Chromium and no key.
 */

/**
 * What stands in for the model credential in this suite.
 *
 * It is not a credential and could not be one: what the tests assert is that its value
 * reaches no printed line and no written file, which is the one promise about a key that a
 * test can actually check.
 */
export const STAND_IN_CREDENTIAL = 'a-stand-in-for-the-model-credential';

/** The device the committed set was recorded under, as the audience declares one. */
const MOBILE_AUDIENCE_DEVICE = {
  name: 'mobile',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  touch: true,
  share: 1,
};

/**
 * An audience of `size` people, all on the capture set's own device.
 *
 * It is written to a file rather than passed as a value because that is the surface under
 * test: `--audience <path>` is how a developer runs a swarm for an audience nobody has
 * stored, and the file is parsed and copied into the artifact by value.
 */
export const audienceOf = (size: number): Audience => ({
  id: 'fixture-shoppers',
  name: 'Fixture shoppers',
  ageRange: { min: 25, max: 45 },
  roles: ['First-time buyer', 'Returning customer'],
  regions: ['United Kingdom'],
  goals: ['Buy one item quickly'],
  devices: [MOBILE_AUDIENCE_DEVICE],
  techSavviness: 0.55,
  priceSensitivity: 0.75,
  size,
  generatedFrom: { seed: 7, generatorVersion: GENERATOR_VERSION },
});

export interface RunFixture {
  /** Where the command writes run directories. */
  runsRoot: string;
  /** Everything `runCommand` needs, with the capture set replaying and nobody watching. */
  options: (over?: Partial<RunCommandOptions>) => RunCommandOptions;
  /** Every line the command printed, in order. */
  printed: () => string[];
  cleanup: () => Promise<void>;
}

/** The fixture task's steps, as a `--steps` file declares them. */
const stepsFile = async (dir: string): Promise<string> => {
  const file = join(dir, 'steps.json');
  await writeFile(file, JSON.stringify({ steps: TASK.steps }, null, 2));
  return file;
};

const audienceFile = async (dir: string, audience: Audience): Promise<string> => {
  const file = join(dir, 'audience.json');
  await writeFile(file, JSON.stringify(audience, null, 2));
  return file;
};

/**
 * A workspace of its own per test: a runs root, an audience file, a steps file and the
 * capture set both variants were recorded in at one device.
 */
export const runFixture = async ({ size = 2 } = {}): Promise<RunFixture> => {
  const dir = await mkdtemp(join(tmpdir(), 'personavision-run-'));
  const runsRoot = join(dir, 'runs');
  const captures = await oneDeviceCaptureSet();
  const audience = await audienceFile(dir, audienceOf(size));
  const steps = await stepsFile(dir);
  const lines: string[] = [];

  return {
    runsRoot,
    printed: () => [...lines],
    options: (over = {}) => ({
      runsRoot,
      url: ['https://fixture.test/cart.html', 'https://fixture.test/b/cart.html'],
      task: 'Buy the canvas tote bag and place the order',
      audience,
      repeats: '1',
      seed: '11',
      mode: 'contributor',
      steps,
      log: (line) => void lines.push(line),
      source: createFixtureSource(captures),
      // Nothing of this environment reaches a test: no key means offline, which is what the
      // whole suite runs on.
      env: {},
      onStop: () => (): void => undefined,
      ...over,
    }),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(captures, { recursive: true, force: true });
    },
  };
};

/**
 * A model provider that answers every screen the same way, at a known cost.
 *
 * It names the model id the mode it was built for maps to, because the selection refuses a
 * provider that names another — which is the substitution it exists to prevent — and it
 * reports usage, so a run through it has a bill the report can be asserted against.
 */
export const fakeModelProvider = (modelMode: ModelMode): DecisionProvider => {
  const modelId = MODEL_ID_BY_MODE[modelMode];
  // Every session gives up on its first screen, so a model run through this provider is one
  // call per session: what is under test is the record and the report of a model run, not how
  // far an agent gets.
  const decide = async (): Promise<Decision> => ({
    intent: 'This is not worth my time.',
    action: { kind: 'abandon', targetElementId: null },
    usage: {
      ...FREE_USAGE,
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 200,
      reasoningTokens: 150,
      estimatedCostUsd: 0.000_12,
    },
    model: { modelId, mode: modelMode },
  });
  return {
    name: 'fake-model',
    mode: 'model',
    readsImages: false,
    modelId,
    decide,
    beginSession: ({ personaId, seed }): DecisionSession =>
      createDecisionSession({ personaId, seed, decide }),
  };
};
