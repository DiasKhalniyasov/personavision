import { useId, useState } from 'react';
import type { ComponentProps, FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { paths } from '@/shell/paths';
import { forgetSession, useSession } from '@/shell/useSession';
import { createWorkspace } from './signup';
import type { SignUpField, SignUpRefusal } from './signup';
// The card on the dark band is one pattern the prototype draws twice — `#screen-signin` and
// `#screen-signup` are the same `.strip-dark` / `.signin` / `.signin-card` frame — so this
// screen takes that stylesheet rather than restating it, and adds only what it needs of its
// own. Every value in both comes from `docs/design/tokens.css`.
import '../signin/signin.css';
import './signup.css';

/**
 * `/signup` — a work email, a password and a name for the workspace. The way in.
 *
 * `#screen-signup` in `docs/design/prototype.html` is the acceptance: the dark band, the
 * wordmark above a single white card, the h1 and its lede, the three fields with the
 * password's own hint, the one primary action, and the footnote that says what the next step
 * is — so that a new workspace is never a screen with nothing on it. There is no product
 * chrome, which is why the route sits outside `RequireSession` in `routes.tsx`.
 *
 * A completed sign-up lands on `/sites`, signed in: the account, the workspace and the
 * session are all made by `POST /auth/signup`, and the cookie comes back with it.
 *
 * Where this parts from `/signin` on purpose is the refusals. A sign-in answers one vague
 * sentence, because saying more would say which addresses have accounts. A sign-up names the
 * field — and tells an email that already has a workspace so, with the link — because
 * somebody who cannot tell why they were refused has nowhere to go.
 */

/** What the screen is reporting. `null` is the empty state: the first render, nothing typed. */
type Failure = SignUpRefusal | null;

/**
 * One field of the card: its real label, the control, the hint under it where the prototype
 * draws one, and the refusal this field is carrying.
 *
 * While the session is being resolved the control is a quiet placeholder of its own height,
 * so the card does not change shape when the answer arrives — the same reason `/signin`
 * does it.
 */
function Field({
  id,
  label,
  hint,
  error,
  resolving,
  ...input
}: ComponentProps<typeof Input> & {
  id: string;
  label: string;
  hint?: string;
  error: string | null;
  resolving: boolean;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === null ? null : errorId]
    .filter((value): value is string => value !== null)
    .join(' ');

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
          aria-describedby={describedBy === '' ? undefined : describedBy}
          aria-invalid={error !== null || undefined}
          {...input}
        />
      )}
      {hint !== undefined && (
        <p className="footnote" id={hintId}>
          {hint}
        </p>
      )}
      {error !== null && (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function SignUpPage() {
  const state = useSession();
  const [failure, setFailure] = useState<Failure>(null);
  const [sending, setSending] = useState(false);
  const [created, setCreated] = useState(false);
  const emailId = useId();
  const passwordId = useId();
  const workspaceId = useId();
  const errorId = useId();

  // The workspace exists and the cookie is set, so this is the one journey that ends here:
  // on to `/sites`, which is where the next step is. Checked before the session below,
  // because signing up *is* signing in and the rule below would otherwise send them home.
  if (created) return <Navigate to={paths.sites} replace />;

  // Somebody already signed in is sent on rather than offered a second workspace: an
  // account is a member of one workspace, and this screen would create another.
  if (state.status === 'signed-in') return <Navigate to={paths.home} replace />;

  const resolving = state.status === 'loading';
  /** A failure about the request rather than about one field: above the form, once. */
  const aboveTheForm = failure !== null && failure.field === null ? failure : null;
  const errorFor = (field: SignUpField): string | null =>
    failure !== null && failure.field === field ? failure.message : null;

  /**
   * The submitted fields, read off the form rather than held in React state: the password is
   * never a value this module keeps, never a `value` attribute in the document, and never
   * part of a URL. The form is a POST, so a browser that submits it with no JavaScript does
   * not put the password in a query string either.
   *
   * Nothing here clears or rebuilds the fields, so a refusal is one correction rather than a
   * form filled in again — and the password is excluded from that by never being held in the
   * first place.
   */
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending) return;
    const fields = new FormData(event.currentTarget);

    setSending(true);
    setFailure(null);
    void createWorkspace({
      email: String(fields.get('email') ?? ''),
      password: String(fields.get('password') ?? ''),
      workspaceName: String(fields.get('workspaceName') ?? ''),
    }).then((result) => {
      setSending(false);
      if (!result.ok) {
        setFailure(result.refusal);
        return;
      }
      // The session this app knows about is signed out, and the cookie it would now send
      // is not: `useSession` asks the server again, and `/sites` renders behind the guard
      // with the new workspace named in the chrome.
      forgetSession();
      setCreated(true);
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
            action={paths.signUp}
            /* The browser's own validation is turned off so that the refusals are the
               platform's: a bubble reading "Please fill out this field" is neither in the
               user's words nor against the field in the page, and it would hide
               `POST /auth/signup`'s own sentences behind the first empty control. The
               fields keep `required` and their types, so a screen reader still announces
               them as required and a phone still offers the right keyboard. */
            noValidate
            onSubmit={onSubmit}
            aria-busy={resolving || sending || undefined}
          >
            <div>
              <h1>Create your workspace</h1>
              <p className="lede">
                Point it at your site, describe the people you serve, and watch a hundred of them
                try it.
              </p>
            </div>

            {/* A platform that cannot be reached, or an answer this app could not read:
                one sentence above the form, and the same form is worth sending again
                because nothing was created. */}
            {aboveTheForm !== null && (
              <p className="signin-error" id={errorId} role="alert">
                {aboveTheForm.message}
                {aboveTheForm.retryable && (
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
              error={errorFor('email')}
              name="email"
              type="email"
              autoComplete="username"
              required
              disabled={sending}
            />
            {/* The email this screen was refused for already has a workspace, so the way on
                is a sign-in and not a correction. The sentence is the platform's; the link
                is this screen's, because this screen owns the route table. */}
            {failure?.alreadyHasOne === true && (
              <p className="field-link">
                <Link to={paths.signIn}>Sign in</Link>
              </p>
            )}
            <Field
              id={passwordId}
              label="Password"
              hint="At least twelve characters. We store a verifier, never the password."
              resolving={resolving}
              error={errorFor('password')}
              name="password"
              type="password"
              autoComplete="new-password"
              required
              disabled={sending}
            />
            <Field
              id={workspaceId}
              label="Workspace name"
              resolving={resolving}
              error={errorFor('workspaceName')}
              name="workspaceName"
              type="text"
              autoComplete="organization"
              required
              disabled={sending}
            />

            {resolving ? (
              <Skeleton className="h-10 rounded-full" />
            ) : (
              <Button type="submit" size="lg" disabled={sending}>
                {sending ? 'Creating your workspace…' : 'Create workspace'}
              </Button>
            )}

            <p className="footnote">No card. Next step is adding a site and proving it is yours.</p>
          </form>
        </div>
      </div>
    </div>
  );
}
