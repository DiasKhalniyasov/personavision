import { AudienceValidationError, generatePersonas } from '@personavision/personas';
import type { AudienceIssue } from '@personavision/personas';
import type { Audience, Persona } from '@personavision/contract';
import type { AudienceRecord } from '../store/types.js';

/**
 * A stored audience as the screens read it: the audience, and the people it would generate.
 *
 * The people are generated rather than stored. `docs/FLOW.md` section 1 makes the audience
 * the object and the people its consequence — "the people this generates" on the Audience
 * screen (#109) is the generator's output for this audience and its seed, shown and never
 * edited. Storing them would be a second copy that an edit to the audience could leave
 * standing, which is the same mistake as storing a reference to the audience in a run.
 */

export interface AudienceWithPeople {
  /** The record's id, which `RunRequest.audienceId` names. */
  readonly id: string;
  /** The audience itself, in `@personavision/contract`'s shape and no other. */
  readonly audience: Audience;
  /** The people this audience and its seed generate. Empty when `issues` says why not. */
  readonly people: readonly Persona[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Soft-deleted: still readable, no longer offered for a new test. */
  readonly deletedAt: string | null;
  /**
   * Why this audience generates nobody, by audience path, or empty.
   *
   * An audience is validated before it is stored, so this is all but always empty. It is
   * here because one case survives storage: an audience written by a generator version this
   * build does not implement. Its people were reproducible against that version and are not
   * against this one, so the generator refuses it — and one such audience must say so on its
   * own card rather than taking the whole list down with a 500.
   */
  readonly issues: readonly AudienceIssue[];
}

const peopleOf = (audience: Audience): { people: Persona[]; issues: AudienceIssue[] } => {
  try {
    return { people: generatePersonas(audience), issues: [] };
  } catch (error) {
    if (error instanceof AudienceValidationError) return { people: [], issues: [...error.issues] };
    throw error;
  }
};

/**
 * The record and its people, as every audience route answers with.
 *
 * `workspaceId` is not in the answer: a request reads its own session's workspace and no
 * other, so naming it back would state what the reader already is. Nothing of the platform
 * belongs in an audience either way — a run artifact carries a copy of this audience, and it
 * never carries an account id or a workspace id (`CONTEXT.md`).
 */
export const withPeople = (record: AudienceRecord): AudienceWithPeople => ({
  id: record.id,
  audience: record.audience,
  ...peopleOf(record.audience),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  deletedAt: record.deletedAt,
});
