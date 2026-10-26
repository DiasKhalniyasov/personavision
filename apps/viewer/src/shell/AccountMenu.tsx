import { Link } from 'react-router';
import { paths } from './paths';
import { useSession, workspaceInitials } from './useSession';

/**
 * The account corner of the chrome.
 *
 * A slot: the shell renders who is signed in and a way to reach the account, and **#103**
 * fills in the menu itself — account, workspace switching and signing out. It is a link
 * rather than a button, so the chrome is operable by keyboard with nothing to fill in yet.
 */
export function AccountMenu() {
  const state = useSession();
  if (state.status !== 'signed-in') return null;

  const { account, workspace } = state.session;

  return (
    <Link
      className="avatar"
      data-shell="account-menu"
      to={paths.signIn}
      aria-label={`Signed in as ${account.name} of ${workspace.name} — account and sign out`}
    >
      <span aria-hidden="true">{workspaceInitials(workspace.name)}</span>
    </Link>
  );
}
