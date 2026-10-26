import { useSession, workspaceInitials } from './useSession';

/**
 * The account corner of the chrome.
 *
 * A slot: the shell names who is signed in, and **#103** fills in the menu itself —
 * account, workspace switching and signing out. Until then it does nothing, because the
 * only account route there is to reach is `/signin`, and a signed-in reader's own avatar
 * must not lead back to signing in.
 */
export function AccountMenu() {
  const state = useSession();
  if (state.status !== 'signed-in') return null;

  const { account, workspace } = state.session;

  return (
    <span className="avatar" data-shell="account-menu">
      <span className="sr-only">{`Signed in as ${account.name} of ${workspace.name}`}</span>
      <span aria-hidden="true">{workspaceInitials(workspace.name)}</span>
    </span>
  );
}
