# Eye tracker: gaze over screenshots

A single page you open from disk. It records where a real person looks on screenshots of a
site, using their own webcam, and writes one JSON file in the shape `packages/calibration`
reads. Nothing is installed, nothing is built, and nothing leaves the machine.

## Run it

```sh
open tools/eyetrack/calibrate/index.html          # macOS
xdg-open tools/eyetrack/calibrate/index.html      # Linux
```

Or serve the directory and open it over `http://localhost`:

```sh
python3 -m http.server --directory tools/eyetrack/calibrate 8000
```

Either works. A browser hands over the camera only in a _secure context_, which means a
`file://` URL, `localhost`, or `https://` — a plain `http://` host on the network has no
camera to offer, and the page says so rather than failing quietly. On a phone, that is the
catch worth knowing about: pointing it at `http://192.168.x.x` will not work, so forward the
port (`ssh -R`, or any tunnel) and open it over `https://` or `localhost`.

Then: type a participant id, choose screenshots, calibrate, look at the screenshots, save the
file.

## What it records, and what it does not

It records gaze over **screenshots**, shown one at a time at a fixed size. It does **not**
instrument a live third-party page. A page belonging to somebody else cannot be instrumented
from a tool like this, and a tool that claimed otherwise would be lying about what it
measured.

That is not a workaround — it is the shape the ground truth has. The UEyes benchmark this
project calibrates against is itself gaze over single screenshots, and
`packages/calibration`'s converter takes one record per screenshot with one log per
participant. A recording made here goes beside UEyes' own, measured the same way.

**Webcam gaze is accurate to around 100 px.** That is the published figure for WebGazer
(Papoutsaki et al., IJCAI 2016) and it is the honest ceiling on anything recorded here: good
enough to say which region of a page drew the eye, not good enough to say which word. The tool
measures its own error after calibrating and writes the number into the file, so no reader has
to take the figure on trust.

**Nothing is uploaded.** The camera frames, the gaze estimates and the screenshots stay in the
browser tab; the recording reaches the disk only through the Save button. There is no code in
the page that could do otherwise:
`packages/calibration/test/eyetrack-sample.test.ts` scans `index.html`, `eyetrack.js` and
`fixations.js` for every networking entry point a browser offers and fails if one is so much
as named.

If you record somebody else, ask them first, and tell them what the file holds.

## How it works

1. **Setup.** A participant id — typed, and nothing about the person — the screenshots, what
   kind of interface they show, and how long each is shown.
2. **Camera.** WebGazer starts, with the face box and preview visible so the participant can
   sit square to it.
3. **Calibration.** Nine points. The participant looks at each and clicks it five times.
   Clicking is how the model learns: it pairs the image of the eyes with a place on screen
   that the eye is known to be on.
4. **Accuracy check.** Five seconds looking at one point, on an otherwise bare display, and
   the distance from it is measured. This is gaze the model was never fitted on, which is why
   it is a separate step and not a summary of the calibration's own residuals. **Recording
   stays closed until this has run** — a recording with no calibration behind it is not data.
5. **Recording.** A centre cross for a second, then one screenshot for its exposure, and on to
   the next. The display holds nothing but the screenshot: no preview, no face overlay, no
   gaze dot, because each of those is a bright moving thing and a bright moving thing is where
   the eye goes.
6. **Save.** One JSON file, named for the participant and the time.

Four things in `eyetrack.js` exist to protect the data, and each one fights the library's
defaults: WebGazer's mouse listeners are removed so no button press is mistaken for a glance,
its stored model is cleared so the last participant's calibration cannot become this one's,
the display is stripped bare while checking and recording, and **the prediction dot is never
shown** — it sits near where the eye already is, so a participant who glances at it is chasing
their own gaze, which poisons a training pair and flatters the accuracy figure.

## The file

The chosen format is **`packages/calibration`'s raw-record shape** — the converter's input,
not a finished session — under one envelope key. The auto-decision is on
[#430](https://github.com/DiasKhalniyasov/personavision/issues/430).

```jsonc
{
  "tool": "personavision/tools/eyetrack/calibrate",
  "writerVersion": 1,
  "format": "packages/calibration RawRecord[] under .records",
  "tracker": {
    "name": "WebGazer.js",
    "version": "1.0.1",
    "regression": "ridge",
    "faceTracker": "clmtrackr",
  },
  "gazeSource": "webcam",
  "recordedAt": "2026-11-05T09:14:02.511Z",
  "participantId": "p01",
  "display": { "viewportWidth": 1280, "viewportHeight": 757, "devicePixelRatio": 1 },
  "calibration": {
    "points": 9,
    "clicksPerPoint": 5,
    "checkDurationMs": 5000,
    "check": { "samples": 125, "meanErrorPx": 93.3, "medianErrorPx": 85.8, "p90ErrorPx": 161 },
  },
  "fixationDetector": {
    "algorithm": "I-DT (Salvucci & Goldberg 2000)",
    "dispersionPx": 100,
    "minDurationMs": 100,
    "maxGapMs": 150,
  },
  "records": [
    {
      "id": "pricing", // the image's name, no extension
      "category": "webpage", // webpage | desktop | mobile | poster
      "viewingDurationSeconds": 3, // 1, 3 or 7 — UEyes' conditions
      "image": { "file": "pricing.png", "width": 1440, "height": 900 },
      "display": { "viewportWidth": 1090, "viewportHeight": 681, "scale": 1.3211 },
      "participants": [
        {
          "participantId": "p01",
          "fixations": [{ "index": 0, "tMs": 29, "durationMs": 160, "x": 321.8, "y": 149.7 }],
        },
      ],
      "gaze": [{ "tMs": 29, "x": 331.5, "y": 165.1 }], // extra: the raw samples
      "dropped": { "outsideImage": 14, "outOfOrder": 0 }, // extra: what was thrown away
    },
  ],
}
```

Read it with one call:

```ts
import { convertRecords } from '@personavision/calibration';

const file = JSON.parse(await readFile(path, 'utf8'));
const { sessions, rejections } = convertRecords(file.records);
```

What comes back is sessions `packages/contract`'s own `sessionSchema` accepts, with
`kind: "real"`, a `participant` and no persona — the same shape a simulated session has, which
is the whole point: calibration is a comparison of two files of one shape.

A few things worth knowing about the fields:

- **Geometry is image space.** The origin is the screenshot's top-left pixel, in the image's
  own pixels. `display` is what the participant actually saw — the area the screenshot
  occupied in CSS pixels, and the image's pixels per CSS pixel — because a prediction is later
  made at the resolution the human saw and never at a default.
- **`viewingDurationSeconds` is 1, 3 or 7** and nothing else. Those are the conditions UEyes
  publishes its ground truth at, and the converter rejects any other: a figure measured at one
  exposure is not the figure measured at another.
- **Fixations are derived; gaze is measured.** WebGazer gives a stream of estimates at about
  25 Hz, not fixations, so `fixations.js` reads fixations out of it by dispersion-threshold
  identification (I-DT). The thresholds are in the file and the raw samples are in `gaze`
  beside the fixations, so anyone who prefers a velocity-based detector has what they need to
  run it. The dispersion threshold is 100 px on purpose: tighter than the tracker's own error
  would be fitting noise.
- **`gaze` and `dropped` are extra**, and the converter ignores them. Gaze that fell off the
  screenshot is dropped rather than clamped — a point off the image is not somewhere a human
  looked at it — and counted, because the share that missed is how a reader judges a
  recording.

### The sample

`sample/p01-three-screenshots.json` is a complete file: three screenshots, one participant,
3-second exposures. **Its gaze is synthetic**, which it says in its own `gazeSource` and in a
`note` beside it — written by this tool from a scripted stand-in for the tracker, not recorded
from a person. It stands in exactly as `packages/calibration/test/corpus` stands in for UEyes:
generated by committed code, in the real shape. Only those two provenance fields differ from
what the page wrote; every record is its own output, and the test re-derives each record's
fixations from the raw gaze committed beside them.

## Files

|                |                                                                          |
| -------------- | ------------------------------------------------------------------------ |
| `index.html`   | the page: markup, styles, and the three `<script>` tags                  |
| `eyetrack.js`  | the instrument — camera, calibration, the recording gate, the stage      |
| `fixations.js` | the arithmetic — gaze in, raw records out. No DOM, and checked by a test |
| `vendor/`      | WebGazer 1.0.1 and its licence. `vendor/README.md` says why that version |
| `sample/`      | one complete file                                                        |

The scripts are classic browser scripts rather than ES modules, and deliberately: a browser
refuses to load a module from a `file://` URL, and this page has to open from one. That is also
why `tools/` is outside the project's TypeScript build — `tsconfig.json` says so — while
ESLint still covers the tool's own two files.

## Where the data goes

Nowhere by itself. `packages/calibration` is where the comparison against human eye tracking
lives; `docs/FLOW.md` section 9 still defers webcam sessions as a _product surface_ — real
participants inside a run, on the Sessions and Replay screens — and this tool does not put
them there. It is a collection tool, and the collecting is done by hand.
