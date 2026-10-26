import { describe, expect, it } from 'vitest';
import { createMetaModelApiProvider } from '../src/meta-model.js';
import type { TrajectoryRecord } from '../src/meta-model.js';
import { MODEL_ID_BY_MODE } from '../src/meta-pricing.js';
import { MODEL_API_KEY_ENV } from '../src/select.js';
import { SESSION_STEPS, walkSession } from './fixtures.js';

/**
 * The one test in this package that calls the real API.
 *
 * It runs when `MODEL_API_KEY` is in the environment and skips — visibly, with the reason in
 * its name — when it is not, so CI has nothing to configure and makes no call. It runs in
 * **contributor** mode, because our own tests are exactly what the cheaper tier is for; the
 * owner's note is explicit that development, tests and demos use it.
 *
 * What it is here to settle is the one thing the pricing page does not document: whether the
 * prompt cache is automatic, and what it takes to hit it. The second turn of one session is
 * sent with the first turn's bytes as its prefix, and the assertion is on what the API
 * reported — `usage.input_tokens_details.cached_tokens` — rather than on what we hoped.
 */

const apiKey = process.env[MODEL_API_KEY_ENV]?.trim() ?? '';
const live = apiKey === '' ? it.skip : it;
const skipped = apiKey === '' ? ` — skipped: no ${MODEL_API_KEY_ENV} in the environment` : '';

describe('the live Meta Model API', () => {
  live(
    `decides two screens of one session and reports cached input on the second${skipped}`,
    async () => {
      const records: TrajectoryRecord[] = [];
      const provider = createMetaModelApiProvider({
        mode: 'contributor',
        trajectory: (record) => void records.push(record),
      });
      const session = provider.beginSession({ personaId: 'p-live', seed: 1 });

      const decisions = await walkSession(session, SESSION_STEPS.slice(0, 2));
      await session.close();

      expect(decisions).toHaveLength(2);
      for (const decision of decisions) {
        expect(decision.model).toEqual({
          mode: 'contributor',
          modelId: MODEL_ID_BY_MODE.contributor,
        });
        expect(decision.usage.inputTokens).toBeGreaterThan(0);
        expect(decision.usage.estimatedCostUsd).toBeGreaterThan(0);
      }

      // What the run is here to observe, logged so that the figures can be written down
      // against the published prices (#133, and the comment this ticket owes #43).
      console.info('live usage', JSON.stringify(decisions.map((decision) => decision.usage)));

      // The point of the whole caching protocol: the second turn's prefix is the first
      // turn's bytes, so the provider is billed for it at the cached rate.
      expect(decisions[1]?.usage.cachedInputTokens).toBeGreaterThan(0);

      // And the trajectory a run would have kept: both turns, in order, with no header.
      expect(records.map((record) => `${record.turn}:${record.kind}`)).toEqual([
        '1:request',
        '1:response',
        '2:request',
        '2:response',
      ]);
      expect(JSON.stringify(records)).not.toContain(apiKey);
    },
    180_000,
  );
});
