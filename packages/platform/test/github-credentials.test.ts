import { execFileSync } from 'node:child_process';
import { createPrivateKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GITHUB_APP_ID_ENV,
  GITHUB_APP_JWT_ALGORITHM,
  GITHUB_APP_PRIVATE_KEY_ENV,
  GITHUB_APP_PRIVATE_KEY_PATH_ENV,
  GITHUB_APP_SLUG,
  GithubAppError,
  githubAppId,
  githubAppIsRegistered,
  githubAppRegistration,
  readGithubAppSigner,
} from '../src/github/credentials.js';
import {
  APP_JWT_BACKDATE_SECONDS,
  APP_JWT_MAX_SPAN_SECONDS,
  GITHUB_API_BASE_URL,
  INSTALLATION_TOKEN_LIFETIME_MS,
  INSTALLATION_TOKEN_MARGIN_MS,
  claimsOfAppJwt,
  createGithubInstallationTokens,
  mintAppJwt,
  mintInstallationToken,
} from '../src/github/token.js';
import type { GithubTokenAnswer, GithubTokenRequest } from '../src/github/token.js';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import { mintSiteToken } from '../src/site/index.js';
import { GITHUB_APP_NOT_REGISTERED, GITHUB_APP_TICKET } from '../src/server/routes/github.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * The GitHub App's credentials, read in one place, and the installation token minted from
 * them (#319).
 *
 * Everything here runs against a **generated test key pair** and a **recorded transport**:
 * no App is registered, no credential of the owner's is read and nothing reaches the network.
 * What is asserted is what the ticket's criteria name — one reader of the three variables,
 * the request that is actually made, which variable wins, that the key reaches nothing this
 * module emits or stores, that the App's absence is one function's answer, that a cached
 * token is never used past its expiry, and that each named failure says which half failed.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** The key GitHub downloads: an RSA key in PKCS#1 PEM. Generated here, once. */
const generateAppKey = (): { privateKey: string; publicKey: string } =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

/** The App's key, and a second one, so that "the path wins" is asserted on the signature. */
const THE_KEY = generateAppKey();
const ANOTHER_KEY = generateAppKey();

const APP_ID = '123456';
const AN_INSTALLATION = '45678901';
/** A token of GitHub's own shape, so that an assertion about it is about a credential. */
const A_TOKEN = `gh${'s'}_${'0'.repeat(8)}MintedForATest`;

const MINUTE_MS = 60 * 1000;

/**
 * Half of a key, between its markers: real key text that will not parse, which is what a
 * truncated copy-paste of a `.pem` actually looks like.
 */
const halfOf = (pem: string): string => {
  const body = pem.split('\n').filter((line) => line !== '' && !line.startsWith('-----'));
  return [PEM_OPEN, ...body.slice(0, Math.ceil(body.length / 2)), PEM_CLOSE, ''].join('\n');
};

/** The markers a PEM carries, assembled, so no line of this file reads as a key. */
const PEM_OPEN = `-----BE${'GIN'} RSA PRIVATE KEY-----`;
const PEM_CLOSE = `-----E${'ND'} RSA PRIVATE KEY-----`;

/** A fixed moment, so every expiry in this file is arithmetic rather than a race. */
const T0 = Date.parse('2026-11-04T10:00:00.000Z');

const clockFrom = (startMs: number): { now: () => number; advanceBy: (ms: number) => void } => {
  let at = startMs;
  return {
    now: () => at,
    advanceBy: (ms) => {
      at += ms;
    },
  };
};

/** `process.env`, written by name so that no shape here is itself a credential read. */
const setEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const APP_ENV_NAMES = [
  GITHUB_APP_ID_ENV,
  GITHUB_APP_PRIVATE_KEY_ENV,
  GITHUB_APP_PRIVATE_KEY_PATH_ENV,
] as const;

const temporary: string[] = [];

/** A `.pem` on disk, as GitHub's download and `GITHUB_APP_PRIVATE_KEY_PATH` have it. */
const keyFileHolding = async (pem: string, name = 'github-app.pem'): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'personavision-github-app-'));
  temporary.push(dir);
  const path = join(dir, name);
  await writeFile(path, pem, 'utf8');
  return path;
};

afterAll(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

/** The App's credentials as the owner's environment would hold them. */
const envWithKey = (
  pem: string = THE_KEY.privateKey,
  appId = APP_ID,
): Record<string, string | undefined> => ({
  [GITHUB_APP_ID_ENV]: appId,
  [GITHUB_APP_PRIVATE_KEY_ENV]: pem,
});

const stripped = (text: string): string => text.replace(/\s+/g, '');

/**
 * Every shape a piece of the key takes: the PEM, its body, each line of it, both ends of the
 * body and the DER the key exports to. "No part of it" is asserted against all of them, and
 * the test below proves they really do catch the key, so no assertion here passes vacuously.
 */
const keyFragments = (pem: string): readonly string[] => {
  const lines = pem.split('\n').filter((line) => line !== '' && !line.startsWith('-----'));
  const body = lines.join('');
  const key = createPrivateKey(pem);
  return [
    pem,
    body,
    ...lines,
    body.slice(0, 64),
    body.slice(-64),
    key.export({ type: 'pkcs1', format: 'der' }).toString('base64'),
    key.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    key.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  ];
};

const FRAGMENTS = keyFragments(THE_KEY.privateKey);

const carriesKey = (text: string): boolean =>
  FRAGMENTS.some(
    (fragment) => text.includes(fragment) || stripped(text).includes(stripped(fragment)),
  );

/** Everything a value could carry: its own fields, its message, its stack, its inspection. */
const everythingIn = (value: unknown): string => {
  const parts: string[] = [inspect(value, { depth: 10, showHidden: true })];
  if (value instanceof Error) {
    parts.push(value.name, value.message, value.stack ?? '');
    parts.push(inspect({ ...(value as unknown as Record<string, unknown>) }, { depth: 10 }));
  }
  try {
    parts.push(JSON.stringify(value) ?? 'undefined');
  } catch {
    // A value that will not serialise is covered by its inspection.
  }
  return parts.join('\n');
};

const everythingFrom = (values: readonly unknown[]): string =>
  values.map((value) => everythingIn(value)).join('\n');

/** What GitHub answers this endpoint with, and the one call we make to get it. */
const mintedAnswer = (
  options: { token?: string; expiresAt?: string; status?: number } = {},
): GithubTokenAnswer => ({
  status: options.status ?? 201,
  headers: { 'content-type': 'application/json' },
  body: {
    token: options.token ?? A_TOKEN,
    expires_at: options.expiresAt ?? new Date(T0 + 60 * MINUTE_MS).toISOString(),
    permissions: { contents: 'write', pull_requests: 'write' },
    repository_selection: 'selected',
  },
});

const refusedAnswer = (status: number, message: string): GithubTokenAnswer => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: { message, documentation_url: 'https://docs.github.com/rest' },
});

/** A transport that keeps what it was given and answers whatever the case needs. */
const recording = (
  answer: (request: GithubTokenRequest, nth: number) => GithubTokenAnswer = () => mintedAnswer(),
): {
  requests: GithubTokenRequest[];
  transport: (request: GithubTokenRequest) => Promise<GithubTokenAnswer>;
} => {
  const requests: GithubTokenRequest[] = [];
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      return answer(request, requests.length);
    },
  };
};

const jwtOf = (request: GithubTokenRequest): string =>
  (request.headers['authorization'] ?? '').replace(/^Bearer /, '');

const signedBy = (jwt: string, publicKey: string): boolean => {
  const [header = '', claims = '', signature = ''] = jwt.split('.');
  return createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(publicKey, Buffer.from(signature, 'base64url'));
};

const thrownBy = async (call: () => Promise<unknown>): Promise<GithubAppError> => {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(GithubAppError);
    return error as GithubAppError;
  }
  throw new Error('the call was expected to fail and did not');
};

describe('one file reads the App’s credentials', () => {
  /**
   * The three variable names, as the module itself spells them — so a rename moves this scan
   * with it — and this file carries none of them as text, which is why it needs no carve-out.
   */
  const NAMES = APP_ENV_NAMES.map((name) => new RegExp(`\\b${name}\\b`));

  const SCANNED_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.mjs',
    '.cjs',
    '.json',
    '.sh',
    '.yml',
    '.yaml',
  ]);
  const SCANNED_NAMES = new Set(['.npmrc', '.env.example', 'Dockerfile', 'Makefile']);

  /**
   * Comments are not reads.
   *
   * `apps/viewer`'s connection module and `packages/platform`'s GitHub routes both say in a
   * docblock where the answer comes from — deliberately, because a reader of a screen needs
   * to know that the browser cannot see the environment. Naming a variable is not reading it,
   * so the comments come off first and the scan is about code.
   */
  const withoutComments = (source: string, path: string): string => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\w])\/\/[^\n]*/g, '$1');
    const hashed = new Set(['.sh', '.yml', '.yaml']);
    return hashed.has(extname(path)) || SCANNED_NAMES.has(basename(path))
      ? code.replace(/(^|\s)#[^\n]*/g, '$1')
      : code;
  };

  const sourceFiles = (): string[] =>
    execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((path) => path.length > 0)
      .filter((path) => SCANNED_EXTENSIONS.has(extname(path)) || SCANNED_NAMES.has(basename(path)))
      .filter((path) => existsSync(join(repoRoot, path)));

  /** The one module, as `CONTEXT.md` and `tests/workspace.test.ts` both name it. */
  const THE_ONE_READER = join('packages', 'platform', 'src', 'github', 'credentials.ts');

  it('strips a docblock mention and keeps a line of code, so the scan is about reads', () => {
    const name = GITHUB_APP_ID_ENV;
    expect(withoutComments(`/** from \`${name}\` in the environment */`, 'x.ts')).not.toContain(
      name,
    );
    expect(withoutComments(`// reads ${name}\n`, 'x.ts')).not.toContain(name);
    expect(withoutComments(`# reads ${name}\n`, 'x.sh')).not.toContain(name);
    expect(withoutComments(`const ENV = '${name}';`, 'x.ts')).toContain(name);
    // And a URL is not a comment, so stripping does not eat code around one.
    expect(withoutComments(`const url = 'https://github.com/apps';`, 'x.ts')).toContain(
      'https://github.com/apps',
    );
  });

  it('is the only file in the repository that names them in code', () => {
    const offenders = sourceFiles()
      .filter((path) => path !== THE_ONE_READER)
      .filter((path) => {
        const code = withoutComments(readFileSync(join(repoRoot, path), 'utf8'), path);
        return NAMES.some((name) => name.test(code));
      });

    expect(offenders).toEqual([]);
  });

  it('really does name all three there, so this scan cannot pass by finding nothing', () => {
    const code = withoutComments(readFileSync(join(repoRoot, THE_ONE_READER), 'utf8'), '.ts');
    for (const name of NAMES) expect(code).toMatch(name);
  });

  it('writes no file and logs no line, in either module', () => {
    for (const path of [
      join('packages', 'platform', 'src', 'github', 'credentials.ts'),
      join('packages', 'platform', 'src', 'github', 'token.ts'),
    ]) {
      const source = readFileSync(join(repoRoot, path), 'utf8');
      for (const writing of [
        /\bconsole\./,
        /\bwriteFile\b/,
        /\bappendFile\b/,
        /\bwriteFileSync\b/,
        /process\.stdout/,
        /process\.stderr/,
      ]) {
        expect(source).not.toMatch(writing);
      }
    }
  });
});

describe('whether the App is registered — one function, one answer', () => {
  const kept = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of APP_ENV_NAMES) {
      kept.set(name, process.env[name]);
      setEnv(name, undefined);
    }
  });

  afterEach(() => {
    for (const [name, value] of kept) setEnv(name, value);
  });

  it('answers that it is not registered with no App id, which is today’s state', () => {
    expect(githubAppIsRegistered({ env: {} })).toBe(false);
  });

  it('counts a blank value as absent: a variable set to nothing is not an App', () => {
    expect(githubAppIsRegistered({ env: { [GITHUB_APP_ID_ENV]: '   ' } })).toBe(false);
  });

  it('answers that it is registered from the App id alone, with no key read', () => {
    expect(githubAppIsRegistered({ env: { [GITHUB_APP_ID_ENV]: APP_ID } })).toBe(true);
  });

  it('reads the environment at call time, not at import time and not into module state', () => {
    // The same imported binding, three answers: nothing was read when this module loaded and
    // nothing was remembered between the calls.
    expect(githubAppIsRegistered()).toBe(false);
    setEnv(GITHUB_APP_ID_ENV, APP_ID);
    expect(githubAppIsRegistered()).toBe(true);
    setEnv(GITHUB_APP_ID_ENV, undefined);
    expect(githubAppIsRegistered()).toBe(false);
  });

  it('names the ticket and the variable when the App id is missing', async () => {
    const failed = await thrownBy(async () => githubAppId({ env: {} }));
    expect(failed.kind).toBe('no_app_id');
    expect(failed.asked).toContain(GITHUB_APP_ID_ENV);
    expect(failed.message).toContain(GITHUB_APP_ID_ENV);
    expect(failed.message).toContain('231');
  });

  describe('the route seam the screens read', () => {
    it('has no installation URL while no App is registered', async () => {
      const registration = githubAppRegistration({ env: {} });
      expect(await registration.installationUrl({ workspaceId: 'W-1' })).toBeNull();
    });

    it('installs the App of this slug, naming the workspace that started it', async () => {
      const registration = githubAppRegistration({ env: { [GITHUB_APP_ID_ENV]: APP_ID } });
      const url = await registration.installationUrl({ workspaceId: 'W-1' });
      expect(url).toBe(`https://github.com/apps/${GITHUB_APP_SLUG}/installations/new?state=W-1`);
    });

    it('carries no credential in that URL — not the id, not the key', async () => {
      const registration = githubAppRegistration({
        env: envWithKey(),
        slug: GITHUB_APP_SLUG,
      });
      const url = (await registration.installationUrl({ workspaceId: 'W-1' })) ?? '';
      expect(url).not.toContain(APP_ID);
      expect(carriesKey(url)).toBe(false);
    });
  });

  describe('the states it answers, over HTTP', () => {
    let served: TestServer;
    let cookie: string;

    beforeEach(async () => {
      // The default reads `process.env`, which this suite owns: one server, and the App
      // appears and disappears underneath it.
      served = await startTestServer({ githubApp: githubAppRegistration() });
      const response = await served.signIn({
        email: DEMO_ACCOUNT_EMAIL,
        password: served.platform.seeded?.password ?? '',
      });
      expect(response.status).toBe(200);
      cookie = cookieOf(response);
    });

    afterEach(() => served.close());

    const connection = async (): Promise<{
      registered: boolean;
      connection: unknown;
      sentence: string;
    }> => {
      const response = await served.request('/github/connection', { headers: { cookie } });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        registered: boolean;
        connection: unknown;
        sentence: string;
      };
    };

    const connect = (): Promise<Response> =>
      served.request('/github/connect', { method: 'POST', headers: { cookie } });

    it('renders path 2 locked, with the reason, while there is no App', async () => {
      const state = await connection();
      expect(state.registered).toBe(false);
      expect(state.connection).toBeNull();
      expect(state.sentence).toBe(GITHUB_APP_NOT_REGISTERED);

      const refused = await connect();
      expect(refused.status).toBe(501);
      expect(await refused.json()).toEqual({
        error: GITHUB_APP_NOT_REGISTERED,
        ticket: GITHUB_APP_TICKET,
        registered: false,
      });
    });

    it('unlocks the connect flow the moment the App id is in the environment', async () => {
      setEnv(GITHUB_APP_ID_ENV, APP_ID);

      const state = await connection();
      expect(state.registered).toBe(true);
      expect(state.sentence).not.toBe(GITHUB_APP_NOT_REGISTERED);

      const started = await connect();
      expect(started.status).toBe(200);
      const body = (await started.json()) as { installationUrl: string; registered: boolean };
      expect(body.registered).toBe(true);
      expect(body.installationUrl).toContain(`/apps/${GITHUB_APP_SLUG}/installations/new`);
    });

    it('answers neither the id nor the key to a screen', async () => {
      setEnv(GITHUB_APP_ID_ENV, APP_ID);
      setEnv(GITHUB_APP_PRIVATE_KEY_ENV, THE_KEY.privateKey);

      const state = await connection();
      const started = await connect();
      const bodies = [JSON.stringify(state), await started.text()].join('\n');

      expect(carriesKey(bodies)).toBe(false);
      expect(bodies).not.toContain(APP_ID);
    });
  });
});

describe('the key, read in one place', () => {
  it('signs the App JWT with the key in the environment', async () => {
    const signer = await readGithubAppSigner({ env: envWithKey() });

    expect(signer.appId).toBe(APP_ID);
    expect(signer.keyFrom).toBe('environment');
    expect(signedBy(mintAppJwt(signer, T0), THE_KEY.publicKey)).toBe(true);
  });

  it('prefers the path over the inline PEM when both are set', async () => {
    const path = await keyFileHolding(THE_KEY.privateKey);
    const signer = await readGithubAppSigner({
      env: {
        [GITHUB_APP_ID_ENV]: APP_ID,
        [GITHUB_APP_PRIVATE_KEY_ENV]: ANOTHER_KEY.privateKey,
        [GITHUB_APP_PRIVATE_KEY_PATH_ENV]: path,
      },
    });

    expect(signer.keyFrom).toBe('file');
    const jwt = mintAppJwt(signer, T0);
    // Asserted on the signature, not on a flag: the key the file holds is the key that signed.
    expect(signedBy(jwt, THE_KEY.publicKey)).toBe(true);
    expect(signedBy(jwt, ANOTHER_KEY.publicKey)).toBe(false);
  });

  it('reads the inline PEM when there is no path', async () => {
    const signer = await readGithubAppSigner({ env: envWithKey(ANOTHER_KEY.privateKey) });
    expect(signedBy(mintAppJwt(signer, T0), ANOTHER_KEY.publicKey)).toBe(true);
  });

  it('puts back the newlines a multi-line value loses on its way into the environment', async () => {
    const mangled = THE_KEY.privateKey.replace(/\n/g, '\\n');
    const signer = await readGithubAppSigner({ env: envWithKey(mangled) });
    expect(signedBy(mintAppJwt(signer, T0), THE_KEY.publicKey)).toBe(true);
  });

  it('puts back the newlines a half-converted value kept some of', async () => {
    const [head = '', ...rest] = THE_KEY.privateKey.split('\n');
    // The first line break survived; the others arrived as the two characters `\` and `n`.
    const mangled = `${head}\n${rest.join('\\n')}`;
    const signer = await readGithubAppSigner({ env: envWithKey(mangled) });
    expect(signedBy(mintAppJwt(signer, T0), THE_KEY.publicKey)).toBe(true);
  });

  it('reads the key at the moment of the call, so a rotated key is the one that signs', async () => {
    const first = await keyFileHolding(THE_KEY.privateKey, 'first.pem');
    const second = await keyFileHolding(ANOTHER_KEY.privateKey, 'second.pem');
    /** The environment the owner rotated the key in, before and after. */
    const pointingAt = (path: string): Record<string, string | undefined> => ({
      [GITHUB_APP_ID_ENV]: APP_ID,
      [GITHUB_APP_PRIVATE_KEY_PATH_ENV]: path,
    });

    const before = await readGithubAppSigner({ env: pointingAt(first) });
    const after = await readGithubAppSigner({ env: pointingAt(second) });

    expect(signedBy(mintAppJwt(before, T0), THE_KEY.publicKey)).toBe(true);
    expect(signedBy(mintAppJwt(after, T0), ANOTHER_KEY.publicKey)).toBe(true);
  });

  it('reads the file through the environment’s path, and reads nothing else', async () => {
    const asked: string[] = [];
    const signer = await readGithubAppSigner({
      env: {
        [GITHUB_APP_ID_ENV]: APP_ID,
        [GITHUB_APP_PRIVATE_KEY_PATH_ENV]: '/etc/personavision/github-app.pem',
      },
      readKeyFile: async (path) => {
        asked.push(path);
        return THE_KEY.privateKey;
      },
    });

    expect(asked).toEqual(['/etc/personavision/github-app.pem']);
    expect(signer.appId).toBe(APP_ID);
  });
});

describe('the App JWT', () => {
  it('carries the three claims GitHub reads, and the algorithm it requires', async () => {
    const signer = await readGithubAppSigner({ env: envWithKey() });

    const jwt = mintAppJwt(signer, T0);
    const [header = ''] = jwt.split('.');

    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toEqual({
      alg: GITHUB_APP_JWT_ALGORITHM,
      typ: 'JWT',
    });
    const claims = claimsOfAppJwt(jwt);
    expect(claims.iss).toBe(APP_ID);
    // Backdated a minute for clock drift, and inside the ten minutes GitHub allows.
    expect(claims.iat).toBe(Math.floor(T0 / 1000) - APP_JWT_BACKDATE_SECONDS);
    expect(claims.exp - claims.iat).toBe(APP_JWT_MAX_SPAN_SECONDS);
    expect(claims.exp).toBeLessThanOrEqual(Math.floor(T0 / 1000) + APP_JWT_MAX_SPAN_SECONDS);
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'iss']);
  });
});

describe('the installation token, minted over a recorded transport', () => {
  const minted = async (
    options: {
      answer?: (request: GithubTokenRequest, nth: number) => GithubTokenAnswer;
      installation?: string;
    } = {},
  ): Promise<{ requests: GithubTokenRequest[]; token: string; expiresAt: string }> => {
    const recorder = recording(options.answer);
    const result = await mintInstallationToken(options.installation ?? AN_INSTALLATION, {
      env: envWithKey(),
      transport: recorder.transport,
      now: () => T0,
    });
    return { requests: recorder.requests, ...result };
  };

  it('asks the one endpoint that mints one, with the headers GitHub documents', async () => {
    const { requests } = await minted();

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe(`/app/installations/${AN_INSTALLATION}/access_tokens`);
    expect(request?.url).toBe(
      `${GITHUB_API_BASE_URL}/app/installations/${AN_INSTALLATION}/access_tokens`,
    );
    expect(request?.headers['accept']).toBe('application/vnd.github+json');
    expect(request?.headers['x-github-api-version']).toBe('2022-11-28');
    expect(request?.headers['user-agent']).toBe('personavision');
  });

  it('authorises it with an App JWT the environment’s key signed', async () => {
    const { requests } = await minted();
    const jwt = jwtOf(requests[0] as GithubTokenRequest);

    expect(signedBy(jwt, THE_KEY.publicKey)).toBe(true);
    expect(claimsOfAppJwt(jwt).iss).toBe(APP_ID);
  });

  it('answers the token GitHub minted and the moment GitHub says it expires', async () => {
    const expiresAt = new Date(T0 + 60 * MINUTE_MS).toISOString();
    const { token, expiresAt: answered } = await minted({
      answer: () => mintedAnswer({ expiresAt }),
    });

    expect(token).toBe(A_TOKEN);
    expect(answered).toBe(expiresAt);
  });

  it('escapes an installation id rather than composing a path out of it', async () => {
    const { requests } = await minted({ installation: '../../app/hook/config' });
    expect(requests[0]?.path).toBe(
      '/app/installations/..%2F..%2Fapp%2Fhook%2Fconfig/access_tokens',
    );
  });

  it('hands the client a function, resolved at the moment of each call (#297)', async () => {
    const recorder = recording();
    const tokens = createGithubInstallationTokens({
      env: envWithKey(),
      transport: recorder.transport,
      now: () => T0,
    });

    const source = tokens.tokenSourceFor(AN_INSTALLATION);
    expect(typeof source).toBe('function');
    // Nothing was minted by asking for the source: the client resolves it when it calls.
    expect(recorder.requests).toHaveLength(0);
    expect(await source()).toBe(A_TOKEN);
    expect(recorder.requests).toHaveLength(1);
  });
});

describe('a cached token is never used past its expiry', () => {
  const tokensOn = (
    clock: { now: () => number },
    answer?: (request: GithubTokenRequest, nth: number) => GithubTokenAnswer,
  ): {
    requests: GithubTokenRequest[];
    tokens: ReturnType<typeof createGithubInstallationTokens>;
  } => {
    const recorder = recording(answer);
    return {
      requests: recorder.requests,
      tokens: createGithubInstallationTokens({
        env: envWithKey(),
        transport: recorder.transport,
        now: clock.now,
      }),
    };
  };

  const hourly = (_request: GithubTokenRequest, nth: number): GithubTokenAnswer =>
    mintedAnswer({
      token: `${A_TOKEN}-${String(nth)}`,
      expiresAt: new Date(T0 + 60 * MINUTE_MS).toISOString(),
    });

  it('mints once and reuses it while it lives', async () => {
    const clock = clockFrom(T0);
    const { requests, tokens } = tokensOn(clock, hourly);

    expect(await tokens.tokenFor(AN_INSTALLATION)).toBe(`${A_TOKEN}-1`);
    clock.advanceBy(50 * MINUTE_MS);
    expect(await tokens.tokenFor(AN_INSTALLATION)).toBe(`${A_TOKEN}-1`);
    expect(requests).toHaveLength(1);
  });

  it('stops using it a margin before GitHub’s own expiry', async () => {
    const clock = clockFrom(T0);
    const { requests, tokens } = tokensOn(clock, hourly);

    await tokens.tokenFor(AN_INSTALLATION);
    clock.advanceBy(60 * MINUTE_MS - INSTALLATION_TOKEN_MARGIN_MS - 1000);
    expect(await tokens.tokenFor(AN_INSTALLATION)).toBe(`${A_TOKEN}-1`);
    expect(requests).toHaveLength(1);

    clock.advanceBy(2000);
    expect(await tokens.tokenFor(AN_INSTALLATION)).toBe(`${A_TOKEN}-2`);
    expect(requests).toHaveLength(2);
  });

  it('holds nothing past an hour from the mint, whatever expiry a reply states', async () => {
    const clock = clockFrom(T0);
    const { requests, tokens } = tokensOn(clock, (_request, nth) =>
      mintedAnswer({
        token: `${A_TOKEN}-${String(nth)}`,
        // A year, which GitHub does not issue and this module does not believe.
        expiresAt: new Date(T0 + 365 * 24 * 60 * MINUTE_MS).toISOString(),
      }),
    );

    await tokens.tokenFor(AN_INSTALLATION);
    clock.advanceBy(INSTALLATION_TOKEN_LIFETIME_MS - INSTALLATION_TOKEN_MARGIN_MS + 1000);

    expect(await tokens.tokenFor(AN_INSTALLATION)).toBe(`${A_TOKEN}-2`);
    expect(requests).toHaveLength(2);
  });

  it('holds nothing at all when the stated expiry does not parse', async () => {
    const clock = clockFrom(T0);
    const { requests, tokens } = tokensOn(clock, (_request, nth) =>
      mintedAnswer({ token: `${A_TOKEN}-${String(nth)}`, expiresAt: 'whenever' }),
    );

    expect(await tokens.tokenFor(AN_INSTALLATION)).toBe(`${A_TOKEN}-1`);
    expect(await tokens.tokenFor(AN_INSTALLATION)).toBe(`${A_TOKEN}-2`);
    expect(requests).toHaveLength(2);
  });

  it('keeps one token per installation, and asks once for each', async () => {
    const clock = clockFrom(T0);
    const { requests, tokens } = tokensOn(clock, (_request, nth) =>
      mintedAnswer({ token: `${A_TOKEN}-${String(nth)}` }),
    );

    expect(await tokens.tokenFor(AN_INSTALLATION)).toBe(`${A_TOKEN}-1`);
    expect(await tokens.tokenFor('9999')).toBe(`${A_TOKEN}-2`);
    expect(await tokens.tokenFor(AN_INSTALLATION)).toBe(`${A_TOKEN}-1`);
    expect(requests).toHaveLength(2);
  });

  it('mints once for a hundred sessions that start at the same moment', async () => {
    const clock = clockFrom(T0);
    const { requests, tokens } = tokensOn(clock, (_request, nth) =>
      mintedAnswer({ token: `${A_TOKEN}-${String(nth)}` }),
    );

    const together = await Promise.all(
      Array.from({ length: 100 }, () => tokens.tokenFor(AN_INSTALLATION)),
    );

    expect(new Set(together)).toEqual(new Set([`${A_TOKEN}-1`]));
    expect(requests).toHaveLength(1);
  });

  it('mints again after a failure rather than holding the failure', async () => {
    const clock = clockFrom(T0);
    const { requests, tokens } = tokensOn(clock, (_request, nth) =>
      nth === 1 ? refusedAnswer(401, 'A JSON web token could not be decoded') : mintedAnswer(),
    );

    await expect(tokens.tokenFor(AN_INSTALLATION)).rejects.toBeInstanceOf(GithubAppError);
    expect(await tokens.tokenFor(AN_INSTALLATION)).toBe(A_TOKEN);
    expect(requests).toHaveLength(2);
  });
});

describe('a failure says which half failed', () => {
  const failing = (
    answer: (request: GithubTokenRequest, nth: number) => GithubTokenAnswer,
    env: Record<string, string | undefined> = envWithKey(),
  ): Promise<GithubAppError> =>
    thrownBy(() =>
      mintInstallationToken(AN_INSTALLATION, {
        env,
        transport: recording(answer).transport,
        now: () => T0,
      }),
    );

  it('names no App id, and never reaches GitHub for it', async () => {
    const recorder = recording();
    const failed = await thrownBy(() =>
      mintInstallationToken(AN_INSTALLATION, { env: {}, transport: recorder.transport }),
    );

    expect(failed.kind).toBe('no_app_id');
    expect(failed.message).toContain(GITHUB_APP_ID_ENV);
    expect(recorder.requests).toEqual([]);
  });

  it('names a key that will not parse, and says where it came from', async () => {
    const failed = await failing(
      () => mintedAnswer(),
      envWithKey(`${PEM_OPEN}\nnot a key at all\n${PEM_CLOSE}\n`),
    );

    expect(failed.kind).toBe('unreadable_key');
    expect(failed.message).toContain(GITHUB_APP_PRIVATE_KEY_ENV);
    expect(failed.message).toContain('does not parse');
  });

  it('names a key that parses and is not the kind GitHub issues', async () => {
    const { privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const failed = await failing(() => mintedAnswer(), envWithKey(privateKey));

    expect(failed.kind).toBe('unreadable_key');
    expect(failed.message).toContain(GITHUB_APP_JWT_ALGORITHM);
  });

  it('names a path that could not be read, and the path', async () => {
    const failed = await thrownBy(() =>
      readGithubAppSigner({
        env: {
          [GITHUB_APP_ID_ENV]: APP_ID,
          [GITHUB_APP_PRIVATE_KEY_PATH_ENV]: '/nowhere/github-app.pem',
        },
      }),
    );

    expect(failed.kind).toBe('unreadable_key');
    expect(failed.message).toContain('/nowhere/github-app.pem');
    expect(failed.message).toContain(GITHUB_APP_PRIVATE_KEY_PATH_ENV);
  });

  it('names an App id with no key beside it', async () => {
    const failed = await thrownBy(() =>
      readGithubAppSigner({ env: { [GITHUB_APP_ID_ENV]: APP_ID } }),
    );

    expect(failed.kind).toBe('unreadable_key');
    expect(failed.message).toContain(GITHUB_APP_PRIVATE_KEY_ENV);
    expect(failed.message).toContain(GITHUB_APP_PRIVATE_KEY_PATH_ENV);
  });

  it('names a 401 as the key not matching the App, with what was asked and answered', async () => {
    const failed = await failing(() => refusedAnswer(401, 'A JSON web token could not be decoded'));

    expect(failed.kind).toBe('unauthorized');
    expect(failed.status).toBe(401);
    expect(failed.asked).toBe(`POST /app/installations/${AN_INSTALLATION}/access_tokens`);
    expect(failed.answered).toContain('A JSON web token could not be decoded');
    expect(failed.message).toContain('the private key does not match the App');
  });

  it('names a 404 as the App not being installed on that repository', async () => {
    const failed = await failing(() => refusedAnswer(404, 'Not Found'));

    expect(failed.kind).toBe('not_installed');
    expect(failed.status).toBe(404);
    expect(failed.asked).toContain(AN_INSTALLATION);
    expect(failed.message).toContain('not installed');
    expect(failed.answered).toContain('Not Found');
  });

  it('names any other status, carrying it', async () => {
    const failed = await failing(() => refusedAnswer(500, 'Server Error'));

    expect(failed.kind).toBe('http_status');
    expect(failed.status).toBe(500);
    expect(failed.message).toContain('500');
  });

  it('names a call that never reached GitHub', async () => {
    const failed = await thrownBy(() =>
      mintInstallationToken(AN_INSTALLATION, {
        env: envWithKey(),
        now: () => T0,
        transport: async () => {
          throw new Error('getaddrinfo ENOTFOUND api.github.com');
        },
      }),
    );

    expect(failed.kind).toBe('transport');
    expect(failed.message).toContain('ENOTFOUND');
  });

  it('refuses a 2xx whose stated expiry is empty rather than answering one', async () => {
    const failed = await failing(() => ({
      status: 201,
      headers: {},
      body: { token: A_TOKEN, expires_at: '' },
    }));

    expect(failed.kind).toBe('unparseable');
    expect(failed.message).not.toContain(A_TOKEN);
  });

  it('refuses a 2xx it cannot read a token out of, and does not quote the reply', async () => {
    const failed = await failing(() => ({
      status: 201,
      headers: {},
      // A reply shaped like neither an answer nor a refusal — and one carrying a token under
      // a name we do not read, which must not be echoed into a message.
      body: { tokens: [A_TOKEN], expires_at: new Date(T0).toISOString() },
    }));

    expect(failed.kind).toBe('unparseable');
    expect(failed.message).toContain('no installation token');
    expect(failed.message).not.toContain(A_TOKEN);
  });

  it('is one class to catch, whichever half failed', async () => {
    for (const failed of [
      await thrownBy(async () => githubAppId({ env: {} })),
      await failing(() => mintedAnswer(), envWithKey('not a pem')),
      await failing(() => refusedAnswer(401, 'no')),
      await failing(() => refusedAnswer(404, 'no')),
    ]) {
      expect(failed).toBeInstanceOf(GithubAppError);
      expect(failed.name).toBe('GithubAppError');
      expect(failed.asked).not.toBe('');
      expect(failed.answered).not.toBe('');
      expect(failed.message).not.toContain('undefined');
    }
  });
});

describe('the key never leaves the closure it is read in', () => {
  it('is held to fragments that do catch it, so no assertion here is vacuous', () => {
    expect(FRAGMENTS.length).toBeGreaterThanOrEqual(8);
    for (const fragment of FRAGMENTS) expect(fragment.length).toBeGreaterThanOrEqual(32);
    // The key itself is caught …
    expect(carriesKey(THE_KEY.privateKey)).toBe(true);
    expect(carriesKey(THE_KEY.privateKey.replace(/\n/g, '\\n'))).toBe(true);
    // … and so is one line of it on its own, while a key the module never read is not.
    expect(carriesKey(FRAGMENTS[2] ?? '')).toBe(true);
    expect(carriesKey(ANOTHER_KEY.privateKey)).toBe(false);
  });

  it('is in nothing the signer carries, by field, by inspection or by serialisation', async () => {
    const signer = await readGithubAppSigner({ env: envWithKey() });

    expect(Object.keys(signer).sort()).toEqual(['appId', 'keyFrom', 'sign']);
    expect(carriesKey(everythingIn(signer))).toBe(false);
    // The signature it produces is the point of the signer, and it is not the key.
    expect(carriesKey(mintAppJwt(signer, T0))).toBe(false);
  });

  it('is in nothing the mint emits — the request, the answer or the token', async () => {
    const recorder = recording();
    const minted = await mintInstallationToken(AN_INSTALLATION, {
      env: envWithKey(),
      transport: recorder.transport,
      now: () => T0,
    });

    expect(carriesKey(everythingFrom([minted, recorder.requests]))).toBe(false);
  });

  it('is in no failure of either half, thrown or inspected', async () => {
    const path = await keyFileHolding(halfOf(THE_KEY.privateKey), 'bad.pem');
    const envs: Record<string, string | undefined>[] = [
      {},
      { [GITHUB_APP_ID_ENV]: APP_ID },
      envWithKey(halfOf(THE_KEY.privateKey)),
      { [GITHUB_APP_ID_ENV]: APP_ID, [GITHUB_APP_PRIVATE_KEY_PATH_ENV]: path },
    ];

    const failures: unknown[] = [];
    for (const env of envs) {
      failures.push(await thrownBy(() => readGithubAppSigner({ env })));
    }
    for (const status of [401, 404, 500]) {
      failures.push(
        await thrownBy(() =>
          mintInstallationToken(AN_INSTALLATION, {
            env: envWithKey(),
            now: () => T0,
            transport: recording(() => refusedAnswer(status, 'no')).transport,
          }),
        ),
      );
    }

    // Each one really failed, and none of them says anything about the key.
    expect(failures).toHaveLength(7);
    expect(carriesKey(everythingFrom(failures))).toBe(false);
  });

  it('is in no file the platform stores, with the key in its environment', async () => {
    const kept = APP_ENV_NAMES.map((name) => [name, process.env[name]] as const);
    let served: TestServer | null = null;

    try {
      setEnv(GITHUB_APP_ID_ENV, APP_ID);
      setEnv(GITHUB_APP_PRIVATE_KEY_ENV, THE_KEY.privateKey);
      served = await startTestServer({ githubApp: githubAppRegistration() });
      const workspaceId = served.platform.seeded?.workspaceId ?? '';
      const site = await served.platform.store.sites.create(workspaceId, {
        url: 'https://app.clipforge.example/create',
        token: mintSiteToken(),
      });
      await served.platform.store.githubInstallations.connect(workspaceId, {
        installationId: AN_INSTALLATION,
        repository: 'clipforge/web',
        siteId: site.id,
      });

      // A token minted for that installation, from the key in the environment …
      const tokens = createGithubInstallationTokens({
        transport: recording().transport,
        now: () => T0,
      });
      expect(await tokens.tokenFor(AN_INSTALLATION)).toBe(A_TOKEN);

      // … and then every byte the platform has written.
      const stored = await storedBytes(served.directories.dataDir);
      expect(stored).not.toBe('');
      expect(carriesKey(stored)).toBe(false);
      expect(stored).not.toContain(A_TOKEN);
      // The record names the installation, which is a public identifier and not a credential.
      expect(stored).toContain(AN_INSTALLATION);
    } finally {
      // Whatever happened, the generated key does not outlive this case in the environment.
      for (const [name, value] of kept) setEnv(name, value);
      await served?.close();
    }
  });
});

/** Every file under a directory, read as one string. */
const storedBytes = async (dir: string): Promise<string> => {
  const parts: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else parts.push(path, await readFile(path, 'utf8'));
    }
  };
  await walk(dir);
  return parts.join('\n');
};
