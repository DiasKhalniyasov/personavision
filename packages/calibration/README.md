# `@personavision/calibration`

The one place in this project where a human-likeness figure is produced.

Everything this product shows rests on one claim: the simulated gaze resembles human gaze. Unless that is scored
against real eye-tracking data, the heatmaps are decoration and the engine's weights are guesses. This package scores
the attention engine's predicted saliency maps and scanpaths against the **UEyes** benchmark, reports the figures per
UI category against two baselines, and fits the engine's configuration to them. The badge in the product's header
reads the result, so an honest low number is better than a flattering one — and a run by an engine that has never
been calibrated says _not calibrated_ rather than showing a number at all.

Step #11 builds this package over twelve tickets. #81 laid the ground the other eleven stand on — the vocabulary,
the dataset manifest, and the cache and licence policy — and #85 added the download: one command that brings the
real benchmark onto the machine, resumably and verifiably, into a cache outside this repository.

## What UEyes is and where it comes from

UEyes is an eye-tracking dataset of **62 participants** viewing **1,980 user-interface screenshots** across four UI
types — webpage, desktop, mobile and poster. It carries the raw eye-tracker logs, aggregated human saliency maps and
human scanpaths, each published at one, three and seven seconds of free viewing.

It accompanies the CHI 2023 paper:

> Yue Jiang, Luis A. Leiva, Hamed Rezazadegan Tavakoli, Paul R. B. Houssel, Julia Kylmälä and Antti Oulasvirta. 2023. _UEyes: Understanding Visual Saliency across User Interface Types._ In Proceedings of the 2023 CHI
> Conference on Human Factors in Computing Systems (CHI '23). ACM, Article 285, 1–21.
> <https://doi.org/10.1145/3544548.3581096>

The dataset is published on Zenodo and needs **no account, no credential and no payment**:

|                              |                                                     |
| ---------------------------- | --------------------------------------------------- |
| Record                       | <https://zenodo.org/records/8010312>                |
| Version DOI (pinned)         | `10.5281/zenodo.8010312`                            |
| Concept DOI (newest version) | `10.5281/zenodo.8010311`                            |
| Archive                      | `UEyes_dataset.zip`, 12,912,746,325 bytes (12.9 GB) |
| MD5                          | `c2d53e6af0a47e1f459416d6839ec2c1`                  |

The manifest pins the **version** DOI, not the concept DOI: the concept DOI follows the newest upload, and a figure
has to name the bytes it was measured against. The authors' own code and the archive's documented layout are at
<https://github.com/YueJiang-nj/UEyes-CHI2023>.

All of this is committed data in [`src/dataset/manifest.json`](src/dataset/manifest.json), loaded and validated by
[`src/dataset/manifest.ts`](src/dataset/manifest.ts). **No later ticket writes a URL, an archive path or a checksum
in code.** The MD5 above was read from the Zenodo record's own file metadata on 2026-10-26 — it is the publisher's
claim about the bytes, not a hash computed here, and the manifest says so. The download confirms it the first time
it runs, and `--record-checksums` then rewrites the entry as a locally computed one. The archive layout in the
manifest is likewise the authors' documentation and is marked `verifiedAgainstArchive: false`: the download compares
the archive's real tree with it and **fails naming the difference** rather than unpacking something else, so the
layout is corrected by hand, in a reviewed change, by whoever first runs it against the real archive.

## The licence, and what it forbids

The Zenodo record licenses the dataset under **CC BY 4.0**
(<https://creativecommons.org/licenses/by/4.0/>), access right _open_.

It **requires** that you credit the creators, link to the licence and state whether the material was changed wherever
a figure measured on this dataset is published, and that you pass the same freedoms on rather than adding a legal or
technical restriction of your own.

It **forbids**:

- implying that the creators endorse this product or the figures it reports;
- removing or distorting the attribution and licence notice when the material is shared;
- treating the licence as permission for anything the licensors did not themselves hold — the screenshots depict
  third-party interfaces whose own copyright and trade marks are not licensed here, and the participants' gaze data
  carries the consent the study obtained and no more.

The attribution to carry is in the manifest, at `dataset.licence.attribution`.

## This repository vendors no dataset bytes

**No UEyes image, map, scanpath or log is committed to this repository, and none ever will be.** Two reasons, and the
second is the binding one:

1. The archive is 12.9 GB. A repository that holds it is a repository nobody can clone.
2. CC BY 4.0 covers the dataset _as the authors published it_ — not the 1,980 third-party interfaces its screenshots
   depict. Vendoring even a handful of those screenshots would need a licence review of each depicted interface that
   nobody here is in a position to perform. The auto-decision on #11 settles this.

So calibration data comes from two places and neither is in the repository:

- **The real dataset** is downloaded on demand into a cache outside the repository (#85) and converted there (#86).
  A figure measured against it is comparable to published work.
- **The committed corpus is synthetic** (#82): a deterministic stand-in generated by committed code, shaped exactly
  as a converted UEyes record, so that the metrics, the baselines and the regression gate run in CI in seconds with
  no download. A figure measured on it is **not** a published UEyes score and is labelled as such wherever it appears.

## Where the cache lives

The download lives under the OS cache directory, never in the repository:

| Platform | Cache root                                                                             |
| -------- | -------------------------------------------------------------------------------------- |
| macOS    | `~/Library/Caches/personavision/calibration`                                           |
| Linux    | `$XDG_CACHE_HOME/personavision/calibration`, else `~/.cache/personavision/calibration` |
| Windows  | `%LOCALAPPDATA%\personavision\calibration`                                             |

One documented environment variable overrides it:

```sh
export PERSONAVISION_CALIBRATION_CACHE=/mnt/datasets/personavision
```

It must be an **absolute** path with no `.` or `..` segment — a relative one would put 12.9 GB wherever the command
happened to be run from, and a typo like `/mnt/data/../..` would silently retarget it at a system directory — and it
is then used exactly as given. When there is no home directory to be had, the last resort is a directory under the
system temporary directory, which is still outside the repository.

An absolute override is your deliberate choice and is honoured: these helpers do no filesystem access, so they
cannot know where this repository is and do not pretend to check. What they guarantee is that the _default_ lands
outside it on every platform, and that nothing derived from a manifest entry or an archive member escapes the root
they were given.

Within one dataset's directory (`<cache root>/ueyes`):

| Directory     | Holds                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| `downloads/`  | archives as fetched, each with its `.part` while in flight and its verification receipt |
| `dataset/`    | the unpacked tree, in the layout the manifest describes                                 |
| `quarantine/` | a file that failed its checksum, kept out of the way rather than silently reused        |
| `.staging/`   | an archive part-way out of its zip; moved onto `dataset/` only once it is whole         |

[`src/dataset/cache.ts`](src/dataset/cache.ts) is the only place these paths are decided. The helpers are pure path
arithmetic: they create no directory, read no file and open no socket, and they refuse a path that would climb out of
the cache — absolute, drive-relative (`C:foo` is not absolute on Windows but does leave), `..`, or carrying a
control character or a segment a platform would silently rewrite — so neither a hand-edited manifest nor a hostile
archive member can write outside it. `.gitignore` covers `.cache/`, which catches the one in-repo cache a mistake
realistically creates; an override naming some other in-repo directory is not ignored and would show up in a pull
request, where it is meant to be noticed.

## Downloading the dataset

One command brings the benchmark onto the machine. Its code is `src/dataset/fetch.ts`; the command-line wrapper
arrives with the CLI (#91), and until then the entry point is the function:

```ts
import { fetchDataset } from '@personavision/calibration';

await fetchDataset(); // fetch, verify and unpack into the cache
await fetchDataset({ recordChecksums: true }); // and write a locally computed checksum into the manifest
```

**What you are accepting by running it.** The command prints all of this before it fetches a byte, because
downloading the dataset is accepting it:

- **The licence.** CC BY 4.0, as above. Credit the creators and link the licence wherever you publish a figure
  measured on this data; the string to use is `dataset.licence.attribution`. The licence does not cover the
  third-party interfaces the screenshots depict, and it is not permission to imply that the authors endorse this
  product.
- **The disk.** 12.9 GB of archive plus its unpacked tree, under the cache root above and never inside this
  repository. Point `PERSONAVISION_CALIBRATION_CACHE` somewhere with room if your home directory has none.
- **The participants.** The gaze data carries the consent the original study obtained and no more.

No account, credential, API key or payment is involved, and none is read: the dataset is open access. A download
link can carry a token in its query string, so **no URL query string is ever written to the output** — the log and
every error name the origin and the path and nothing else.

**What the command does, and what it refuses to do.**

|                                   |                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resumes**                       | An interrupted transfer continues from the bytes already on disk with an HTTP range request, rather than starting over; progress is reported per file in bytes and percent. An origin that ignores the range makes it start again rather than append to the middle of a file.                                                                  |
| **Verifies**                      | Every file is hashed and compared with the manifest's checksum. A mismatch is a named failure: the file is moved to `quarantine/`, nothing is marked verified, and a second run fetches it again.                                                                                                                                              |
| **Refuses what it cannot verify** | A file the manifest records as `unverified` is refused before anything is fetched. `--record-checksums` hashes a fresh copy and writes the result into `manifest.json` as a change you review and commit — it prints the change, and it will not write over a recorded checksum that the bytes contradict. Verification never silently passes. |
| **Checks the layout first**       | The archive's own directory is read before a byte is unpacked and compared with `layout` in the manifest. A tree that contradicts it fails naming the difference; an `unknown` root is not a difference, and the directory the entries really sit under is reported and stripped.                                                              |
| **Does nothing twice**            | A verified file leaves a receipt beside it, so a second run over a complete cache downloads nothing, unpacks nothing and says so. A file touched since is hashed again rather than trusted on its name.                                                                                                                                        |
| **Leaves no half-extracted tree** | Every file is fetched and verified before anything is unpacked, and an archive is unpacked into `.staging/` and moved onto `dataset/` only once it is whole. A failed run exits non-zero naming the files it could not fetch, and keeps the part-downloads so the next run resumes.                                                            |

A hostile archive cannot write outside the cache: every member path goes through the containment rule in
`cache.ts`, and an absolute, `..`, drive-relative or symbolic-link member is refused by name rather than followed.

## The vocabulary

[`src/types.ts`](src/types.ts) declares what every later ticket of step #11 is written against. The words are
`docs/FLOW.md` section 8's: _fixation_, _saccade_, _dwell_, _scanpath_, _participant_, _session_, _seed_.

- **Geometry is image space.** The origin is the top-left pixel of the image the humans were shown, `x` runs right
  and `y` runs down. This is _not_ the run artifact's page space: a UEyes record is one image, with no page, no fold
  and no areas of interest, and the two spaces are never mixed.
- **A saliency map** is a continuous, non-negative field at a stated resolution, carrying the `imageSize` it
  describes. The convention is row-major: the cell at column `x`, row `y` is `values[y * width + x]`. Resolution,
  coordinate convention and normalisation are documented on the type itself, because CC, NSS, KLD and AUC-Judd are
  all sensitive to them and a reviewer has to be able to read what was compared.
- **Normalisation is named on the map**, not assumed by the metric. This package's own maps are `sum-to-one`. CC and
  NSS are invariant to an affine rescaling and AUC-Judd to any monotone one, but KLD reads both maps as
  distributions, so the rule travels with the data.
- **Viewport and `Fixation` come from `@personavision/contract`** rather than being restated. The contract is the
  only place in this repository where an artifact field name is declared; a human fixation is the contract's session
  fixation narrowed to the fields a free-viewing record has, which is why #86 can convert one into a session with no
  new format and no invented field.
- **The display the humans saw** travels with the ground truth and into the predictor, so a prediction is made at the
  resolution the humans saw and never at a default.
- **`Predictor`** is the seam every scored predictor is reached through: an image and a seed in, a saliency map and a
  scanpath out. The engine's `predict` (#68), the centre-bias prior and the random-fixation baseline (#87) all
  satisfy it, so one piece of code scores all three and a reported margin is a margin between comparable numbers.

## The dependency direction

This package reads `@personavision/contract`, and may later read `@personavision/engine`. **Nothing in
`packages/engine` or `apps/viewer` reads this package** — the engine is pure and the viewer only formats, and a
figure flows engine configuration → run artifact → viewer, never by either of them calling calibration.
`test/dependency-direction.test.ts` asserts both directions.

The engine's `predict` is not imported here at all: it is expected to satisfy the `Predictor` seam **structurally**.
`test/types.test.ts` assigns a value shaped as its documented return to a `Predictor`, which pins _this_ side of the
seam — the shape #68 has to produce. It cannot pin the engine's side: `predict` does not exist yet, and this package
may not import it, so #68 is asked on its own issue to assign its real `predict` to `Predictor` where that function
lives. Until it does, a divergence would show up as a failing score rather than as a type error.

## Running it

```sh
pnpm -F @personavision/calibration test   # the package's own suite
pnpm typecheck                            # builds every workspace package, then the root
pnpm lint
```

Everything in this package is green with **no network and no API key**. The download is tested against a stub
origin served from the test process over loopback, on whatever port the operating system hands it; nothing in CI
fetches the real dataset, and no test writes outside a temporary cache root it removes afterwards.

## This package's docs

| Doc                        | Ticket | What it records                                                             |
| -------------------------- | ------ | --------------------------------------------------------------------------- |
| This README                | #81    | UEyes, its licence, the cache, and the no-vendoring rule                    |
| `docs/corpus.md`           | #82    | the synthetic corpus: what each record exists to prove, and its byte budget |
| `docs/metrics-saliency.md` | #83    | CC, NSS, KLD and AUC-Judd: conventions, direction, degenerate cases         |
| `docs/metrics-scanpath.md` | #84    | ScanMatch and the sequence score, and their fixed parameters                |
| `docs/conversion.md`       | #86    | how a UEyes record becomes a session with `kind: "real"`                    |
| `docs/baselines.md`        | #87    | the centre-bias prior and random fixations: what each is evidence of        |

Those files arrive with their tickets; this table is the index they are added to.
