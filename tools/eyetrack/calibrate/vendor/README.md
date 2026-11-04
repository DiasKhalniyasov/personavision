# Vendored library

## `webgazer.js`

WebGazer.js 1.0.1 — webcam gaze estimation from the Brown HCI Group.

|                 |                                                                    |
| --------------- | ------------------------------------------------------------------ |
| Version         | `1.0.1`                                                            |
| File            | the `index.js` of the npm package, unchanged                       |
| Source          | `https://registry.npmjs.org/webgazer/-/webgazer-1.0.1.tgz`         |
| Tarball SHA-256 | `8d871399983026960478fe64026335b6b749e6bdaac60aa22a4b6a9929c13712` |
| File SHA-256    | `93c51216925877b0019f7776dce7d84c903ec224fbd80b6d386380eff67cef5f` |
| Project         | <https://github.com/brownhci/WebGazer>                             |
| Licence         | GPL-3.0-or-later — `LICENSE` beside this file                      |

`packages/calibration/test/eyetrack-sample.test.ts` pins the file digest, and fails if the
file is replaced.

### Why 1.0.1 and not the newest

Because the page has to work with no network, and no later version does.

Every WebGazer from 2.0.1 onwards estimates the face with TensorFlow.js and a face-landmark
model that is **downloaded the first time it runs**. That is a request to a third-party host
on a page whose whole claim is that it makes none — and vendoring the model instead would mean
patching a hard-coded URL inside a minified bundle, which is a promise nobody could check.
1.0.1 carries its face tracker (`clmtrackr`) and its regression (`numeric`, `regression.js`)
inside itself, so the file beside this one is the whole dependency.

It is also the version the accuracy figure belongs to. The "around 100 px" this project
quotes is from Papoutsaki et al., _WebGazer: Scalable Webcam Eye Tracking Using User
Interactions_ (IJCAI 2016) — measured on this tracker, not a later one.

### What it is allowed to do

Nothing but read camera frames and do arithmetic. It holds one `XMLHttpRequest`, in the
`getURL` helper of the bundled `numeric.js`, which WebGazer never calls; the test pins that
there is exactly one occurrence, so a second would be a real request.

It is reached from one place in this repository — a `<script>` tag in
`tools/eyetrack/calibrate/index.html` — and from no package in the workspace. Nothing that
ships imports it, which is why a GPL library sits in a repository whose own `package.json`
says `UNLICENSED`: it is a tool a developer runs, not part of the product.
