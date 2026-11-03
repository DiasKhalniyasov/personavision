# `@personavision/improve`

Path 2's closed loop: the one way this product talks to GitHub.

After a path-1 run on a repository the owner has connected, PersonaVision picks **one** targeted change from its own
recommendations, writes it, opens a pull request, runs the same audience and the same seeds plus a holdout against the
baseline and the change, and posts the before/after back as one comment on that pull request. **It never merges. The
owner merges.** `docs/FLOW.md` section 15 is the contract; step #227 builds it.

This package depends on `@personavision/contract`, `@personavision/provider` and `@personavision/scoring`, and nothing
depends on it.

## The client is the whole surface

`createGitHubClient` is the only path from this product to GitHub. There is no generic sender: a module that needs a
call adds a **named method** to `GitHubClient`, in the open, rather than composing a path of its own. The calls, and the
whole of them:

| Call                                  | Request                                               |
| ------------------------------------- | ----------------------------------------------------- |
| `readBranch`                          | `GET /repos/:owner/:repo/git/ref/heads/:branch`       |
| `createBranch`                        | `POST /repos/:owner/:repo/git/refs`                   |
| `readFile`                            | `GET /repos/:owner/:repo/contents/:path?ref=`         |
| `writeFile`                           | `PUT /repos/:owner/:repo/contents/:path`              |
| `openPullRequest` / `readPullRequest` | `POST` / `GET /repos/:owner/:repo/pulls`              |
| `readDeployments`                     | `GET /repos/:owner/:repo/deployments?sha=`            |
| `readDeploymentStatuses`              | `GET /repos/:owner/:repo/deployments/:id/statuses`    |
| `readComments` / `postComment`        | `GET` / `POST /repos/:owner/:repo/issues/:n/comments` |
| `editComment`                         | `PATCH /repos/:owner/:repo/issues/comments/:id`       |

That list is the App's permission surface — repository contents read, pull requests read and write (#231) — and
`tests/github/surface.test.ts` asserts it against an exact set of names. **There is no merge call.** Not disabled, not
guarded: absent. A ticket that adds one fails that test, which is how the product is proved unable to merge rather than
merely unwilling.

The two calls that write take a branch, and that branch must begin with `IMPROVE_BRANCH_PREFIX` (`personavision/`). A
customer's default branch — `main`, `master`, whatever they call it — does not, so a write to it is refused before a
request is built. #302's run branch is named under that prefix.

## The transport is injected, and the token is an argument

```ts
const client = createGitHubClient({
  token: () => mintInstallationToken(installation), // @personavision/platform, #319
  transport: recorded.transport, // omitted in production: `fetch`, built only then
});
```

- **The transport is a function.** `createRecordedTransport` is published from this package's index, so every test here
  and in #300, #301 and #302 states the exchanges it expects and reads back the requests that were made. A call a test
  did not record throws and names itself; the transcript it keeps carries **no headers**, so a transcript printed by a
  failing assertion cannot carry a credential.
- **The installation token arrives as an argument** and is resolved **at call time**, every call — an installation token
  lives an hour, so a long-lived client asks for a fresh one rather than holding the first. This package reads **no**
  environment variable: `@personavision/platform` is the one place the App's credentials are read (#319), and
  `tests/workspace.test.ts`'s scanner holds this package to that, with no exception for it.
- **The token never leaves the closure it is read in.** It reaches one `Authorization` header and the redaction of what
  comes back. No reply, no error message, no thrown object's properties and no log line carries it — a 401 page that
  quotes the token straight back is redacted before a failure quotes it, because a reply is not ours to trust.

## A failure is in words

Every call that does not answer what was asked throws a `GitHubCallError` naming **what was asked** (method and path)
and **what was answered** (the status and GitHub's own words): `transport`, `timeout`, `unauthorized`, `forbidden`,
`not_found`, `unprocessable`, `rate_limit`, `http_status`, `unparseable`, `refused`. The three this product will
actually meet are a **403** on a repository the App is not installed on, a **422** on a pull request that already
exists, and a **rate limit** — which hides inside a 403 and is told apart by the remaining-quota header. Nothing is
smoothed into a success and nothing comes back as `undefined`.

## Exercising it against a real repository

**Nothing here needs a GitHub App today.** A fresh clone installs, type-checks, lints, tests and builds this package
with no App, no installation, no token and no network: every test runs over the recorded transport.

Once the owner has registered the App (#231) and installed it on a test repository, the client is exercised against it
**once**, by hand, to confirm that the requests recorded here are the requests GitHub actually accepts:

1. The App's credentials are in the environment as `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` (#231). Mint an
   installation token through `@personavision/platform` (#319) — never by reading those variables from this package.
2. Build a client with that token as `token` and **no** `transport`, so the call goes over `fetch`.
3. Against the test repository, in this order: `readBranch('main')`, `readFile` at that commit, `createBranch` under
   `personavision/`, `writeFile` on it, `openPullRequest` against `main`, `readDeployments` for the head commit and its
   statuses, `postComment`, then `editComment` on the comment that came back.
4. Check the pull request by eye — it is open, it is not merged, nothing was pushed to `main` — and then close and
   delete the branch **in GitHub's own UI**: this client cannot, which is the point.
5. Write down what the API actually did — the statuses, the fields, the shape of a preview deployment — the way
   `docs/meta-model-api.md` records the model API, and note anything the recorded replies in `tests/github/` get wrong.

That exercise is the only thing in this package that needs the App, it is recorded on #231, and nothing in the
repository's own checks waits on it.
