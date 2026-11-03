# 3. A preview URL comes from the repository's own deployment, and we never run a customer's build

- **Status:** Accepted
- **Date:** 2026-11-03

## Context

Path 2 — _Improve my site_ — compares two **running** versions of a site: the baseline is the customer's live site, and the change is the version the pull request PersonaVision opened would deploy. The change therefore needs a URL that a hundred browsers can reach.

Most repositories that deploy a site already publish one: a Vercel- or Netlify-style preview deployment per pull request, whose URL arrives on the pull request's own deployment statuses. Some repositories have none, and for those there were two ways to get a URL:

1. read nothing, and tell the user that path 2 needs a preview deployment; or
2. build and host the customer's application ourselves — their build script, their dependencies, their lockfile and, for most real applications, their build-time secrets, executed on our infrastructure.

The second is a security boundary before it is a cost: running an untrusted build means arbitrary code execution on our machines, a place for the customer's secrets to live, and a second product to operate. The owner answered the question on **2026-11-03**.

## Decision

**The preview URL is read from the pull request's own deployment statuses, and from nowhere else. PersonaVision never runs a customer's build.**

- A pull request whose deployments carry a usable preview resolves to that URL. Several resolve to the most recent.
- A pending deployment is waited for within the caller's wall-clock cap and then reported as **not ready** — a different answer from not existing. A failed one is reported as **failed**, carrying what the status said. An unreachable URL is reported as **not usable**, carrying what the request answered.
- A repository with **no** per-pull-request preview deployment gets the plain state: _path 2 needs a preview deployment_. The run records that reason, the Improve screen renders it, and no comparison is reported that could not be made.
- No build runner, no container for a customer's build, no place in this repository where a customer's build script or lockfile is executed. There is no environment variable and no flag that turns one on.

## Alternatives considered

- **Build previews ourselves for repositories that have none.** The friendlier product: path 2 would work for every connected repository. It means executing an untrusted build, holding the customer's build-time secrets, and operating a build service — a second product, with the largest attack surface in the project, for the less common case.
- **Fall back to the baseline URL when there is no preview.** Cheap and quietly wrong: the before and after would be the same running site, and the verdict would report a change that was never deployed. Rejected for the same reason the holdout exists — the comparison must be one that was actually made.
- **Ask the customer to paste a URL for the changed version.** Keeps their build on their infrastructure, but there is no way to show that the URL is the pull request's version rather than something else, so the before/after would rest on an unverifiable claim.

## Consequences

- `packages/improve/src/preview/` resolves a URL through the GitHub client seam over a recorded transport, like every other call to GitHub in this product. It gains no network path of its own and no build step.
- The "no preview deployment" state is a first-class, tested state of the Improve screen and of the run artifact, not an error.
- A customer whose repository has no preview deployment can still use path 1 in full. Path 2 is the half that waits, and the product says what would unblock it.
- If this is ever revisited, it is a new ADR and a new product decision, not a flag: the moment we run a customer's build, this repository holds their secrets and executes their code, and that is not something a configuration change should be able to do.
