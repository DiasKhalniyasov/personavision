import { hashPassword } from '../store/password.js';
import type { PlatformStore } from '../store/types.js';
import { workspaceForAccount } from '../workspace/membership.js';
import type { SignedIn } from './signin.js';

/**
 * Signing up: an email, a password and a name for the workspace in; an account, a
 * workspace, and the session the browser is already signed in with out.
 *
 * It is the only way a workspace comes into existence other than seeding (#100), and it
 * creates the pair the workspace model is made of — an account, and one workspace it is a
 * member of (`workspace/membership.ts`). Nothing finer: no role, no invitation, no plan.
 *
 * Where this deliberately parts from `signIn` is what a refusal says. A sign-in answers one
 * vague sentence, because a precise one would say which addresses have accounts and costs
 * the user nothing. A sign-up cannot do that: somebody told "those details are wrong" about
 * an email they already have an account for is stuck forever, so every refusal here names
 * the field it is about and an email that is taken is told so. The sentences themselves are
 * the route's (`server/routes/auth.ts`), as the sign-in route owns its own.
 */

/** The least a password may be, and the number the screen's own hint states. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * The most a workspace name may be.
 *
 * The chrome names the workspace on every screen of the product and there is no screen to
 * rename one on yet, so a name nobody can read is a workspace nobody can use. Sixty
 * characters is longer than any company name and short enough to sit in the bar.
 */
export const MAX_WORKSPACE_NAME_LENGTH = 60;

/** The most an email address may be: RFC 5321's own ceiling on a path. */
const MAX_EMAIL_LENGTH = 254;

export interface SignUpFields {
  email: string;
  password: string;
  workspaceName: string;
}

/**
 * Why a sign-up was refused, against the field it is about.
 *
 * A reason rather than a sentence: this module decides what is wrong, and the route decides
 * what to say and with which status, which is how `signIn` and its one sentence are split
 * too. The pairs are exhaustive by construction — there is no `too-short` email.
 */
export type SignUpRefusal =
  | { field: 'email'; reason: 'missing' | 'not-an-email' | 'taken' }
  | { field: 'password'; reason: 'missing' | 'too-short' }
  | { field: 'workspaceName'; reason: 'missing' | 'too-long' };

export type SignUpOutcome =
  { ok: true; signedIn: SignedIn } | { ok: false; refused: SignUpRefusal };

export interface SignUpOptions {
  store: PlatformStore;
  /** How long the new session lasts, absolutely — `signIn`'s own rule. */
  lifetimeSeconds: number;
}

/**
 * An address with a local part, an `@`, and a domain with a dot in it.
 *
 * Deliberately not a full RFC 5322 grammar: what this has to catch is the typo a person can
 * see — `owner`, `owner@localhost` — and what it must not do is refuse an address that
 * works. Anything stricter rejects somebody's real email, and the only proof an address is
 * reachable is reaching it, which is a later ticket's confirmation mail.
 */
const LOOKS_LIKE_AN_EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** What is wrong with these fields, or `null` — everything but whether the email is taken. */
const refusalOf = ({ email, password, workspaceName }: SignUpFields): SignUpRefusal | null => {
  if (email === '') return { field: 'email', reason: 'missing' };
  // An address past RFC 5321's ceiling is not an address, and says so with the same
  // sentence: there is nothing useful to tell somebody about a 60,000-character email.
  if (email.length > MAX_EMAIL_LENGTH || !LOOKS_LIKE_AN_EMAIL.test(email)) {
    return { field: 'email', reason: 'not-an-email' };
  }
  // Never trimmed: the spaces in a passphrase are characters of the password. There is no
  // ceiling either — the body cap is the only limit, and scrypt takes any length.
  if (password === '') return { field: 'password', reason: 'missing' };
  if (password.length < MIN_PASSWORD_LENGTH) return { field: 'password', reason: 'too-short' };
  // A name of only whitespace is a missing name: it is what the chrome would then show.
  if (workspaceName === '') return { field: 'workspaceName', reason: 'missing' };
  if (workspaceName.length > MAX_WORKSPACE_NAME_LENGTH) {
    return { field: 'workspaceName', reason: 'too-long' };
  }
  return null;
};

export const signUp = async (
  fields: SignUpFields,
  { store, lifetimeSeconds }: SignUpOptions,
): Promise<SignUpOutcome> => {
  // Trimmed the way the store normalises an email for lookup, so what is checked here is
  // what `accounts.byEmail` will find, and a name is stored without the spaces around it.
  const email = fields.email.trim();
  const workspaceName = fields.workspaceName.trim();
  const { password } = fields;

  const refused = refusalOf({ email, password, workspaceName });
  if (refused !== null) return { ok: false, refused };

  // Before anything is created, and after the free checks: a malformed address is never
  // looked up.
  //
  // "Taken" is an account **that has a workspace**, not merely an account. An account that
  // is a member of none is the wreckage of a sign-up that failed between its two writes,
  // and `signIn` refuses it too (it has no workspace to land in), so treating it as taken
  // would lock the address out for good — the dead end the specific wording exists to
  // prevent. Signing up again leaves a second record, and `accounts.byEmail` answers with
  // the newest, which is the one whose password somebody has.
  //
  // Two sign-ups racing on the same address are not guarded against here: the store has no
  // unique index to lean on, and the one that wrote first loses — `byEmail` hands back the
  // newer record, so its password no longer signs in and its workspace is reachable only
  // until its session expires. Rare enough to accept, and a limiter in front of this route
  // (#101) is where it is worth revisiting.
  const existing = await store.accounts.byEmail(email);
  if (existing !== null && (await workspaceForAccount(store, existing.id)) !== null) {
    return { ok: false, refused: { field: 'email', reason: 'taken' } };
  }

  const account = await store.accounts.create({
    email,
    // Sign-up asks for three things and a person's name is not one of them, so the account
    // is named for the workspace it owns — the shape the seeded workspace's account uses.
    // The account menu shows this until there is a screen to change it on.
    displayName: `${workspaceName} owner`,
    password: await hashPassword(password),
  });

  const workspace = await store.workspaces.create({
    name: workspaceName,
    memberAccountIds: [account.id],
    // A new workspace owns no run, and publishes none: `demoRunId` is the seeded demo
    // run's alone, and `modelMode` is omitted, which is `standard` — the only safe way
    // round for a workspace whose owner has not chosen (`store/types.ts`).
  });

  const session = await store.sessions.create({
    accountId: account.id,
    workspaceId: workspace.id,
    expiresAt: new Date(Date.now() + lifetimeSeconds * 1000).toISOString(),
  });

  return { ok: true, signedIn: { session, account, workspace } };
};
