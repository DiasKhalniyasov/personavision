import { createPrivateKey, createSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { GithubAppRegistration } from '../server/routes/github.js';

/**
 * The GitHub App's credentials, read in **one** place.
 *
 * This is the only file in the repository that names `GITHUB_APP_ID`,
 * `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH` in code — the second sanctioned
 * credential read of the workspace, beside `packages/provider`'s model key, named in
 * `CONTEXT.md` and carved out by name in `tests/workspace.test.ts`
 * (#319, and the owner's answer of 2026-11-03 on #231).
 *
 * Four things are load-bearing, and all four are tested rather than documented
 * (`packages/platform/test/github-credentials.test.ts`):
 *
 * 1. **One read, at call time.** The environment is read at the moment a call is made —
 *    never at import time and never into module state — so a process that gains or loses the
 *    App's credentials does not have to be restarted, and the key a token is minted with is
 *    the one the environment held at that instant. Every function here takes its own `env`,
 *    defaulting to `process.env`, the way `packages/provider`'s selection does.
 * 2. **The key never leaves the closure it is read in.** {@link readGithubAppSigner} parses
 *    it into a `KeyObject` held by one closure and returns a **signer**, not a key: nothing
 *    this module returns, throws, or hands on carries the PEM, a line of it or its DER. The
 *    one message composed from a failed parse hides the key text it was given first, the way
 *    #297's client hides the installation token out of what a transport says.
 * 3. **Whether the App exists is this module's answer.** {@link githubAppIsRegistered} reads
 *    `GITHUB_APP_ID` and nothing else, and {@link githubAppRegistration} is the
 *    `GithubAppRegistration` seam `/github/connection` and `/github/connect` already take
 *    (#299) — so the locked path-2 card and `/settings/github` (#271) read that state and no
 *    screen or route decides it for itself.
 * 4. **A failure says which half failed, in words.** Four named failures and no `undefined`:
 *    no App id, a key that will not parse, a 401 because the key does not match the App, and
 *    a 404 because the App is not installed on that repository. The first two are thrown
 *    here; the two that are GitHub's answers are thrown by `./token.ts`, from this same
 *    {@link GithubAppError}, so a caller has one class to catch.
 *
 * `docs/github-app.md` states the two variables, which wins when both are set, how to rotate
 * the key, and the one sentence that the product cannot merge.
 */

/** The App's id, and whether it is set is also _whether the App is registered at all_. */
export const GITHUB_APP_ID_ENV = 'GITHUB_APP_ID';
/** The key itself, PEM, as GitHub downloads it. */
export const GITHUB_APP_PRIVATE_KEY_ENV = 'GITHUB_APP_PRIVATE_KEY';
/**
 * A path to the `.pem` file GitHub downloaded, which **wins** over the inline PEM when both
 * are set: a path in the environment and the key in a file with `chmod 600` is one fewer
 * place a multi-line secret gets mangled or echoed (#231).
 */
export const GITHUB_APP_PRIVATE_KEY_PATH_ENV = 'GITHUB_APP_PRIVATE_KEY_PATH';

/**
 * The App's public name on GitHub, which is the one part of the installation URL that is not
 * the workspace's: `https://github.com/apps/<slug>/installations/new`. It is a name, not a
 * credential, and it is **not** an environment variable — #231 registers the App as
 * PersonaVision, and if the owner registers it under another name this default is the one
 * line that changes.
 */
export const GITHUB_APP_SLUG = 'personavision';

/** The App JWT's algorithm, as GitHub requires it. `./token.ts` writes it into the header. */
export const GITHUB_APP_JWT_ALGORITHM = 'RS256';

/** The same algorithm, as `node:crypto` spells it. */
const NODE_SIGNING_ALGORITHM = 'RSA-SHA256';

/**
 * What goes wrong, named. The four this product will actually meet are the first four; the
 * last three are what any HTTP call can answer and are named rather than smoothed, for the
 * reason `@personavision/improve`'s own errors give.
 */
export const GITHUB_APP_FAILURE_KINDS = [
  /** `GITHUB_APP_ID` is not set: no App is registered (#231). */
  'no_app_id',
  /** No key, a path that could not be read, or a PEM that will not parse as an RSA key. */
  'unreadable_key',
  /** 401: GitHub refused the App JWT — the key does not match the App. */
  'unauthorized',
  /** 404: there is no such installation — the App is not installed on that repository. */
  'not_installed',
  /** Any other non-2xx answer from GitHub. */
  'http_status',
  /** The call never reached GitHub, or our own clock ran out. */
  'transport',
  /** A 2xx answer this module could not read an installation token out of. */
  'unparseable',
] as const;

export type GithubAppFailureKind = (typeof GITHUB_APP_FAILURE_KINDS)[number];

/**
 * A credential or token failure, in words.
 *
 * `asked` is what was asked — a variable name, or the method and path of the one call this
 * product makes to mint a token; `answered` is what came back, and `status` the HTTP status
 * where there was one. The message states all of it in one sentence, so a failure that
 * reaches a log line or a screen is already readable.
 *
 * **No message built here carries the key.** It is composed from a variable name, a file
 * path, a status and GitHub's own words, and the one message built from key text hides that
 * text first.
 */
export class GithubAppError extends Error {
  readonly kind: GithubAppFailureKind;
  readonly asked: string;
  readonly answered: string;
  readonly status?: number;

  constructor(options: {
    readonly kind: GithubAppFailureKind;
    readonly asked: string;
    readonly answered: string;
    readonly status?: number;
  }) {
    super(`${options.asked} — ${options.kind}: ${options.answered}`);
    this.name = 'GithubAppError';
    this.kind = options.kind;
    this.asked = options.asked;
    this.answered = options.answered;
    if (options.status !== undefined) this.status = options.status;
  }
}

export interface GithubAppCredentialOptions {
  /** Defaults to `process.env`; a test passes its own and touches nothing global. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How the `.pem` the path names is read. Defaults to `node:fs`, built on no import cost. */
  readonly readKeyFile?: (path: string) => Promise<string>;
}

export interface GithubAppRegistrationOptions extends GithubAppCredentialOptions {
  /** The App's public name on GitHub. Defaults to {@link GITHUB_APP_SLUG}. */
  readonly slug?: string;
}

/**
 * The App, and how to sign as it — **not** the key.
 *
 * `sign` is a closure over a `KeyObject` that exists nowhere else: it takes a JWT's signing
 * input and answers its base64url signature. That is the whole of what the rest of the
 * product can do with the App's private key, which is why the key itself is not a field here
 * and not a value any caller holds.
 */
export interface GithubAppSigner {
  /** `GITHUB_APP_ID`, trimmed. A public identifier, like a repository name. */
  readonly appId: string;
  /** Which of the two variables the key came from. The variable, never the key. */
  readonly keyFrom: 'file' | 'environment';
  /** The RS256 signature of a JWT's `header.claims`, base64url. */
  readonly sign: (signingInput: string) => string;
}

const stated = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const unreadableKey = (answered: string): GithubAppError =>
  new GithubAppError({
    kind: 'unreadable_key',
    asked: `the App's private key, from ${GITHUB_APP_PRIVATE_KEY_PATH_ENV} or ${GITHUB_APP_PRIVATE_KEY_ENV}`,
    answered,
  });

/**
 * Whether a GitHub App is registered at all: **one function, one answer**.
 *
 * `GITHUB_APP_ID` absent means the App is not registered, which is the state `/settings/github`
 * and the locked path-2 card render and the state `POST /github/connect` answers with (#271,
 * #299). A blank value counts as absent: a variable set to nothing is not an App.
 */
export const githubAppIsRegistered = (options: GithubAppCredentialOptions = {}): boolean =>
  stated((options.env ?? process.env)[GITHUB_APP_ID_ENV]) !== null;

/** The App's id, or the named failure that says it is not registered. */
export const githubAppId = (options: GithubAppCredentialOptions = {}): string => {
  const appId = stated((options.env ?? process.env)[GITHUB_APP_ID_ENV]);
  if (appId === null) {
    throw new GithubAppError({
      kind: 'no_app_id',
      asked: `the App's id, from ${GITHUB_APP_ID_ENV}`,
      answered: `${GITHUB_APP_ID_ENV} is not set, so no GitHub App is registered (#231)`,
    });
  }
  return appId;
};

/**
 * The route seam, answered from the environment.
 *
 * `null` means _not registered_, which is what `githubRoutes` turns into the sentence it
 * already owns. A URL is only ever returned when there is an App to install, so a screen
 * never offers a control that leads nowhere. The environment is read inside the call, so a
 * server started before the owner set `GITHUB_APP_ID` answers differently once they have.
 */
export const githubAppRegistration = (
  options: GithubAppRegistrationOptions = {},
): GithubAppRegistration => ({
  installationUrl: async ({ workspaceId }) => {
    if (!githubAppIsRegistered(options)) return null;
    const slug = options.slug ?? GITHUB_APP_SLUG;
    // `state` comes back on the installation callback, which is how the installation that
    // arrives is filed against the workspace that started it (#299).
    return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(workspaceId)}`;
  },
});

/**
 * A PEM whose newlines were mangled into the two characters `\` and `n` on their way into the
 * environment, which is what happens to a multi-line value more often than not.
 *
 * Unconditional, and safe to be: a PEM is base64 between two markers and never legitimately
 * carries a backslash. A half-converted value — some real line breaks, some escapes — is put
 * back too, which is the case that would otherwise fail as "does not parse" and send the
 * owner looking at the key rather than at its encoding.
 */
const withRealNewlines = (pem: string): string => pem.replace(/\\n/g, '\n');

const privateKeyFrom = (pem: string, where: string): KeyObject => {
  /** The last line of defence: what a failed parse says is composed from this, not from it. */
  const hide = (text: string): string => {
    const pieces = [
      pem,
      pem.replace(/\s+/g, ''),
      ...pem.split('\n').filter((line) => line.trim().length >= 8),
    ];
    return pieces.reduce(
      (hidden, piece) => (piece === '' ? hidden : hidden.split(piece).join('[key]')),
      text,
    );
  };

  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw unreadableKey(`${where} does not parse as a private key: ${hide(messageOf(error))}`);
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw unreadableKey(
      `${where} is ${key.asymmetricKeyType === undefined ? 'not an asymmetric key' : `an ${key.asymmetricKeyType} key`}; GitHub issues an RSA key and an App JWT is signed ${GITHUB_APP_JWT_ALGORITHM}`,
    );
  }
  return key;
};

/**
 * Read the App's credentials and close over the key.
 *
 * The path variable wins over the inline PEM when both are set. The PEM is parsed here, so a
 * key that will not parse is a named failure at the moment it is read rather than a 401 half
 * a request later, and only the parsed key — in one closure, behind `sign` — survives the
 * call.
 */
export const readGithubAppSigner = async (
  options: GithubAppCredentialOptions = {},
): Promise<GithubAppSigner> => {
  const env = options.env ?? process.env;
  const appId = githubAppId({ env });
  const path = stated(env[GITHUB_APP_PRIVATE_KEY_PATH_ENV]);
  const inline = stated(env[GITHUB_APP_PRIVATE_KEY_ENV]);

  if (path === null && inline === null) {
    throw unreadableKey(
      `neither ${GITHUB_APP_PRIVATE_KEY_PATH_ENV} nor ${GITHUB_APP_PRIVATE_KEY_ENV} is set, so ${GITHUB_APP_ID_ENV}=${appId} names an App this process cannot sign as`,
    );
  }

  const keyFrom = path === null ? 'environment' : 'file';
  let pem: string;
  if (path !== null) {
    const read = options.readKeyFile ?? ((at: string) => readFile(at, 'utf8'));
    try {
      pem = await read(path);
    } catch (error) {
      throw unreadableKey(
        `${GITHUB_APP_PRIVATE_KEY_PATH_ENV} names ${path}, which could not be read: ${messageOf(error)}`,
      );
    }
  } else {
    pem = withRealNewlines(inline ?? '');
  }

  const where = path === null ? `the PEM in ${GITHUB_APP_PRIVATE_KEY_ENV}` : `the PEM in ${path}`;
  const key = privateKeyFrom(pem, where);

  return {
    appId,
    keyFrom,
    sign: (signingInput) =>
      createSign(NODE_SIGNING_ALGORITHM).update(signingInput).sign(key, 'base64url'),
  };
};
