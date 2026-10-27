# The committed capture set

What `createFixtureSource(dir)` replays: the fixture site's four steps, recorded once and
checked in, so that the attention engine, the swarm and their tests run with no network, no
browser and the same bytes every time.

**This directory is recorded, not written.** `pnpm -F @personavision/browser record:captures`
serves `../site/` on a free port, drives Chromium through it and rewrites everything here.
Nothing in it is edited by hand: `../../determinism.test.ts` records the site again and holds
the JSON below to being that recorder's output, so an edit here — or a change to a page in
`../site/` that nobody re-recorded — fails the suite rather than quietly becoming the fixture
the rest of the project builds against.

`.prettierignore` leaves this directory alone for the same reason it leaves the calibration
corpus alone: these bytes are asserted, so a formatter would make the recorder and the
committed files disagree.

## Layout

```
capture-set.json                 the index: each variant, the device it was recorded under,
                                 and its steps in the order the walk reached them
captures/<variant>/<step>.json   one capture per variant and step: the geometry, the fold,
                                 the elements with their stable ids, and the step label
screenshots/<variant>/<step>.png the full-page screenshot beside it
```

The first two names are this module's own; the third is not. The recorder captures into a
**temporary run directory**, so the images are written by `writeScreenshot` to exactly where
`runPaths(runDir).screenshot(variant, step)` puts a run's, and then copied in here at that
same relative path. A capture's `screenshot` field is therefore the run-directory-relative
path `run.json` records, which is what lets a replay copy the recorded image into a real run
directory and hand back the same path the live source would — and everything else a run
directory accumulates, the capture cache's `.capture-cache/` among it, stays out of here.

## What was recorded

| variant | device  | viewport | device scale factor | steps                                  |
| ------- | ------- | -------- | ------------------: | -------------------------------------- |
| `A`     | mobile  | 390x844  |                   3 | cart → payment → review → confirmation |
| `B`     | desktop | 1440x900 |                   1 | cart → payment → review → confirmation |

Two variants over one site, at the two viewports `../site/LANDMARKS.md` documents, because
the one control that changes side with the fold does so between them: `#cart-promo-apply`
starts at y 862, which is below a 844-tall viewport's fold and above a 900-tall one's. So the
committed set holds both readings of one control, and an offline run can compare two variants
as a real run does.

**A session has to ask for the device its variant was recorded under.** A capture's geometry
is that viewport's and every `belowFold` in it was computed from that fold, so
`openSession` refuses a device whose viewport or device scale factor is another one and names
the pair in the error. The device's name and whether it has touch are labels a recording does
not depend on, and are not compared.

The walk is the walk the task's primary actions make, which is why a replayed click on the
step's primary action advances along it. The payment step submits its form by `GET`, so the
review step was recorded at `/review.html?card=&expiry=01`; a recorded step carries its path
and no origin, and a replay resolves it against the variant URL the session was opened with.

## Determinism, and what it does not cover

Nothing recorded here is about the machine that recorded it: no timestamps, no run id, and no
ephemeral port. The fields are written in a fixed order rather than in the order a capture
happened to be built in, so a seam that spreads an element to set one flag cannot move a field
and change a committed file.

The screenshots are a different matter: PNG bytes are a function of the Chromium build that
drew them. So the determinism test asserts the **recorder** byte for byte — two recordings of
the unchanged site, on one machine, produce identical files — and compares the committed
**JSON** against a fresh recording, which is the part that is a property of the site rather
than of the browser. A Chromium upgrade therefore shows up as changed images and unchanged
data, and the data is what every metric is computed from.

The eight images are about 900 kB in all, nearly all of it variant A: a mobile capture is
three device pixels to the CSS pixel, so its full-page screenshots are nine times the area of
the desktop ones.
