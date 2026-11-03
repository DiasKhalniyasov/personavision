/**
 * The runner seam: what it takes to walk **one** session, and what one session gives back.
 *
 * There are two implementations and there will not be a third without a reason: the swarm's
 * own pool, which runs a session in this process (#275), and a Cloud Run job execution per
 * session (#317). `choose.ts` picks between them from one environment variable, and nothing
 * downstream of that choice branches on it — a session is a session wherever it runs, with
 * the same persona, the same seed, the same capture and the same written session file.
 *
 * The request is deliberately **flat and mostly serializable**: a remote runner has to put
 * what a session needs into a container's environment, and a request shaped like the swarm's
 * whole input would have tempted it to send a provider down a wire. The three fields that
 * cannot cross a process boundary — the capture source, the decision provider and the
 * segmenter — are the three a remote task builds for itself at the far end.
 */

import type { CaptureSource, TaskDefinition, Variant } from '@personavision/browser';
import type { Persona, Run, RunUsage, Session } from '@personavision/contract';
import type { Aoi, EngineConfigOverrides, Segmenter } from '@personavision/engine';
import type { OutcomePolicy } from '../outcome.js';
import type { SessionProviders } from '../run-session.js';

/**
 * What one session produced, and what of it belongs to the run.
 *
 * Every field is read by the swarm's own bookkeeping — the session is written, the usage is
 * totalled, the areas and screens are declared on `run.json` — so a remote runner owes the
 * same four, which is why a remote task writes its run contributions beside its session
 * rather than leaving the coordinator to guess at them.
 */
export interface WalkedSession {
  readonly session: Session;
  readonly usage: RunUsage;
  readonly aois: readonly Aoi[];
  readonly screenshots: Run['screenshots'];
  readonly elapsedMs: number;
  /**
   * Set only for a session the race gave up on: it is still running, and `runSession` writes
   * its own file when it lands. `null` for a session that answered, which is every session
   * of a run that went well — and always `null` from a remote runner, which cancels what it
   * stopped waiting for instead of leaving it to land later.
   */
  readonly landsLate: Promise<unknown> | null;
}

/** One session, as the swarm asks for it. */
export interface SessionRunRequest {
  /** The open run directory. A remote session's output reaches it through #316's store. */
  readonly runDir: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly persona: Persona;
  readonly variant: Variant;
  readonly seed: number;
  readonly task: TaskDefinition;
  /** When the swarm stamped this session, which is the `startedAt` it will be written with. */
  readonly startedAt: string;
  /** How long this session may take, in wall-clock milliseconds. */
  readonly timeoutMs: number;
  readonly outcomePolicy?: OutcomePolicy;
  readonly maxScreens?: number;
  readonly weights?: EngineConfigOverrides;
  /** The three a remote task builds at the far end rather than receives. */
  readonly source: CaptureSource;
  readonly providers: SessionProviders;
  readonly segmenter?: Segmenter;
}

/**
 * One session, start to finish. It **does not throw for a session that broke**: breakage is
 * the session's own automation failure, recorded and handed back, because the swarm's rule is
 * that one bad page costs one session and not a run. A runner throws only for something that
 * makes the whole run unrunnable.
 */
export type SessionRunner = (request: SessionRunRequest) => Promise<WalkedSession>;
