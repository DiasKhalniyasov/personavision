import type { AudienceIssue } from './store';

/**
 * Where each thing wrong with an audience is rendered.
 *
 * Both validators — the form's own and the server's, which is
 * `@personavision/personas` — report at the path in the audience the problem is at, so a
 * refusal from either lands on the same field and the screen needs no second vocabulary.
 * A path no field on this form owns is not dropped: it goes to the message above the form,
 * because a save that was refused for a reason the reader cannot see is a save that looks
 * like a bug.
 */

export type FieldKey = 'name' | 'ageMin' | 'ageMax' | 'ageRange' | 'devices' | 'form';

const FIELD_OF: Readonly<Record<string, FieldKey>> = {
  name: 'name',
  // The id is derived from the name, and the name is the field the reader can change.
  id: 'name',
  'ageRange.min': 'ageMin',
  'ageRange.max': 'ageMax',
  ageRange: 'ageRange',
  devices: 'devices',
};

const fieldOf = (path: string): FieldKey => {
  const known = Object.hasOwn(FIELD_OF, path) ? FIELD_OF[path] : undefined;
  if (known !== undefined) return known;
  // `devices[1].share` is the device mix, which is one field on this form.
  return path.startsWith('devices') ? 'devices' : 'form';
};

export type IssuesByField = Readonly<Partial<Record<FieldKey, string>>>;

/** The first message per field, which is what the field has room to say. */
export const byField = (issues: readonly AudienceIssue[]): IssuesByField => {
  const byKey: Partial<Record<FieldKey, string>> = {};
  for (const issue of issues) {
    const key = fieldOf(issue.path);
    byKey[key] ??= key === 'form' ? `${issue.path}: ${issue.message}` : issue.message;
  }
  return byKey;
};

/** What the message above the form says when a save was refused. */
export const refusalSummary = (issues: readonly AudienceIssue[]): string =>
  issues.length === 1
    ? 'That audience could not be saved: one thing needs changing.'
    : `That audience could not be saved: ${String(issues.length)} things need changing.`;
