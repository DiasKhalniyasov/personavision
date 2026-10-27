import { useNavigate } from 'react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { paths } from './paths';
import { signOut, useSession, workspaceInitials } from './useSession';

/**
 * The account corner of the chrome: who is signed in, and the one action there is.
 *
 * `#chrome` in `docs/design/prototype.html` draws it as the round `.avatar` button carrying
 * the workspace's initials, titled *signed in as … — account and sign out*. The menu it
 * opens names the account by its email — the chrome already names the workspace beside the
 * product name — and offers **Sign out**, which ends the session on the server, forgets
 * every run this app read under it, and returns to `/signin`. A reload does not get back
 * in: the cookie is gone and `GET /auth/session` answers that nobody is signed in.
 *
 * Nothing renders for a visitor with no session, because the public pages carry no chrome.
 * The dropdown is Radix's, so the keyboard and the screen reader behave without this file
 * saying anything about either.
 */
export function AccountMenu() {
  const state = useSession();
  const navigate = useNavigate();

  if (state.status !== 'signed-in') return null;

  const { account, workspace } = state.session;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        // `.avatar` in `styles/chrome.css` is the prototype's round chip; the three
        // utilities beside it undo what a browser gives a `<button>` and nothing else.
        className="avatar cursor-pointer appearance-none p-0"
        data-shell="account-menu"
        aria-label={`Signed in as ${account.name} of ${workspace.name} — account and sign out`}
      >
        <span aria-hidden="true">{workspaceInitials(workspace.name)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{account.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            // The server ends the session first; only then is the reader moved, so the
            // chrome is never left naming a workspace they have asked to leave.
            void signOut().then(() => {
              void navigate(paths.signIn, { replace: true });
            });
          }}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
