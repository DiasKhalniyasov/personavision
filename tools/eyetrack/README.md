# Eye tracking, run locally

A webcam eye tracker for any website. It opens Chrome, calibrates with your head free to move, shows a live gaze dot, screenshots every screen you settle on, and when you close the window writes heatmaps and a report of what you looked at.

This is how PersonaVision gathers real human attention: sessions recorded here are the gaze examples a model run is shown (`personavision run --gaze-examples`), and the data a small model of how real people look at a page can be fitted to. Nothing leaves your machine: the camera is read locally and every file is written under `sessions/`.

## Set up

Node 22 and pnpm (from the repository root), and Python 3.11.

```sh
pnpm install                                   # Playwright comes with packages/browser
pnpm --filter @personavision/browser exec playwright install chromium
cd tools/eyetrack/ptgaze
python3.11 -m venv .venv
.venv/bin/pip install -r ../requirements.txt   # ptgaze downloads its ETH-XGaze model on first run
```

## Record a session

```sh
node tools/eyetrack/track.mjs https://example.com            # desktop, maximised window
node tools/eyetrack/track.mjs https://example.com --mobile   # an iPhone 15 Pro viewport
node tools/eyetrack/track.mjs https://example.com --device "Pixel 8"
```

Follow the calibration dots, then use the site as you normally would. Close the window to finish; the session lands in `tools/eyetrack/sessions/<time>/` with its screenshots, gaze samples, heatmaps and report.

`report.py` and `video.py` rebuild the report and a gaze-overlaid video from a session directory. `narrate.py` turns a session into the narrated `gaze-example.txt` a model run reads; it calls the model, so it needs `MODEL_API_KEY`.

## Engines

`ptgaze` (the default) predicts a 3D gaze ray in Python (MIT, ETH-XGaze ResNet-18), so moving your head does not move the point. `EYETRACK_ENGINE=ours` and `EYETRACK_ENGINE=webeyetrack` are in-browser engines that need libraries this directory does not ship (`vendor/`); only `ptgaze` works from a fresh clone.

## Privacy

A recording is a video of your face's gaze on a screen. `sessions/` is ignored by git; never commit recordings of other people without their consent.
