import { FREE_USAGE } from './decision.js';
import { parseWonderReply } from './wonder.js';
import type { WonderAsk, WonderProvider, WonderReply } from './wonder.js';

/**
 * The offline deterministic one-shot implementation — the project's **default**, and the
 * only Wonder implementation that runs with no key and no network.
 *
 * It holds no prompt, knows nothing about any of the four uses and has no case per use: it
 * answers every ask from that ask's own generator, holds the answer to that ask's own
 * validator, and reports what the call cost — nothing, in all five figures, truthfully
 * rather than leaving a cost unknown. That is the whole of it, and it is why the four uses
 * can be written independently of each other and of this file.
 *
 * **Deterministic per ask, not per provider.** The seed handed to the generator is derived
 * from the ask's seed *and* its document, exactly as the offline decision policy derives its
 * stream from the seed and a digest of the context — so the same sentence on one seed is the
 * same audience wherever it is asked and in whatever order, two different sentences on one
 * seed are two different audiences, and a provider that has already answered three asks
 * answers the fourth exactly as a fresh one would.
 */

/** As a run or a log line records it. */
export const OFFLINE_WONDER_PROVIDER_NAME = 'offline-deterministic-wonder';

/**
 * FNV-1a over the ask's identity, in 32-bit integer arithmetic only, so there is no
 * floating-point drift between platforms.
 *
 * The offline decision policy keeps its own copy of these seven lines, private to that file.
 * They are restated here rather than shared on purpose: the alternative is for the one-shot
 * implementation to import from the decision policy, which would couple the two seams this
 * package deliberately keeps apart (`docs/adr/0003-the-one-shot-wonder-seam.md`) in order to
 * borrow a pure function. The two streams are independent — nothing requires the two copies
 * to agree, and a change to either is correct on its own.
 */
const hash32 = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/**
 * The seed one ask's generator is answered from: the ask's own seed, mixed with which use it
 * is and the document it carries.
 *
 * The use is in the mix as well as the document, so that the same sentence asked as an
 * audience and as a goal is two seeds rather than one — a use's generator is free to produce
 * its shape from the whole stream without having to wonder who else draws from it.
 */
const seedFor = (ask: WonderAsk<unknown>): number =>
  (hash32(`${ask.use}\n${ask.document}`) ^ Math.imul(ask.seed >>> 0, 0x9e3779b1)) >>> 0;

/**
 * The offline deterministic Wonder implementation. Costs nothing, reaches no network, reads
 * no credential, and answers the same ask the same way every time.
 */
export const createOfflineWonderProvider = (): WonderProvider => ({
  name: OFFLINE_WONDER_PROVIDER_NAME,
  mode: 'offline',
  // `async`, although nothing here awaits: `ask` promises a promise, so a refusal is a
  // rejected one. A body that threw synchronously would be a refusal a caller holding the
  // promise never sees, and the contract suite — which refuses through `.then`'s second
  // argument on purpose — is where that was caught.
  ask: async <T>(ask: WonderAsk<T>): Promise<WonderReply<T>> => ({
    // The generator's answer goes through the ask's validator like a model's reply would: a
    // use whose offline shape has drifted from the schema it validates against is an error
    // naming the path, and not an object a screen would then have to cope with.
    value: parseWonderReply(ask, ask.offline(seedFor(ask)), null),
    model: null,
    usage: FREE_USAGE,
  }),
});
