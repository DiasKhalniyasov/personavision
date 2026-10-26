import type { PlatformStore, WorkspaceRecord } from '../store/types.js';

/**
 * The workspace model, which is one rule long: an account is **a member of a workspace**,
 * and that is the only role there is. Anything finer — roles, permissions, invitations —
 * is deferred by `docs/FLOW.md` section 9 and nothing here builds toward it.
 *
 * The model is additive by construction: a workspace holds member account ids and a run
 * directory belongs to a workspace by what the store says, so a second member or a role
 * is a field on these records rather than a reshaping of them.
 */

/**
 * The workspace a sign-in lands in, or `null` for an account that is a member of none.
 *
 * One account is a member of exactly one workspace today — seeding creates the pair — so
 * the first of the store's answers is the answer. The day an account may belong to two,
 * this is the one place that has to choose between them, and the signed-in chrome gains a
 * switcher rather than every caller gaining a workspace argument.
 */
export const workspaceForAccount = async (
  store: PlatformStore,
  accountId: string,
): Promise<WorkspaceRecord | null> => {
  const workspaces = await store.workspaces.forAccount(accountId);
  return workspaces[0] ?? null;
};
