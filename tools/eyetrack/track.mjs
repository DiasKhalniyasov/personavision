// Webcam eye tracking on any site, live:
//   node tools/eyetrack/track.mjs <url> [out dir] [--mobile | --device "<name>"] [--size WxH]
// Desktop by default, in a maximised window; --size sets its resolution. --mobile emulates an
// iPhone 15 Pro (393x659 viewport, touch, mobile user agent), --device any phone Playwright
// knows (e.g. "Pixel 8", "Galaxy S24"), and --size overrides the phone's resolution too.
// Opens Chrome, calibrates (with your head moving, so you may move it), shows a live gaze dot, screenshots every screen you
// settle on, and when you close the window writes heatmaps and a report of what you looked at.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, devices } from '../../packages/browser/node_modules/playwright/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: { mobile: { type: 'boolean' }, device: { type: 'string' }, size: { type: 'string' } },
});
const url = positionals[0];
const die = (message) => {
  console.error(message);
  process.exit(2);
};
if (!url)
  die(
    'usage: node tools/eyetrack/track.mjs <url> [out dir] [--mobile | --device "<name>"] [--size WxH]',
  );
const size = opt.size === undefined ? null : /^(\d+)x(\d+)$/.exec(opt.size);
if (size === null && opt.size !== undefined)
  die(`--size takes WIDTHxHEIGHT, e.g. 1440x900 or 390x844; not ${opt.size}`);
const viewport = size ? { width: Number(size[1]), height: Number(size[2]) } : null;
const phone = opt.device ?? (opt.mobile ? 'iPhone 15 Pro' : null);
if (phone && !devices[phone]) {
  die(
    `no device "${phone}"; phones Playwright knows include: ${Object.keys(devices)
      .filter((k) => /^(iPhone 1[45]|Pixel [78]|Galaxy S2)/.test(k) && !k.includes('landscape'))
      .join(', ')}`,
  );
}
// What the page is shown as: a phone (its viewport, pixel density, touch and user agent) or
// desktop, at --size or at whatever the maximised window gives.
const phoneProfile = { ...(phone ? devices[phone] : {}) };
delete phoneProfile.defaultBrowserType;
const emulation = phone
  ? { ...phoneProfile, ...(viewport ? { viewport, screen: viewport } : {}) }
  : { viewport };
const view = phone
  ? `${phone} (mobile) ${emulation.viewport.width}x${emulation.viewport.height}`
  : viewport
    ? `desktop ${viewport.width}x${viewport.height}`
    : 'desktop, maximised window';
console.log(`view: ${view}`);
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const out = positionals[1] ?? join(here, 'sessions', stamp);
mkdirSync(join(out, 'screens'), { recursive: true });

const samples = [];
const screens = [];
const calibrated = new Map(); // origin -> median error in px

const browser = await chromium.launch({
  headless: false,
  // Ctrl+C is the tracker's to handle: Playwright's own handler exits before the session is saved.
  handleSIGINT: false,
  handleSIGTERM: false,
  channel: 'chrome',
  args: [
    ...(phone || viewport ? [] : ['--start-maximized']),
    ...(process.env.EYETRACK_FAKE_CAMERA
      ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
      : []),
  ],
});
// Service workers blocked: a site's own worker answers requests before the tracker's routes
// can, and never serves the gaze model (higgsfield.ai's hung WebEyeTrack's start).
const context = await browser.newContext({
  ...emulation,
  permissions: ['camera'],
  bypassCSP: true,
  serviceWorkers: 'block',
});
await context.exposeBinding('__eyetrackSamples', (_src, batch) => void samples.push(...batch));
// One calibration for the whole session: every page and every site the tracker opens trains
// on the same samples, so moving to another page or site never asks for it again.
let training = null;
await context.exposeBinding('__eyetrackLoad', () => training);
await context.exposeBinding('__eyetrackSave', (_src, samples) => {
  training = samples;
  writeFileSync(join(out, 'calibration.json'), JSON.stringify(samples));
});
let progress = null; // the calibration so far, kept here so a reload resumes it
await context.exposeBinding('__eyetrackGetProgress', () => progress);
await context.exposeBinding('__eyetrackSetProgress', (_src, value) => {
  progress = value;
});
await context.exposeBinding('__eyetrackLog', (_src, message) => console.log(`[page] ${message}`));
await context.exposeBinding('__eyetrackCalibrated', (_src, origin, px) => {
  calibrated.set(origin, px);
  console.log(`calibrated: accuracy ≈ ${px} px`);
});
// ptgaze (default): a 3D gaze ray from ptgaze in Python, met with the screen plane, so the head
// may move. webeyetrack: WebEyeTrack's in-page CNN. ours: the landmark regression in gaze-model.js.
const engine = process.env.EYETRACK_ENGINE ?? 'ptgaze';
console.log(`engine: ${engine}`);
const read = (name) => readFileSync(join(here, name), 'utf8');
await context.addInitScript({
  content: {
    ours: `${read('gaze-model.js')}\n${read('page.js')}`,
    webeyetrack: read('page-wet.js'),
    ptgaze: `${read('gaze-model.js')}\n${read('page-pt.js')}`,
  }[engine],
});
// WebEyeTrack's bundle, and its gaze model, which it loads from <origin>/web/ of whatever page it is on.
await context.route('**/__eyetrack/wet/**', (route) =>
  route.fulfill({
    path: join(
      here,
      'vendor',
      'wet',
      new URL(route.request().url()).pathname.split('/__eyetrack/wet/')[1],
    ),
  }),
);
await context.route(/\/web\/(model\.json|group1-shard1of1\.bin)$/, (route) =>
  route.fulfill({
    path: join(
      here,
      'vendor',
      'wet',
      'web',
      new URL(route.request().url()).pathname.split('/').pop(),
    ),
  }),
);
// The blank page calibration runs on, under the site's own origin so the camera and the
// training carry over; the site's scripts never run on it.
await context.route('**/__eyetrack/calibrate*', (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Calibration</title><body style="margin:0;background:#111"></body>',
  }),
);
// MediaPipe's code, wasm and face model, served under every site's own origin.
await context.route('**/__eyetrack/tv/**', (route) =>
  route.fulfill({
    path: join(
      here,
      'vendor',
      'tv',
      new URL(route.request().url()).pathname.split('/__eyetrack/tv/')[1],
    ),
  }),
);

context.on('page', (p) => {
  console.log('[tracker] new tab');
  p.on('pageerror', (e) => console.error(`page error: ${e.message.slice(0, 300)}`));
  p.on('crash', () => console.error('[tracker] the page crashed'));
  p.on('console', (m) => {
    if (m.type() === 'error') console.error(`[console] ${m.text().slice(0, 200)}`);
  });
  p.on('framenavigated', (f) => {
    if (f === p.mainFrame()) console.log(`[tracker] navigated: ${f.url()}`);
  });
});
let page = await context.newPage();

// The ptgaze engine: Python owns the camera and streams a point per frame, handed to the page
// the eyes are on. A frame that arrives while the last is still being handed over is dropped.
let gazeServer = null;
if (engine === 'ptgaze') {
  gazeServer = spawn(
    join(here, 'ptgaze', '.venv', 'bin', 'python'),
    [
      join(here, 'ptgaze', 'gaze_server.py'),
      ...(process.env.EYETRACK_VIDEO ? ['--video', process.env.EYETRACK_VIDEO] : ['--stdin']),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  gazeServer.stdin.on('error', () => {}); // a server that exited: its exit is logged
  // The page's camera frames, one at a time: a frame that comes while the server is still on
  // the last one is dropped, so gaze never runs behind the eyes.
  let inFlight = false;
  await context.exposeBinding('__eyetrackFrame', (source, b64) => {
    if (inFlight || source.page !== page || !gazeServer.stdin.writable) return false;
    inFlight = true;
    const jpeg = Buffer.from(b64, 'base64');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(jpeg.length);
    gazeServer.stdin.write(Buffer.concat([head, jpeg]));
    return true;
  });
  gazeServer.stdout.on('data', () => {
    inFlight = false;
  });
  gazeServer.stderr.on('data', (d) => {
    const line = String(d).trim();
    if (/fps|Error|error|camera/.test(line)) console.log(`[gaze] ${line.slice(0, 200)}`);
  });
  gazeServer.on('exit', (code) => console.log(`[gaze] server exited (${code})`));
  let handing = false;
  createInterface({ input: gazeServer.stdout }).on('line', (line) => {
    let s;
    try {
      s = JSON.parse(line);
    } catch {
      return;
    }
    if (s.ready) return console.log(`[gaze] ready: ${s.width}x${s.height} camera, ${s.device}`);
    if (handing) return;
    handing = true;
    page
      .evaluate((v) => window.__eyetrackRaw?.(v), s)
      .catch(() => {})
      .finally(() => {
        handing = false;
      });
  });
}
context.on('page', (opened) => {
  page = opened;
}); // a link that opens a tab: follow the eyes there
await page.goto(`${new URL(url).origin}/__eyetrack/calibrate?back=${encodeURIComponent(url)}`);
console.log(`tracking ${url} — calibrate in the window; close it (or Ctrl+C) to finish`);

// A screen is a URL and a scroll position you stayed on for half a second: each gets a picture.
let seen = null;
let pending = null;
const poll = setInterval(async () => {
  try {
    const now = await page.evaluate(() => ({
      url: location.href,
      sx: Math.round(scrollX),
      sy: Math.round(scrollY),
      vw: innerWidth,
      vh: innerHeight,
    }));
    const key = `${now.url}|${now.sx}|${now.sy}|${now.vw}x${now.vh}`;
    if (key === seen || now.url.includes('/__eyetrack/')) return;
    if (pending?.key !== key) {
      pending = { key, since: Date.now() };
      return;
    }
    if (Date.now() - pending.since < 500) return;
    seen = key;
    const file = `screens/${String(screens.length + 1).padStart(2, '0')}.png`;
    await page.evaluate(() => {
      for (const d of document.querySelectorAll('[data-eyetrack]')) d.style.visibility = 'hidden';
    });
    await page.screenshot({ path: join(out, file), scale: 'css' });
    await page.evaluate(() => {
      for (const d of document.querySelectorAll('[data-eyetrack]')) d.style.visibility = '';
    });
    screens.push({ index: screens.length, t: pending.since, ...now, file });
  } catch {
    // mid-navigation: the next poll sees the new page
  }
}, 250);

let finished = false;
const finish = async () => {
  if (finished) return;
  finished = true;
  clearInterval(poll);
  gazeServer?.kill();
  // Saved first: whatever happens while the browser closes, the session is on disk.
  writeFileSync(join(out, 'samples.jsonl'), samples.map((s) => JSON.stringify(s)).join('\n'));
  writeFileSync(
    join(out, 'screens.json'),
    JSON.stringify({ url, view, calibration: Object.fromEntries(calibrated), screens }, null, 1),
  );
  await browser.close().catch(() => {});
  console.log(`${samples.length} gaze samples over ${screens.length} screens`);
  spawnSync('python3', [join(here, 'report.py'), out], { stdio: 'inherit' });
  process.exit(0);
};
context.on('close', finish);
browser.on('disconnected', finish);
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
setInterval(() => {
  if (context.pages().length === 0) finish();
}, 500);
if (process.env.EYETRACK_SECONDS) setTimeout(finish, Number(process.env.EYETRACK_SECONDS) * 1000);
