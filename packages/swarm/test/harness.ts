/**
 * What every `runSession` test runs against: the committed capture set, the fixture site's
 * four-step task, and people to walk it.
 *
 * The capture set is `packages/browser`'s — recorded once from the fixture site and checked
 * in — so this suite starts no browser, opens no socket and reads the same bytes every time.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureSource } from '@personavision/browser';
import { createOfflineDeterministicProvider } from '@personavision/provider';
import type { CaptureSource, Device, TaskDefinition } from '@personavision/browser';
import type { Persona } from '@personavision/contract';
import type {
  Decision,
  DecisionContext,
  DecisionProvider,
  DecisionSession,
} from '@personavision/provider';
import type { RunSessionInput } from '../src/index.js';

/** The capture set `pnpm -F @personavision/browser record:captures` wrote. */
export const COMMITTED = fileURLToPath(
  new URL('../../browser/test/fixtures/captures', import.meta.url),
);

/** The two devices the committed set was recorded under, as its index records them. */
export const MOBILE: Device = {
  name: 'mobile',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  touch: true,
};

export const DESKTOP: Device = {
  name: 'desktop',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  touch: false,
};

/** The fixture site's checkout, as `packages/browser`'s own integration suite declares it. */
export const TASK: TaskDefinition = {
  id: 'checkout',
  prompt: 'Buy the canvas tote bag: check out, pay and place the order.',
  steps: [
    {
      id: 'cart',
      label: 'Cart',
      match: { urlPattern: '/cart\\.html', requiredSelector: '#cart-items' },
      primaryAction: { selector: '#cart-checkout' },
    },
    {
      id: 'payment',
      label: 'Payment',
      match: { urlPattern: '/payment\\.html', requiredSelector: '#payment-form' },
      primaryAction: { selector: '#payment-submit' },
    },
    {
      id: 'review',
      label: 'Review',
      match: { urlPattern: '/review\\.html', requiredSelector: '#review-summary' },
      primaryAction: { selector: '#review-place-order' },
    },
    {
      id: 'confirmation',
      label: 'Confirmation',
      match: { urlPattern: '/confirmation\\.html', requiredSelector: '#confirmation-receipt' },
      primaryAction: { selector: '#confirmation-continue-shopping' },
    },
  ],
};

/** The variant the committed set recorded at each device's viewport. */
export const variantFor = (id: 'A' | 'B') => ({ id, url: 'https://fixture.test/cart.html' });

const TRAITS = {
  careful: {
    persistence: 0.8,
    scanningVsReading: 0.3,
    detailOrientation: 0.8,
    interfaceFamiliarity: 0.6,
    patience: 0.8,
    riskTolerance: 0.3,
  },
  rushed: {
    persistence: 0.25,
    scanningVsReading: 0.9,
    detailOrientation: 0.2,
    interfaceFamiliarity: 0.75,
    patience: 0.15,
    riskTolerance: 0.7,
  },
} as const satisfies Record<string, Persona['traits']>;

/** One generated person, as `packages/personas` would hand it over. */
export const personaWho = (who: keyof typeof TRAITS, device: Device = MOBILE): Persona => ({
  id: who,
  name: who === 'careful' ? 'Careful comparer' : 'Rushed buyer',
  audienceId: 'outdoor-gear-shoppers',
  segment: who === 'careful' ? 'Careful comparer' : 'Rushed buyer',
  traits: TRAITS[who],
  device,
});

/** A run directory of its own per test, swept afterwards. */
export const temporaryRunDir = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), 'personavision-swarm-'));

export const sweep = async (runDir: string): Promise<void> => {
  await rm(runDir, { recursive: true, force: true });
};

/** Everything a session needs, with the committed set replaying it and nobody watching. */
export const sessionOver = (
  runDir: string,
  over: Partial<RunSessionInput> = {},
): RunSessionInput => ({
  runDir,
  runId: '2026-10-27-1200-fixture',
  sessionId: 'S-01',
  variant: variantFor('A'),
  persona: personaWho('careful'),
  seed: 11,
  task: TASK,
  source: createFixtureSource(COMMITTED),
  providers: { decision: createOfflineDeterministicProvider({ seed: 11 }) },
  // Fixed, because a reproducible session is reproducible in every field and the clock is
  // the one thing this loop cannot derive.
  startedAt: '2026-10-27T12:00:00.000Z',
  ...over,
});

/** A provider that answers whatever a test tells it to, through one session handle or none. */
export const providerThat = (
  answer: (context: DecisionContext) => Decision,
  over: Partial<Pick<DecisionProvider, 'name' | 'mode' | 'readsImages'>> = {},
): DecisionProvider => {
  const decide = async (context: DecisionContext): Promise<Decision> => answer(context);
  return {
    name: 'test-provider',
    mode: 'offline',
    readsImages: false,
    ...over,
    decide,
    beginSession: ({ personaId, seed }): DecisionSession => ({
      personaId,
      seed,
      decide,
      close: async () => undefined,
    }),
  };
};

/** Every context one provider was handed, in the order the session asked. */
export const recording = (
  inner: DecisionProvider,
): { provider: DecisionProvider; contexts: DecisionContext[] } => {
  const contexts: DecisionContext[] = [];
  const watch =
    (decide: DecisionSession['decide']): DecisionSession['decide'] =>
    (context) => {
      contexts.push(context);
      return decide(context);
    };
  return {
    contexts,
    provider: {
      ...inner,
      decide: watch((context) => inner.decide(context)),
      beginSession: (identity) => {
        const session = inner.beginSession(identity);
        return { ...session, decide: watch((context) => session.decide(context)) };
      },
    },
  };
};

/** Every action one source was asked to perform, in order. */
export const watchingActs = (
  inner: CaptureSource,
): { source: CaptureSource; acts: Parameters<CaptureSource['act']>[1][] } => {
  const acts: Parameters<CaptureSource['act']>[1][] = [];
  return {
    acts,
    source: {
      ...inner,
      act: (page, action, ctx, options) => {
        acts.push(action);
        return inner.act(page, action, ctx, options);
      },
    },
  };
};
