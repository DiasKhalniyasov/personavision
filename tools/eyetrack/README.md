# Eye tracker

Webcam eye tracking, run on your own machine. Records where real people look, so that
PersonaVision's agents can be measured against — and taught from — how people actually read a
page. Nothing leaves your computer.

There are **two** tools here, because there are two different jobs.

|                                                          | What it records                                                                   | What you need                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------- |
| [**`calibrate/`**](calibrate/)                           | Gaze over **screenshots** of a site, in the shape `packages/calibration` reads    | A browser. Open one file            |
| [**`track.mjs`**](#gaze-over-a-live-site-driven-locally) | A whole **browsing session** on a live site, as heatmaps, gaze paths and a report | Python, a venv, Playwright Chromium |

Start with `calibrate/` if you want data the project can score itself against, or if you just
want to see webcam eye tracking work in the next thirty seconds. Use `track.mjs` if you want to
watch somebody use a site.

Record other people only with their consent, and tell them what the file holds.

## Gaze over screenshots — no install

→ **[`calibrate/`](calibrate/)**

One static page. Open `calibrate/index.html` from disk, calibrate on nine points, look at some
screenshots, and save a JSON file. WebGazer is vendored beside it, so the page works with no
network and makes no request to any host.

```sh
open tools/eyetrack/calibrate/index.html          # macOS
xdg-open tools/eyetrack/calibrate/index.html      # Linux
```

It records gaze over **screenshots**, shown one at a time at a fixed size — not over a live
third-party page, which cannot be instrumented from a page like this. That is also the shape
the UEyes benchmark has, which is why its output drops straight into
`packages/calibration`'s converter:

```ts
const { sessions } = convertRecords(JSON.parse(text).records);
```

Webcam gaze is accurate to around 100 px. The page measures its own error after calibrating,
refuses to record until it has, and writes the figure into the file.
[`calibrate/README.md`](calibrate/README.md) has the format, the fields and the honest limits.

## Gaze over a live site, driven locally

The heavier tool: it drives its own Chromium, so it can follow a real browsing session across
a live site and produce a report of it.

<p>
  <img src="media/gaze-replay.gif" width="320" alt="Live gaze on a phone screen, with the person's own words">
  <img src="media/heatmaps.gif" width="300" alt="Numbered gaze path and heatmap over each screen">
</p>

_Left: live gaze with the person's own words. Right: where they looked, in order._

### Run

```sh
pnpm install && pnpm --filter @personavision/browser exec playwright install chromium
python3.11 -m venv tools/eyetrack/ptgaze/.venv
tools/eyetrack/ptgaze/.venv/bin/pip install -r tools/eyetrack/requirements.txt

node tools/eyetrack/track.mjs https://example.com            # desktop
node tools/eyetrack/track.mjs https://example.com --mobile   # phone
```

Calibrate, browse, close the window. Output: `tools/eyetrack/sessions/<time>/`.

### Use the data

- `narrate.py <session>` writes `gaze-example.txt` for `personavision run --gaze-examples`
  (needs `MODEL_API_KEY`, and so is the one step here that talks to a network).
- `report.py` and `video.py` rebuild the report and a gaze-overlay video.

`sessions/` is git-ignored.
