# The PersonaVision GitHub App

Path 2 — _Improve my site_ — reads a connected repository, writes one change on a branch of its own and opens a pull
request on it (`docs/FLOW.md` section 15). It does that as a **GitHub App installed on one repository**, never as a
user, and this page is how the App's credentials reach the product.

**The product cannot merge.** The App's permissions are repository contents **read and write on a branch of our own**
and pull requests **read and write**, and `@personavision/improve`'s client declares every call it makes in one
interface with no generic sender and no merge call in it — not disabled, absent, and asserted against an exact list by
`packages/improve/tests/github/surface.test.ts`. PersonaVision opens the pull request; **the owner merges it**.

## The two variables

The App's credentials are read from the environment, by one module
(`packages/platform/src/github/credentials.ts`) and at the moment a call is made:

```sh
GITHUB_APP_ID=123456

# either a path to the .pem file GitHub downloaded — preferred …
GITHUB_APP_PRIVATE_KEY_PATH=/Users/<you>/.config/personavision/github-app.pem

# … or the key itself, PEM, newlines preserved
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
…
-----END RSA PRIVATE KEY-----"
```

**`GITHUB_APP_PRIVATE_KEY_PATH` wins when both are set.** A path in the environment and the key in a file with
`chmod 600` is one fewer place a multi-line secret gets mangled or echoed. Where only the inline PEM is set and its
newlines arrived as the two characters `\` and `n` — which is what a multi-line value usually survives as — they are
put back before the key is parsed; nothing else about the key is touched.

**`GITHUB_APP_ID` is also the answer to whether the App exists at all.** Absent, or set to nothing, means no App is
registered: `/settings/github` and `/new`'s path-2 card render **locked with the reason**, and `POST /github/connect`
answers `501` naming the ticket that registers it rather than a URL that leads nowhere. One function
(`githubAppIsRegistered`) answers that, so no screen and no route decides it for itself.

Nothing else in the repository reads these three variables.
`packages/platform/test/github-credentials.test.ts` asserts that — and `tests/workspace.test.ts` fails the build on a
credential read anywhere outside its named list, of which this module is one entry and `packages/provider`'s model key
the other (`CONTEXT.md`'s credential rule).

## What the product does with them

1. The App's **JWT** is signed with the private key: `RS256`, backdated a minute for clock drift, spanning the ten
   minutes GitHub allows at most, carrying `iat`, `exp` and `iss` (the App id) and nothing else.
2. That JWT is exchanged on `POST /app/installations/{installation_id}/access_tokens` for an **installation token**.
3. The installation token is handed to `@personavision/improve`'s client **as an argument** — that package reads no
   environment variable, which is what keeps every path-2 test runnable with no App, no key and no network.

An installation token is good for an hour. It is cached **in memory only**, under GitHub's own `expires_at` less a
minute's margin and never past an hour from the mint, and a fresh one is minted the instant that passes. A token is
never written to a file, a run artifact, a log line or an error, and the installation **record** stores only the
installation id — a public identifier, like a repository name (#299).

The private key never leaves the closure it is read in. It is parsed into a key object held by one closure, which
answers signatures and nothing else; no value this module returns, throws, records or stores carries the PEM, a line of
it or its DER.

## When it fails, it says which half failed

Every failure is a named `GithubAppError` carrying **what was asked** and **what was answered**:

| Kind              | What happened                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `no_app_id`       | `GITHUB_APP_ID` is not set: no App is registered.                                        |
| `unreadable_key`  | No key, a path that could not be read, or a PEM that will not parse as an RSA key.        |
| `unauthorized`    | GitHub answered **401**: the private key does not match the App.                          |
| `not_installed`   | GitHub answered **404**: the App is not installed on that repository.                     |
| `http_status`     | Any other non-2xx answer, carrying the status and GitHub's own words.                     |
| `transport`       | The call never reached GitHub, or our own timeout ran out.                                |
| `unparseable`     | A 2xx answer with no installation token in it. The reply is described, never quoted.      |

## Rotating the key

GitHub lets an App hold more than one private key at a time, which is what makes a rotation a swap rather than an
outage:

1. **Generate a new private key** in the App's settings on GitHub and download the `.pem`.
2. **Put it where the environment points**: write it to the path `GITHUB_APP_PRIVATE_KEY_PATH` names (`chmod 600`), or
   set `GITHUB_APP_PRIVATE_KEY` to it. There is no reload and no restart — the key is read at the moment of a call, so
   the next token is minted with the new one.
3. **Delete the old key** on GitHub once a call has succeeded. Installation tokens already minted keep working for
   their hour; they do not depend on the key that minted them.

A key that will not parse is `unreadable_key` at the moment it is read, not a 401 half a request later. A key that
parses but does not belong to the App is GitHub's 401, reported as `unauthorized`.

## Registering it

Registering the App needs a person in a browser and is **#231** — the permissions above and no more, the test
repository it is first installed on, and what the API actually did on that first live exercise are recorded there and
written up here by that ticket. Everything else in path 2 is built and tested against a generated test key pair and a
recorded transport, with no App, no credential and no network.
