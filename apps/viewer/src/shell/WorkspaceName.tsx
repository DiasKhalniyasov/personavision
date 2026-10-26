import { useSession } from './useSession';

/**
 * Whose data this is: the workspace the signed-in account is in.
 *
 * A slot in the chrome. The shell renders the name the session carries; **#103** fills in
 * the rest — switching workspace, and what a reader with more than one sees.
 */
export function WorkspaceName() {
  const state = useSession();
  if (state.status !== 'signed-in') return null;

  return (
    <span className="wsname" data-shell="workspace-name">
      <strong>{state.session.workspace.name}</strong> <span className="faint">workspace</span>
    </span>
  );
}
