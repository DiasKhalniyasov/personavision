import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../store/password.js';
import type {
  AccountRecord,
  PasswordVerifier,
  PlatformStore,
  SessionRecord,
  WorkspaceRecord,
} from '../store/types.js';
import { workspaceForAccount } from '../workspace/membership.js';

/**
 * Signing in: an email and a password in, a server-side session record out.
 *
 * Everything an attacker could learn from the outcome is the same for an email nobody
 * has, a password that is wrong and an account with no workspace — one `null`, and the
 * same work done before it. The caller turns that into one deliberately vague failure.
 *
 * Rate limiting and lockout are out of scope (#101), and this shape is why they can
 * arrive as a wrapper: a limiter wraps `signIn`, counts what it returns, and needs no
 * change in here.
 */

export interface Credentials {
  email: string;
  password: string;
}

export interface SignedIn {
  session: SessionRecord;
  account: AccountRecord;
  workspace: WorkspaceRecord;
}

export interface SignInOptions {
  store: PlatformStore;
  /** How long the new session lasts, absolutely: it ends when it ends, it does not slide. */
  lifetimeSeconds: number;
}

/**
 * A verifier for a password nobody has, hashed with the same parameters as a real one.
 *
 * An email nobody has is answered by verifying against this instead of returning early,
 * so the cost of the answer does not say whether the account exists — the whole point of
 * a slow hash is that skipping it is measurable. It is built on first use rather than at
 * import, because a scrypt derivation is 16 MiB of work that a process which never sees a
 * failed sign-in should not do.
 */
let decoy: Promise<PasswordVerifier> | null = null;
const decoyVerifier = (): Promise<PasswordVerifier> =>
  (decoy ??= hashPassword(randomBytes(16).toString('hex')));

export const signIn = async (
  { email, password }: Credentials,
  { store, lifetimeSeconds }: SignInOptions,
): Promise<SignedIn | null> => {
  const account = await store.accounts.byEmail(email);
  if (account === null) {
    await verifyPassword(password, await decoyVerifier());
    return null;
  }
  if (!(await verifyPassword(password, account.password))) return null;

  const workspace = await workspaceForAccount(store, account.id);
  if (workspace === null) {
    // The credentials were right, so this is the server's fault rather than the user's,
    // and whoever runs it is the one who can fix it. The account id and nothing else: the
    // password is never written anywhere, and an email in a log line is still an email.
    process.stderr.write(
      `personavision: account ${account.id} is a member of no workspace and cannot sign in\n`,
    );
    return null;
  }

  const session = await store.sessions.create({
    accountId: account.id,
    workspaceId: workspace.id,
    expiresAt: new Date(Date.now() + lifetimeSeconds * 1000).toISOString(),
  });
  return { session, account, workspace };
};
