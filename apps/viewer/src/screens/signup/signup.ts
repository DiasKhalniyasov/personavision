import { clearRunCache } from '@/shell/useRun';

/**
 * `POST /auth/signup` — the one request the sign-up screen makes.
 *
 * It creates the account and the workspace and sets the session cookie, and it answers with
 * the same body a completed sign-in answers with (`packages/platform/src/server/routes/
 * auth.ts`). This module does **not** read that body for a session: `shell/useSession` is
 * the only place this app asks who is signed in, so the screen tells it to ask the server
 * again and the cookie is what signs the visitor in. One extra read, and the workspace the
 * chrome then names is the server's answer rather than this request's.
 *
 * The password is sent as JSON in the body of a POST and is held nowhere else: not in this
 * module, not in a URL, and never written to the console.
 */

/** The fields of `#screen-signup`, which are the three the route reads. */
export interface NewWorkspaceFields {
  email: string;
  password: string;
  workspaceName: string;
}

/** Which field a refusal is about. The names are the route's own. */
export type SignUpField = 'email' | 'password' | 'workspaceName';

export interface SignUpRefusal {
  /** The sentence to render, in the words the platform chose. */
  readonly message: string;
  /** The field to mark and announce it against, or `null` for a failure about the request. */
  readonly field: SignUpField | null;
  /**
   * This email already has a workspace, so the screen offers the way on — a link to
   * `/signin` — rather than leaving somebody to guess at a password they never set.
   */
  readonly alreadyHasOne: boolean;
  /** Nothing was created and the server was never reached, so the same form is worth sending again. */
  readonly retryable: boolean;
}

export type SignUpResult =
  { readonly ok: true } | { readonly ok: false; readonly refusal: SignUpRefusal };

/** The platform's own route, as `packages/platform/src/server/routes/auth.ts` mounts it. */
const SIGNUP_URL = '/auth/signup';

/** The platform is served from the site root; `fetch` wants an absolute URL in a test. */
const absolute = (path: string): string => new URL(path, window.location.href).toString();

/** The sentence a server that cannot be reached reports. */
const UNREACHABLE = 'The server could not be reached. Check that it is running, then try again.';
/** The sentence a server that answered something unusable reports. */
const UNREADABLE = 'The server answered in a way this app could not read. Try again.';
/** The sentence a refusal with no sentence of its own reports. */
const REFUSED = 'That sign-up could not be completed. Check the three fields and try again.';

/** The answer, read defensively: a body missing a field is not a reason to render nothing. */
interface SignUpBody {
  signedIn?: unknown;
  error?: unknown;
  field?: unknown;
}

/** The body of any answer, or `{}` for one this app could not read. */
const readBody = async (response: Response): Promise<SignUpBody> => {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as SignUpBody) : {};
  } catch {
    return {};
  }
};

const FIELDS: readonly SignUpField[] = ['email', 'password', 'workspaceName'];

const fieldOf = (value: unknown): SignUpField | null =>
  FIELDS.find((field) => field === value) ?? null;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * Create the workspace. `ok` means the account, the workspace and the session all exist, so
 * the caller forgets what it knew about the session and the browser is signed in.
 *
 * A refusal is the form's fault — 400, or 409 for an email that already has a workspace —
 * and nothing was created. Any other answer is the server having a problem, which is worth
 * submitting the same form again rather than correcting a field that may be right.
 */
export const createWorkspace = async (fields: NewWorkspaceFields): Promise<SignUpResult> => {
  let response: Response;
  try {
    response = await fetch(absolute(SIGNUP_URL), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    });
  } catch {
    return {
      ok: false,
      refusal: { message: UNREACHABLE, field: null, alreadyHasOne: false, retryable: true },
    };
  }

  // A refusal this app could not read is still a refusal: the status says whether the form
  // was at fault, and the sentence below says so without pretending to know more.
  const body = await readBody(response);

  if (!response.ok) {
    const refused = response.status === 400 || response.status === 409;
    const field = refused ? fieldOf(body.field) : null;
    return {
      ok: false,
      refusal: {
        message: text(body.error) ?? (refused ? REFUSED : UNREADABLE),
        field,
        alreadyHasOne: response.status === 409 && field === 'email',
        // Nothing the reader typed is at fault unless the answer names the field it is
        // about: a body that could not be read and a server with a problem are both worth
        // sending the same form again, and neither marks a field as wrong.
        retryable: field === null,
      },
    };
  }

  if (body.signedIn !== true) {
    // 200 from something that is not this platform — a dev proxy, or an SPA fallback
    // serving the page itself. Claiming a workspace was created would land the reader on
    // `/sites`, be bounced to `/signin` by the guard, and leave them believing they have
    // an account. `shell/useSession`'s sign-in guards the same case the same way.
    return {
      ok: false,
      refusal: { message: UNREADABLE, field: null, alreadyHasOne: false, retryable: true },
    };
  }

  // The workspace exists and the cookie is set. Every run read while signed out — the
  // public demo run of the landing page — belongs to nobody here, so it is forgotten
  // before the chrome of a workspace with no test of its own renders.
  clearRunCache();
  return { ok: true };
};
