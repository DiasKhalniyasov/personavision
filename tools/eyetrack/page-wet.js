// The WebEyeTrack engine (MIT, arXiv 2508.19544): a small gaze CNN on the eye patch that takes
// head pose and face position into account, personalised from a few calibration dots. Runs
// inside every page the tracker opens; calibration samples are kept by track.mjs and replayed
// on each new page, because the adapted model lives only as long as the page.
(() => {
  if (
    window.top !== window ||
    window.__eyetrackStarted ||
    !/^https?:$/.test(location.protocol) ||
    !navigator.mediaDevices
  )
    return;
  window.__eyetrackStarted = true;
  const BASE = `${location.origin}/__eyetrack`;
  const Z = '2147483647';
  const CAL_PATH = '/__eyetrack/calibrate';
  const onCalPage = location.pathname === CAL_PATH;
  const log = (m) => window.__eyetrackLog?.(m);

  let wet = null;
  let latest = null; // {r, t}: the newest result with open eyes
  let live = false;
  let calibrating = false;
  let showDot = true;
  let batch = [];
  let groups = []; // calibration and click samples, packed, in the order they were taught

  const el = (tag, style, parent) => {
    const e = document.createElement(tag);
    Object.assign(e.style, style);
    if (parent) parent.append(e);
    return e;
  };
  const labelAt = (x, y, doc = document) => {
    const hit = doc.elementFromPoint(x, y);
    if (!hit || hit.closest('[data-eyetrack]')) return null;
    const near =
      hit.closest(
        'a,button,[role=button],[role=link],input,textarea,select,label,h1,h2,h3,h4,img,video',
      ) || hit;
    const text = (
      near.getAttribute('aria-label') ||
      near.getAttribute('alt') ||
      near.innerText ||
      near.value ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return `${near.tagName.toLowerCase()}${text ? ` “${text}”` : ''}`;
  };

  const dot = el('div', {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    background: 'rgba(255,40,40,.55)',
    border: '2px solid #fff',
    pointerEvents: 'none',
    zIndex: Z,
    display: 'none',
  });
  dot.id = '__eyetrack-dot';
  dot.dataset.eyetrack = '';
  // Where no calibration dot ever is, or the preview hides it: between the dot columns at 30%
  // and 50% above every row on a desktop; on a phone, centred in the free band below the top row.
  const narrow = innerWidth < 700;
  const video = el('video', {
    position: 'fixed',
    top: narrow ? '17%' : '8px',
    left: narrow ? 'calc(50% - 60px)' : 'calc(30% + 25px)',
    width: narrow ? '120px' : '140px',
    transform: 'scaleX(-1)',
    borderRadius: '8px',
    zIndex: Z,
    display: 'none',
    pointerEvents: 'none',
  });
  video.muted = true;
  video.playsInline = true;
  video.dataset.eyetrack = '';
  const recal = el('button', {
    position: 'fixed',
    left: '12px',
    bottom: '12px',
    zIndex: Z,
    display: 'none',
    padding: '8px 12px',
    borderRadius: '8px',
    border: '1px solid #fff',
    background: 'rgba(20,20,30,.85)',
    color: '#fff',
    font: '13px system-ui',
    cursor: 'pointer',
  });
  recal.textContent = '⟳ Recalibrate';
  recal.dataset.eyetrack = '';
  // A page that shows the site in a frame of its own (the Telegram browser) calibrates where it
  // is, afresh: the old calibration forgotten and the page reloaded, so no old dot stays learnt.
  const goCalibrate = () => {
    if (window.__eyetrackFrame) return window.__eyetrackSave(null).then(() => location.reload());
    location.href = `${location.origin}${CAL_PATH}?back=${encodeURIComponent(location.href)}`;
  };
  recal.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    goCalibrate();
  });

  const flush = () => {
    if (batch.length > 0) window.__eyetrackSamples(batch);
    batch = [];
  };
  setInterval(flush, 250);
  // The live dot fades while no fresh gaze arrives (face lost, eyes closed): paused, not frozen.
  setInterval(() => {
    if (live) dot.style.opacity = latest && performance.now() - latest.t < 400 ? '1' : '.25';
  }, 200);
  addEventListener('pagehide', flush);

  // ---- samples: an eye patch, head vector and face origin, and where on screen the eyes were
  const toNorm = (x, y) => [x / innerWidth - 0.5, y / innerHeight - 0.5];
  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000)
      s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const pack = (r, x, y) => ({
    w: r.eyePatch.width,
    h: r.eyePatch.height,
    d: b64(new Uint8Array(r.eyePatch.data.buffer)),
    head: [...r.headVector],
    origin: [...r.faceOrigin3D],
    pog: toNorm(x, y),
  });
  const unpackPatch = (s) =>
    new ImageData(
      new Uint8ClampedArray(Uint8Array.from(atob(s.d), (c) => c.charCodeAt(0)).buffer),
      s.w,
      s.h,
    );
  // Learning is the heavy step: a phone's browser that runs out of memory there kills the page
  // and reloads it, and a reload that learns the same again dies the same way. A mark held in
  // sessionStorage while learning tells the next load that the last one died there.
  const LEARNING = 'eyetrack-learning';
  const learn = (samples, what) => {
    sessionStorage.setItem(LEARNING, what);
    teach(samples);
    sessionStorage.removeItem(LEARNING);
  };
  const teach = (group) => {
    if (group.length === 0) return;
    try {
      wet.adapt(
        group.map(unpackPatch),
        group.map((s) => s.head),
        group.map((s) => s.origin),
        group.map((s) => s.pog),
      );
    } catch (err) {
      // Its screen correction needs predictions that differ; a few identical ones (a still
      // face, a frozen camera) are skipped rather than ending the calibration.
      log(`a calibration sample was not used: ${err?.message ?? err}`);
    }
  };

  // ---- every video frame
  // What the frames were, logged while calibrating: whether eyes read as closed or the face is lost.
  const frames = { open: 0, closed: 0, noFace: 0 };
  setInterval(() => {
    if (calibrating && frames.open + frames.closed + frames.noFace > 0)
      log(
        `frames in the last 5 s: ${frames.open} open, ${frames.closed} eyes closed, ${frames.noFace} no face`,
      );
    frames.open = frames.closed = frames.noFace = 0;
  }, 5000);
  // Blinks, against this person's own open eye: a lid coming down reads to the gaze model as a
  // look downwards, so a frame whose eye opening drops well below the running baseline (and the
  // moment after, while the lid comes back up) moves nothing and records nothing. A fixed
  // threshold cannot do it: an eye looking down at a phone is narrow without blinking.
  const opening = (lm) => {
    const w = video.videoWidth || 1,
      h = video.videoHeight || 1;
    const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * w, (lm[a].y - lm[b].y) * h);
    const ear = (top1, bot1, top2, bot2, c1, c2) =>
      (d(top1, bot1) + d(top2, bot2)) / (2 * d(c1, c2) || 1);
    return (ear(159, 145, 158, 153, 33, 133) + ear(386, 374, 385, 380, 362, 263)) / 2;
  };
  let baseline = null;
  let blinkUntil = 0;
  const BLINK_RATIO = 0.65,
    BLINK_HOLD_MS = 150;
  const onResult = (r, t) => {
    const lm = r?.facialLandmarks;
    if (lm?.length >= 400) {
      const o = opening(lm);
      if (baseline !== null && o < BLINK_RATIO * baseline) blinkUntil = t + BLINK_HOLD_MS;
      else if (t >= blinkUntil) baseline = baseline === null ? o : 0.97 * baseline + 0.03 * o;
    }
    const blinking = t < blinkUntil;
    // No face comes back as gazeState "closed" with no landmarks: counted as no face, not as a blink.
    frames[!lm?.length ? 'noFace' : r.gazeState === 'open' && !blinking ? 'open' : 'closed'] += 1;
    if (blinking || !r?.normPog || r.gazeState !== 'open' || !r.eyePatch) return;
    latest = { r, t };
    if (!live) return;
    const x = Math.max(0, Math.min(innerWidth, (r.normPog[0] + 0.5) * innerWidth));
    const y = Math.max(0, Math.min(innerHeight, (r.normPog[1] + 0.5) * innerHeight));
    if (showDot) {
      dot.style.display = 'block';
      dot.style.transform = `translate(${x - 9}px, ${y - 9}px)`;
    }
    // Recorded on the page looked at: this one, or the site's page in the host page's frame, in
    // that page's own coordinates. A frame showing another site cannot be read: not recorded.
    let p = { x, y, win: window, vw: innerWidth, vh: innerHeight };
    const frame = window.__eyetrackFrame?.();
    if (frame) {
      const r = frame.getBoundingClientRect();
      p = {
        x: x - r.left,
        y: y - r.top,
        win: frame.contentWindow,
        vw: Math.round(r.width),
        vh: Math.round(r.height),
      };
    }
    try {
      batch.push({
        t: Date.now(),
        x: Math.round(p.x),
        y: Math.round(p.y),
        sx: Math.round(p.win.scrollX),
        sy: Math.round(p.win.scrollY),
        url: p.win.location.href,
        vw: p.vw,
        vh: p.vh,
        el: labelAt(p.x, p.y, p.win.document),
      });
    } catch {}
  };

  // Results gathered while `ms` passes, skipping the eye's travel to the target.
  const gather = (ms, skipMs = 300) =>
    new Promise((done) => {
      const out = [];
      const t0 = performance.now();
      const tick = () => {
        const now = performance.now();
        if (latest && now - latest.t < 120 && now - t0 > skipMs && out.at(-1) !== latest.r)
          out.push(latest.r);
        if (now - t0 < ms) requestAnimationFrame(tick);
        else done(out);
      };
      requestAnimationFrame(tick);
    });
  const spread = (xs, n) =>
    xs.length <= n
      ? xs
      : Array.from({ length: n }, (_, i) => xs[Math.floor(((i + 0.5) * xs.length) / n)]);

  // ---- calibration: nine dots to personalise, four to measure (with the head moving)
  const DOTS = [
    ...[
      [50, 50],
      [6, 6],
      [94, 94],
      [50, 6],
      [6, 94],
      [94, 50],
      [6, 50],
      [94, 6],
      [50, 94],
    ].map(([x, y]) => ({ x, y, kind: 'click' })),
    // two inner, two in corners: the accuracy then counts the corners too
    ...[
      [30, 30],
      [92, 8],
      [8, 92],
      [70, 70],
    ].map(([x, y]) => ({ x, y, kind: 'check' })),
  ];
  const TEXT = {
    click:
      '<b>1 / 2 · Look and click</b><br>Look at the red dot and click it. Keep looking at it until the next one appears.<br><small>Sit naturally — you may move your head.</small>',
    check:
      '<b>2 / 2 · Check</b><br>Look at the blue dot and click it. <b>Move your head</b> between dots — this measures accuracy as you really sit.',
  };
  let aim = null;

  const calibrate = async () => {
    calibrating = true;
    live = false;
    dot.style.display = 'none';
    const layer = el(
      'div',
      {
        position: 'fixed',
        inset: '0',
        background: 'rgba(15,15,20,.94)',
        zIndex: String(Number(Z) - 1),
        font: '16px system-ui',
        color: '#fff',
      },
      document.documentElement,
    );
    video.style.display = 'block';
    const status = el(
      'div',
      {
        position: 'absolute',
        top: narrow ? '54%' : '200px',
        width: '100%',
        textAlign: 'center',
        fontSize: '13px',
        opacity: '.8',
      },
      layer,
    );
    const box = el(
      'div',
      {
        position: 'absolute',
        top: narrow ? 'calc(54% + 22px)' : '235px',
        width: '100%',
        textAlign: 'center',
        lineHeight: '1.5',
        ...(narrow ? { fontSize: '14px', padding: '0 12px', boxSizing: 'border-box' } : {}),
      },
      layer,
    );
    const count = el(
      'div',
      {
        position: 'absolute',
        bottom: '18px',
        width: '100%',
        textAlign: 'center',
        fontSize: '13px',
        opacity: '.7',
      },
      layer,
    );
    const restart = el(
      'button',
      {
        position: 'fixed',
        left: '12px',
        bottom: '12px',
        zIndex: Z,
        padding: '8px 12px',
        borderRadius: '8px',
        border: '1px solid #fff',
        background: 'rgba(20,20,30,.85)',
        color: '#fff',
        font: '13px system-ui',
        cursor: 'pointer',
      },
      layer,
    );
    restart.textContent = '⟳ Restart calibration';
    restart.dataset.eyetrack = '';
    restart.dataset.restart = '';
    // A dot waits for the face: grey while it is not seen, so a tap that is not taken never
    // looks like a frozen dot.
    const face = setInterval(() => {
      const seen = latest && performance.now() - latest.t < 400;
      status.textContent = seen
        ? 'face found ✓'
        : 'face not found — sit facing the camera, light on your face (loading the model takes a few seconds)';
      status.style.color = seen ? '' : '#ffb020';
      if (aim) aim.b.style.filter = seen ? '' : 'grayscale(1) brightness(.6)';
    }, 200);

    const target = (d) =>
      new Promise((done) => {
        const b = el(
          'button',
          {
            position: 'absolute',
            left: `calc(${d.x}% - 15px)`,
            top: `calc(${d.y}% - 15px)`,
            width: '30px',
            height: '30px',
            borderRadius: '50%',
            border: '3px solid #fff',
            background: d.kind === 'click' ? 'red' : '#38f',
            cursor: 'pointer',
            transition: 'transform 1s linear',
          },
          layer,
        );
        aim = { b, done };
      });

    const progress = (await window.__eyetrackGetProgress()) ?? { done: 0, groups: [], errs: [] };
    if (progress.done > 0)
      log(`resuming calibration at dot ${progress.done + 1} of ${DOTS.length}`);
    // Learnt in two steps, not one per dot: the nine dots before the check, the four after.
    const CLICKS = DOTS.filter((d) => d.kind === 'click').length;
    if (progress.done >= CLICKS) learn(progress.groups.slice(0, CLICKS).flat(), 'calibration dots');
    for (let i = progress.done; i < DOTS.length; i++) {
      if (i === CLICKS && progress.done < CLICKS)
        learn(progress.groups.slice(0, CLICKS).flat(), 'calibration dots');
      const d = DOTS[i];
      box.innerHTML = TEXT[d.kind];
      count.textContent = `dot ${i + 1} of ${DOTS.length}`;
      const b = await target(d);
      b.style.transform = 'scale(.3)';
      const x = (d.x / 100) * innerWidth,
        y = (d.y / 100) * innerHeight;
      const got = await gather(1000);
      // The check is measured before it is taught: what the model said, not what it learned.
      if (d.kind === 'check')
        for (const r of got)
          progress.errs.push(
            Math.hypot(
              (r.normPog[0] + 0.5) * innerWidth - x,
              (r.normPog[1] + 0.5) * innerHeight - y,
            ),
          );
      const group = spread(got, narrow ? 1 : 2).map((r) => pack(r, x, y));
      progress.groups.push(group);
      progress.done = i + 1;
      await window.__eyetrackSetProgress(progress);
      log(`dot ${i + 1}/${DOTS.length} (${d.kind}) done: ${got.length} face frames`);
      b.remove();
    }
    learn(progress.groups.slice(CLICKS).flat(), 'check dots');
    groups = progress.groups;
    const errs = [...progress.errs].sort((a, b) => a - b);
    const px = Math.round(errs[Math.floor(errs.length / 2)] ?? 9999);
    await window.__eyetrackSetProgress(null);
    await window.__eyetrackSave(groups);
    box.innerHTML = `Accuracy ≈ <b>${px} px</b> ${px < 150 ? '— good' : px < 250 ? '— usable' : '— poor: press Recalibrate'}<br><small>Move your head freely. Clicking anything you are looking at sharpens tracking.<br>H hides the dot · Recalibrate (bottom-left) or C calibrates again · close the window to finish</small>`;
    window.__eyetrackCalibrated(location.origin, px);
    await new Promise((r) => setTimeout(r, 3000));
    clearInterval(face);
    video.style.display = 'none';
    layer.remove();
    calibrating = false;
  };

  // The calibration dot waiting for its click. Registered before any of the site's scripts
  // run, so this listener sees the click first and the site never gets to swallow it.
  addEventListener(
    'pointerdown',
    (e) => {
      if (!calibrating) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.target?.closest?.('[data-restart]')) {
        window.__eyetrackSetProgress(null).then(() => location.reload());
        return;
      }
      // Not before the face is seen: a dot tapped while it is not would teach nothing.
      if (!latest || performance.now() - latest.t > 400) return;
      if (!aim) return;
      const r = aim.b.getBoundingClientRect();
      if (Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) > 45)
        return;
      const { b, done } = aim;
      aim = null;
      done(b);
    },
    true,
  );
  for (const kind of ['mousedown', 'mouseup', 'click', 'pointerup']) {
    addEventListener(
      kind,
      (e) => {
        if (calibrating) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
  }

  // A click is a look: where you click is, nearly always, where you are looking.
  addEventListener(
    'pointerdown',
    (e) => {
      // Not on a phone: learning from a tap retrains on every sample there is, and a phone's
      // browser runs out of memory doing it and reloads the page.
      if (
        narrow ||
        calibrating ||
        !live ||
        e.target?.closest?.('[data-eyetrack]') ||
        !latest ||
        performance.now() - latest.t > 150
      )
        return;
      const group = [pack(latest.r, e.clientX, e.clientY)];
      learn(group, 'a click');
      groups = [...groups, group].slice(-40);
      window.__eyetrackSave(groups);
    },
    true,
  );

  addEventListener('keydown', (e) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target?.isContentEditable
    )
      return;
    if (e.key === 'h' || e.key === 'H') {
      showDot = !showDot;
      dot.style.display = showDot && live ? 'block' : 'none';
    }
    if ((e.key === 'c' || e.key === 'C') && !calibrating) goCalibrate();
  });

  const start = async () => {
    document.documentElement.append(dot, video, recal);
    log(
      `started on ${location.href} (${performance.getEntriesByType('navigation')[0]?.type ?? '?'})`,
    );
    // The UMD bundle, evaluated with a module object of its own: a page with an AMD loader
    // would otherwise swallow it.
    log('loading WebEyeTrack');
    const mod = { exports: {} };
    new Function(
      'module',
      'exports',
      'define',
      await (await fetch(`${BASE}/wet/webeyetrack.js`)).text(),
    )(mod, mod.exports, undefined);
    const WebEyeTrack = mod.exports.WebEyeTrack.default ?? mod.exports.WebEyeTrack;
    wet = new WebEyeTrack(60, 3600); // keep every calibration dot for the whole session
    log('initialising the gaze model');
    await wet.initialize();
    log('camera');
    // The page before may still be letting go of the camera: try for a few seconds.
    for (let attempt = 1; ; attempt++) {
      try {
        video.srcObject = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        });
        break;
      } catch (err) {
        if (attempt >= 8) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await video.play();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let last = -1;
    let failures = 0;
    const loop = async () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.currentTime !== last) {
        last = video.currentTime;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const t = performance.now();
        try {
          onResult(await wet.step(ctx.getImageData(0, 0, canvas.width, canvas.height), t), t);
        } catch (err) {
          if (failures++ < 3) log(`step failed: ${err?.message ?? err}`);
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    window.__eyetrackReady = true;
    log('model ready');
    const died = sessionStorage.getItem(LEARNING);
    if (died === 'a click') {
      // Only the tap's learning was lost: the calibration stands.
      sessionStorage.removeItem(LEARNING);
      log(
        'the last page died learning from a tap, most likely out of memory: the calibration is kept',
      );
    } else if (died) {
      sessionStorage.removeItem(LEARNING);
      log(
        `the last page died while learning (${died}), most likely out of memory: calibrating afresh`,
      );
      await window.__eyetrackSetProgress(null);
      await window.__eyetrackSave(null);
      if (!onCalPage) return goCalibrate();
    }

    if (onCalPage) {
      await calibrate();
      location.href = new URL(location.href).searchParams.get('back') || '/';
      return;
    }
    groups = (await window.__eyetrackLoad()) ?? [];
    if (groups.length > 0) learn(groups.flat(), 'replaying the calibration');
    else if (window.__eyetrackFrame) {
      log('no saved calibration on this device: calibrating here');
      await calibrate();
    } else {
      log('no saved calibration on this device: calibrating');
      return goCalibrate();
    }
    window.__eyetrackLive?.();
    live = true;
    // A host page (the Telegram browser) has a recalibrate button of its own, off the site.
    if (!window.__eyetrackFrame) recal.style.display = 'block';
    // A screen recording is matched to the gaze by a flash: the whole page green for half a
    // second, its time on this device's clock and where the page is in the recording.
    if (window.__eyetrackSync) {
      const flash = el(
        'div',
        { position: 'fixed', inset: '0', background: '#00ff00', zIndex: Z, pointerEvents: 'none' },
        document.documentElement,
      );
      flash.dataset.eyetrack = '';
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      window.__eyetrackSync({
        t: Date.now(),
        vw: innerWidth,
        vh: innerHeight,
        dpr: devicePixelRatio,
        url: location.href,
      });
      setTimeout(() => flash.remove(), 500);
    }
  };

  const run = () =>
    start().catch((err) => {
      log(`could not start: ${err?.stack ?? err}`);
      window.__eyetrackFailed?.(err);
    });
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', run);
  else run();
})();
