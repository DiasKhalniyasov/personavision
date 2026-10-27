import { useId, useState } from 'react';
import type { ComponentProps, FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { NEXT_PARAM, paths } from '@/shell/paths';
import { signIn, useSession } from '@/shell/useSession';
import './signin.css';

/**
 * `/signin` — email and password against a workspace. Public, and the one screen on the
 * dark fir band.
 *
 * `#screen-signin` in `docs/design/prototype.html` is the acceptance: the band, the
 * wordmark above a single white card, the two fields, one primary action, the line that
 * tells a fresh installation's user where their password was printed, and the footnote.
 * There is no product chrome on it at all — no workspace name, no test picker, no tabs, no
 * badge — which is why its route sits outside `RequireSession` in `routes.tsx`.
 *
 * Signing in lands where the visitor was heading: `RequireSession` sent them here with the
 * path they asked for in `?next=`, and a visitor who came straight here goes to `/`, which
 * is the Verdict of the workspace's latest test. Somebody already signed in never reads
 * this screen — the same redirect takes them away before it paints.
 */

/**
 * Where a completed sign-in goes. Only a path of this site, so a crafted
 * `?next=https://elsewhere.example` cannot turn the sign-in form into an open redirect —
 * the rule `safeNextPath` applies in `packages/platform`, applied again on this side.
 */
const safeNext = (next: string | null): string =>
  next !== null && next.startsWith('/') && !next.startsWith('//') ? next : paths.home;

/** What the screen is reporting, and whether the visitor can simply try the same form again. */
interface Failure {
  readonly message: string;
  /** A server that could not be reached: the credentials were never tested. */
  readonly retryable: boolean;
}

/**
 * One field of the card: its real label, and the control or — while the session is being
 * resolved — a quiet placeholder of the control's own height, so the card does not change
 * shape when the answer arrives.
 */
function Field({
  id,
  label,
  resolving,
  describedBy,
  invalid,
  ...input
}: ComponentProps<typeof Input> & {
  id: string;
  label: string;
  resolving: boolean;
  describedBy: string | undefined;
  invalid: boolean;
}) {
  return (
    <div className="field-group">
      {resolving ? (
        // No `for` while there is no control to point at, and nothing for a screen reader
        // to read out: the row is here to hold the card's shape.
        <p className="field-label" aria-hidden="true">
          {label}
        </p>
      ) : (
        <Label htmlFor={id}>{label}</Label>
      )}
      {resolving ? (
        <Skeleton className="h-9 rounded-md" />
      ) : (
        <Input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          {...input}
        />
      )}
    </div>
  );
}

export function SignInPage() {
  const state = useSession();
  const [search] = useSearchParams();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sending, setSending] = useState(false);
  const errorId = useId();
  const emailId = useId();
  const passwordId = useId();

  // Signed in already, or signed in just now: on to the test they came for. `replace`, so
  // the back button does not land on a sign-in screen they are past.
  if (state.status === 'signed-in') {
    return <Navigate to={safeNext(search.get(NEXT_PARAM))} replace />;
  }

  const resolving = state.status === 'loading';

  /**
   * The submitted fields, read off the form rather than held in React state: the password
   * is never a value this module keeps, never a `value` attribute in the document, and
   * never part of a URL. The form is a POST, so a browser that submits it with no
   * JavaScript does not put the password in a query string either.
   */
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending) return;
    const fields = new FormData(event.currentTarget);
    const email = String(fields.get('email') ?? '');
    const password = String(fields.get('password') ?? '');

    setSending(true);
    setFailure(null);
    void signIn({ email, password }).then((result) => {
      setSending(false);
      // What was typed is still in the form: nothing here clears or rebuilds the fields, so
      // a wrong password is one correction rather than a form filled in again.
      if (!result.ok) setFailure({ message: result.error, retryable: result.unreachable });
    });
  };

  return (
    <div className="strip-dark signin-band">
      <div className="signin">
        <div>
          <p className="signin-mark">PersonaVision</p>
          <form
            className="signin-card"
            method="post"
            action={paths.signIn}
            onSubmit={onSubmit}
            aria-busy={resolving || sending || undefined}
          >
            <div>
              <h1>Sign in</h1>
              <p className="lede">Test a change on your own audience before you ship it.</p>
            </div>

            {/* Above the fields, and announced the moment it renders. One sentence for a
                wrong password and for an address nobody has: both fields are marked, so the
                reader re-reads both, and the form cannot be used to find out which
                addresses have accounts here. */}
            {failure !== null && (
              <p className="signin-error" id={errorId} role="alert">
                {failure.message}
                {failure.retryable && (
                  <Button type="submit" variant="outline" size="sm" disabled={sending}>
                    Try again
                  </Button>
                )}
              </p>
            )}

            <Field
              id={emailId}
              label="Work email"
              resolving={resolving}
              describedBy={failure === null ? undefined : errorId}
              invalid={failure !== null && !failure.retryable}
              name="email"
              type="email"
              autoComplete="username"
              required
              disabled={sending}
            />
            <Field
              id={passwordId}
              label="Password"
              resolving={resolving}
              describedBy={failure === null ? undefined : errorId}
              invalid={failure !== null && !failure.retryable}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={sending}
            />

            {resolving ? (
              <Skeleton className="h-10 rounded-full" />
            ) : (
              <Button type="submit" size="lg" disabled={sending}>
                {sending ? 'Signing in…' : 'Sign in'}
              </Button>
            )}

            <p className="demo-creds">
              A fresh install seeds one demo workspace, so this screen works with no cloud account:
              owner@northwind.example / the password printed by <b>personavision serve</b>.
            </p>
            <p className="footnote">
              No card, no API key. Your tests and audiences stay in your workspace.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
