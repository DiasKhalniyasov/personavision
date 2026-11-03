# 5. Where a session's video lives is one variable, and the mount redirects to it

- **Status:** Accepted
- **Date:** 2026-11-04

## Context

A run records one video per session: WebM, 720p, capped at 30 seconds a screen and 10 minutes a session, saved as `videos/S-NN.webm` inside the run directory (`CONTEXT.md`, #246). `docs/FLOW.md` section 17 lists "storage for session videos" as the second of the five things this revision needs the owner for, and says local disk inside the run directory is the default and an object store the alternative when the platform is hosted. The owner chose **Google Cloud Storage** on 2026-11-03; the bucket itself, its lifecycle rule and its credential are #228, which is the owner's and which this decision needs nothing from.

Three facts bear on the shape more than the choice of provider does:

1. **A Cloud Run task cannot write to the owner's disk.** `docs/adr/0004-where-sessions-run.md` already turns on this: a remote session's output has to come back some other way, and its video is the largest part of it.
2. **A video is big and a run is a hundred of them.** A hundred sessions is a hundred files of a megabyte or two, and a replay is read with `Range` requests — a scrubber seeks rather than downloads. Streaming those bytes through the application process means every seek of every replay crosses Node twice.
3. **`docs/adr/0001-run-data-over-http-as-static-files.md` is binding.** `GET /runs/<runId>/videos/S-NN.webm` is the URL, the viewer is written against it, and no screen may learn that a second place exists.

## Decision

**One seam, two implementations, chosen by `PV_VIDEO_BUCKET` in exactly one place.**

```ts
interface VideoStore {
  put(objectName: string, bytes: Uint8Array): Promise<void>;
  locate(objectName: string): Promise<VideoLocation>;
}

selectVideoStore(): VideoStore | null;
```

`PV_VIDEO_BUCKET` unset or empty answers **`null`**: the recording is the file in the run directory that `runPaths` names, which is what every test, the acceptance suite and the demo run on, and nothing constructs a client or reaches for a bucket. Set, it answers the store for that bucket, and the recordings of that process go there. `selectVideoStore` in `@personavision/contract` is the only function in the repository that reads the variable, and nothing that holds its answer branches on which it got.

**A session does not know where its video went.** The recording seam's contract is unchanged: a session hands bytes over and gets back the run-directory-relative `videos/S-NN.webm` that `@personavision/contract` declares. The artifact records that path and nothing else — **no bucket name, no object URL and no credential is ever written into a run artifact, a session JSON or a log line**, which `CONTEXT.md` requires of every account-shaped thing. Every message the seam produces names a status word and nothing more, because those messages are written into session files and read off screens.

**The URL a browser fetches does not change, and with a bucket it is a redirect.** With a store configured, the read-only run mount answers that path with a **302 to a short-lived V4 signed URL** rather than streaming the bytes. `host` is the only signed header, so the `Range` a player re-sends is carried to the store and served by it: a 1.4 GB recording never crosses this process, and seeking is the store's problem. The signed URL lasts an hour, because a `<video>` element holds one URL for the whole of a replay and a ten-minute URL would expire mid-scrub.

**One recording has one home.** With a bucket configured the local copy is removed once the bytes are stored, so there is never a question about which file is the recording. An upload that is refused is retried, and a recording that cannot be stored after its retries is the same stated absence a recording that could not be made already is — the session keeps its data, and the run says the video is missing with the reason. A video is never a reason to lose a session.

**A video that has aged out is a state, not a 500.** The lifecycle rule of #228 deletes a test's videos after thirty days. The mount asks the store whether it still holds the object before it signs, and answers one that is gone with **410** and a typed, worded body — `{ "state": "no-longer-kept", "reason": … }` — which the results screens render. Never a 500, and never an empty body: a recording that is absent and one that is zero bytes long must not look the same to a client.

**The credential is Google's to read, not ours.** This repository reads `PV_VIDEO_BUCKET`, which is a bucket name. The default transport takes its access token from the metadata server of the machine it runs on and signs through that identity's own `signBlob`, so no private key is read, held or needed — and `tests/workspace.test.ts`'s scanner keeps `packages/provider`'s model key as the one sanctioned credential read in the workspace, with **no new exception** for this. A deployment authorised some other way injects a `VideoObjectTransport`, which is the shape every third-party call here takes, and the default is built only when none is given.

## Alternatives considered

**Streaming the bytes through the application process from the bucket.** Rejected on arithmetic. A replay is `Range` requests, so a single scrubbing session is dozens of round trips; serving them through Node means every byte is downloaded from the store and uploaded to the browser, doubling egress and holding a connection per seek. The redirect makes the store answer the request it is best at.

**A Google client library.** Rejected: `@personavision/swarm`'s Cloud Run transport already showed that the two calls a job needs are `fetch` against a documented REST endpoint, and the same is true here — one upload, one metadata read, one `signBlob`. A library would be a dependency whose transport we could not inject, and injecting the transport is what lets every test here run with no network and no credential.

**Signing with a service-account private key.** Rejected: it would mean this repository reading a credential, which is exactly the rule `CONTEXT.md` fixes and `tests/workspace.test.ts` enforces. `signBlob` against the identity the process already runs as produces the same V4 signature with no key in our hands.

**Keeping both copies — the file on disk and the object in the bucket.** Rejected: two copies is two answers to "where is the recording", and the mount would have to choose one. It also doubles the storage of the thing this decision exists to move off the disk.

**Putting the seam in `@personavision/platform`.** Rejected on the dependency graph, not on taste: `@personavision/browser` writes the recording and cannot depend on the platform, and `@personavision/cli`'s own barrel deliberately keeps Playwright out of the viewer's dev server, so the platform could not have reached the recorder either. `@personavision/contract` is the package both halves already depend on, and it is already the only declaration of where a run's files live — an object store is that declaration extended, not a second one.

## Consequences

- `PV_VIDEO_BUCKET` is the one variable, listed in `docs/deployment.md` with the rest, and not a credential.
- The viewer is untouched. `GET /runs/<runId>/videos/S-NN.webm` is the path either way, and `Range` still works.
- With a bucket configured the run directory holds no `videos/` files, and a replay is served by the store.
- `locate` costs one metadata read per video request, which is what the typed "no longer kept" state is bought with. Cache it by object name if a replay screen ever asks more than once per view.
- A recording is kept for **thirty days** and then the mount says so. The results screens have a state to render for it.
- **What this does not do:** a remote session's *session file* and its run contributions still do not come home. `packages/swarm`'s Cloud Run task writes its session to a scratch directory and exits saying so, which the coordinator records as that session's typed automation failure (`docs/adr/0004`). This decision moves the video and nothing else.

## What it costs per test

Measured, not estimated: `packages/browser/README.md` records **71 KB for a 1.4 second recording**, about 25–45 KB/s. Prices are Google's published figures for standard storage in a single US region ($0.020 per GB-month, $0.005 per 1,000 class-A operations, $0.12/GB egress to the internet in North America) and they change.

| A test of a hundred sessions                   | Stored  | Thirty days | Uploads   |
| ---------------------------------------------- | ------- | ----------- | --------- |
| 45 s a session, the shape a real walk takes     | ~160 MB | **~0.3 ¢**  | ~0.05 ¢   |
| every session to the 10-minute cap, worst case  | ~2.7 GB | **~5.4 ¢**  | ~0.05 ¢   |

Watching a replay costs its own egress — about 0.02 ¢ for a 1.6 MB recording — and is paid per view rather than per test. So a hundred-session test costs well under a cent to keep for its thirty days, which is why the lifecycle rule is thirty days and not three.
