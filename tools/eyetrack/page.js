// Runs inside every page the tracker opens, after gaze-model.js. Finds the face with MediaPipe,
// calibrates once (with the head moving, so moving it later does not break tracking), draws
// the live gaze dot, and hands gaze samples to the Node side in batches.
(() => {
  // Only real pages of a site: about:blank and file pages have no camera to ask for.
  if (
    window.top !== window ||
    window.__eyetrackStarted ||
    !/^https?:$/.test(location.protocol) ||
    !navigator.mediaDevices
  )
    return;
  window.__eyetrackStarted = true;
  const { features, fit, predict, oneEuro } = globalThis.EyeModel;
  const BASE = `${location.origin}/__eyetrack/tv`; // served by track.mjs, whatever the site
  const Z = '2147483647';

  let train = []; // [{f, x, y, cal}] — calibration samples and clicks made while browsing
  let model = null;
  let latest = null; // {f, t} of the newest frame with a face
  let live = false;
  let calibrating = false;
  let showDot = true;
  let batch = [];
  const fx = oneEuro(),
    fy = oneEuro();

  const labelAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el || el.closest('[data-eyetrack]')) return null;
    const near =
      el.closest(
        'a,button,[role=button],[role=link],input,textarea,select,label,h1,h2,h3,h4,img,video',
      ) || el;
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

  const el = (tag, style, parent) => {
    const e = document.createElement(tag);
    Object.assign(e.style, style);
    if (parent) parent.append(e);
    return e;
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
  const log = (m) => window.__eyetrackLog?.(m);
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
  // Calibration happens on a blank page of our own (track.mjs serves it under the site's
  // origin): a site that reloads or re-renders itself mid-calibration would throw it away.
  const CAL_PATH = '/__eyetrack/calibrate';
  const onCalPage = location.pathname === CAL_PATH;
  const goCalibrate = () => {
    location.href = `${location.origin}${CAL_PATH}?back=${encodeURIComponent(location.href)}`;
  };
  recal.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    goCalibrate();
  });
  const video = el('video', {
    position: 'fixed',
    // Between the dot columns at 30% and 50%, above every dot row: a preview over a dot hides it.
    top: '8px',
    left: 'calc(30% + 25px)',
    width: '140px',
    transform: 'scaleX(-1)',
    borderRadius: '8px',
    zIndex: Z,
    display: 'none',
    pointerEvents: 'none',
  });
  video.muted = true;
  video.playsInline = true;

  const flush = () => {
    if (batch.length > 0) window.__eyetrackSamples(batch);
    batch = [];
  };
  setInterval(flush, 250);
  addEventListener('pagehide', flush);

  const refit = () => {
    if (train.length >= 30) model = fit(train.map(({ f, x, y }) => ({ f, x, y })));
  };
  let saveTimer = null;
  const save = (accuracy) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => window.__eyetrackSave(train, accuracy ?? null), 1000);
  };

  // ---- the face, every video frame
  const onFrame = (res, t) => {
    const lm = res.faceLandmarks?.[0];
    const m = res.facialTransformationMatrixes?.[0]?.data;
    if (!lm || !m || lm.length < 478) {
      latest = null;
      return;
    }
    latest = { f: features(lm, m, video.videoWidth, video.videoHeight), t };
    if (!live || !model) return;
    const p = predict(model, latest.f);
    const x = Math.max(0, Math.min(innerWidth, fx(p.x, t / 1000)));
    const y = Math.max(0, Math.min(innerHeight, fy(p.y, t / 1000)));
    if (showDot) {
      dot.style.display = 'block';
      dot.style.transform = `translate(${x - 9}px, ${y - 9}px)`;
    }
    batch.push({
      t: Date.now(),
      x: Math.round(x),
      y: Math.round(y),
      sx: Math.round(scrollX),
      sy: Math.round(scrollY),
      url: location.href,
      vw: innerWidth,
      vh: innerHeight,
      el: labelAt(x, y),
    });
  };

  // Frames with a face, gathered while `ms` passes, skipping the eye's travel to the target.
  const gather = (x, y, ms, skipMs = 300) =>
    new Promise((done) => {
      const out = [];
      const t0 = performance.now();
      const tick = () => {
        const now = performance.now();
        if (
          latest &&
          now - latest.t < 60 &&
          now - t0 > skipMs &&
          (out.length === 0 || out.at(-1).f !== latest.f)
        ) {
          out.push({ f: latest.f, x, y, cal: true });
        }
        if (now - t0 < ms) requestAnimationFrame(tick);
        else done(out);
      };
      requestAnimationFrame(tick);
    });

  // ---- calibration: look-and-click, then look-and-move-your-head, then a check.
  // Every finished dot is kept by track.mjs, so a page that reloads mid-way resumes here.
  const DOTS = [
    ...[
      [50, 50],
      [10, 12],
      [90, 88],
      [50, 12],
      [10, 88],
      [90, 50],
      [10, 50],
      [90, 12],
      [50, 88],
    ].map(([x, y]) => ({ x, y, kind: 'click' })),
    ...[
      [50, 50],
      [25, 25],
      [75, 25],
      [25, 75],
      [75, 75],
    ].map(([x, y]) => ({ x, y, kind: 'move' })),
    ...[
      [30, 30],
      [70, 30],
      [30, 70],
      [70, 70],
    ].map(([x, y]) => ({ x, y, kind: 'check' })),
  ];
  const TEXT = {
    click:
      '<b>1 / 3 · Look and click</b><br>Look at the red dot and click it. Keep looking at it until the next one appears.',
    move: '<b>2 / 3 · Look and move</b><br>Click the yellow dot, then keep your eyes on it while you slowly <b>turn your head</b> left and right,<br>tilt it up and down, and lean closer and further — for 5 seconds.',
    check:
      '<b>3 / 3 · Check</b><br>Look at the blue dot and click it. Move your head however you like.',
  };
  const COLOUR = { click: 'red', move: 'gold', check: '#38f' };

  const calibrate = async () => {
    calibrating = true;
    live = false;
    recal.style.display = 'none';
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
        top: '200px',
        width: '100%',
        textAlign: 'center',
        fontSize: '13px',
        opacity: '.8',
      },
      layer,
    );
    const box = el(
      'div',
      { position: 'absolute', top: '235px', width: '100%', textAlign: 'center', lineHeight: '1.5' },
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
    const face = setInterval(() => {
      status.textContent =
        latest && performance.now() - latest.t < 300
          ? 'face found ✓'
          : 'face not found — sit facing the camera, light on your face';
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
            background: COLOUR[d.kind],
            cursor: 'pointer',
            transition: `transform ${d.kind === 'move' ? 5 : 1}s linear`,
          },
          layer,
        );
        aim = { b, done };
      });
    const at = (d) => [(d.x / 100) * innerWidth, (d.y / 100) * innerHeight];

    const progress = (await window.__eyetrackGetProgress()) ?? { done: 0, fresh: [], errs: [] };
    if (progress.done > 0)
      log(`resuming calibration at dot ${progress.done + 1} of ${DOTS.length}`);
    const fitFresh = () => {
      train = [...progress.fresh, ...train.filter((s) => !s.cal)];
      refit();
    };
    if (progress.done > 14) fitFresh();
    for (let i = progress.done; i < DOTS.length; i++) {
      const d = DOTS[i];
      if (i === 14) fitFresh(); // the check measures the model the first two steps made
      box.innerHTML = TEXT[d.kind];
      count.textContent = `dot ${i + 1} of ${DOTS.length}`;
      const b = await target(d);
      b.style.transform = 'scale(.3)';
      const got = await gather(
        ...at(d),
        d.kind === 'move' ? 5000 : 1000,
        d.kind === 'move' ? 200 : 300,
      );
      if (d.kind === 'check' && model) {
        for (const s of got) {
          const p = predict(model, s.f);
          progress.errs.push(Math.hypot(p.x - s.x, p.y - s.y));
        }
      }
      progress.fresh.push(...got);
      progress.done = i + 1;
      await window.__eyetrackSetProgress(progress);
      log(`dot ${i + 1}/${DOTS.length} (${d.kind}) done: ${got.length} face frames`);
      b.remove();
    }
    fitFresh();
    const errs = [...progress.errs].sort((a, b) => a - b);
    const px = Math.round(errs[Math.floor(errs.length / 2)] ?? 9999);
    await window.__eyetrackSetProgress(null);
    save(px);
    box.innerHTML = `Accuracy ≈ <b>${px} px</b> ${px < 120 ? '— good' : px < 220 ? '— usable' : '— poor: press Recalibrate'}<br><small>Move your head freely. Clicking anything you are looking at sharpens tracking.<br>H hides the dot · Recalibrate (bottom-left) or C calibrates again · close the window to finish</small>`;
    window.__eyetrackCalibrated(location.origin, px);
    await new Promise((r) => setTimeout(r, 3000));
    clearInterval(face);
    video.style.display = 'none';
    layer.remove();
    recal.style.display = 'block';
    calibrating = false;
    live = true;
  };

  // The calibration dot waiting for its click. Registered before any of the site's scripts
  // run, so this listener sees the click first and the site never gets to swallow it.
  let aim = null;
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
      if (
        calibrating ||
        e.target?.closest?.('[data-eyetrack]') ||
        !latest ||
        performance.now() - latest.t > 100
      )
        return;
      train.push({ f: latest.f, x: e.clientX, y: e.clientY, cal: false });
      const browsing = train.filter((s) => !s.cal);
      if (browsing.length > 400) train.splice(train.indexOf(browsing[0]), 1);
      refit();
      save();
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
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
    });
    await video.play();
    const { FilesetResolver, FaceLandmarker } = await import(`${BASE}/vision_bundle.mjs`);
    const landmarker = await FaceLandmarker.createFromOptions(
      await FilesetResolver.forVisionTasks(`${BASE}/wasm`),
      {
        baseOptions: { modelAssetPath: `${BASE}/face_landmarker.task`, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFacialTransformationMatrixes: true,
      },
    );
    let last = -1;
    const loop = () => {
      if (video.readyState >= 2 && video.currentTime !== last) {
        last = video.currentTime;
        const t = performance.now();
        onFrame(landmarker.detectForVideo(video, t), t);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    window.__eyetrackReady = true;

    train = (await window.__eyetrackLoad()) ?? [];
    refit();
    if (onCalPage) {
      await calibrate();
      location.href = new URL(location.href).searchParams.get('back') || '/';
    } else if (model) {
      live = true;
      recal.style.display = 'block';
    } else goCalibrate();
  };

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start);
  else start();
})();
