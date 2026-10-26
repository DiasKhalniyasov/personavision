import type { Audience } from '@personavision/contract';
import type { AudienceStore } from '../store/types.js';

/**
 * The copy a test freezes.
 *
 * `RunRequest` names the audience a test is for **by id**, and `runSchema` carries it **by
 * value**: this function is the step between the two. It resolves the id against the
 * workspace that asked and hands back a copy, so that the pipeline writes into `run.json`
 * an audience nothing else holds a reference to.
 *
 * That is the one rule here that protects an old result. A finished test reports the
 * audience it ran for; editing the stored audience afterwards must not restate it. Storing
 * a reference — or handing the pipeline the store's own object — would make every finished
 * test's reported audience a live read of whatever the audience says today, and the
 * credibility of a result from last month would be gone without anybody touching it.
 */

/**
 * An audience a new test cannot be started for: not this workspace's, or soft-deleted.
 *
 * Both are the same answer on purpose. A deleted audience stays readable, because a test
 * that used it names it; it is no longer **offered**, because the user said they were done
 * with it, and a test started for it now would describe customers they have stopped
 * describing.
 */
export class AudienceNotOfferedError extends Error {
  readonly audienceId: string;

  constructor(audienceId: string) {
    super(`there is no audience "${audienceId}" to start a test for.`);
    this.name = 'AudienceNotOfferedError';
    this.audienceId = audienceId;
  }
}

export const audienceForNewTest = async (
  audiences: AudienceStore,
  workspaceId: string,
  audienceId: string,
): Promise<Audience> => {
  const record = await audiences.byId(workspaceId, audienceId);
  if (record === null || record.deletedAt !== null) throw new AudienceNotOfferedError(audienceId);
  // A copy, not the stored object. The store happens to replace a record rather than
  // mutate one, so today the reference would survive an edit by luck; a copy is the rule
  // itself, and it holds whatever a second implementation of the store does.
  return structuredClone(record.audience);
};
