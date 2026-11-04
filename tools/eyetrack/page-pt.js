// The ptgaze engine's page side: track.mjs runs ptgaze/gaze_server.py, which owns the camera and
// sends, per frame, where the 3D gaze ray meets the screen plane (metres, head movement already
// in it). This page maps that point to pixels with an affine fit from calibration dots, draws
// the live dot and records gaze. Runs after gaze-model.js (for the One Euro filter).
(() => {
  if (window.top !== window || window.__eyetrackStarted || !/^https?:$/.test(location.protocol))
    return;
  window.__eyetrackStarted = true;
  const { oneEuro } = globalThis.EyeModel;
  const Z = '2147483647';
  const CAL_PATH = '/__eyetrack/calibrate';
  const onCalPage = location.pathname === CAL_PATH;
  const log = (m) => window.__eyetrackLog?.(m);

  // A frame, as where the face is (o, metres) and how far the gaze ray runs across the screen
  // plane from it (q): the ray meets the plane at o - q. How far is a guess built on the
  // camera's assumed field of view, so the fit learns a scale for it, lambda: the plane point
  // is o - lambda * q. Head movement is what tells lambda apart, so moving the head between the
  // check dots is what makes the dot hold still when the head moves afterwards.
  const lift = (s) => ({
    ox: s.head[0],
    oy: s.head[1],
    qx: s.head[0] - s.px,
    qy: s.head[1] - s.py,
  });
  let latest = null; // lift(frame) and t: the newest frame with a face
  let map = null; // {lambda, ax: [a, b, c], ay: [d, e, f]}: pixels = a*X + b*Y + c
  let points = []; // [{ox, oy, qx, qy, x, y}] the fit was made from
  let live = false;
  let calibrating = false;
  let showDot = true;
  let batch = [];
  const fx = oneEuro(),
    fy = oneEuro();

  const el = (tag, style, parent) => {
    const e = document.createElement(tag);
    Object.assign(e.style, style);
    if (parent) parent.append(e);
    return e;
  };
  const labelAt = (x, y) => {
    const hit = document.elementFromPoint(x, y);
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
  // The browser owns the camera (it has the permission; the Python process has none of its own)
  // and hands each frame to the gaze server through track.mjs.
  const video = el('video', {
    position: 'fixed',
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
  video.dataset.eyetrack = '';
  const startCamera = async () => {
    // The page before may still be letting go of the camera: try for a few seconds.
    for (let attempt = 1; ; attempt++) {
      try {
        // The built-in camera by name: the default can be an iPhone (Continuity Camera) that
        // is not there, which fails as "Requested device not found".
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === 'videoinput',
        );
        const cam = cams.find((d) => /macbook|facetime|built-in/i.test(d.label)) ?? cams[0];
        if (attempt === 1)
          log(
            `cameras: ${cams.map((d) => d.label || '(unnamed)').join(', ')}; using ${cam?.label || 'the default'}`,
          );
        video.srcObject = await navigator.mediaDevices.getUserMedia({
          video: {
            ...(cam?.deviceId ? { deviceId: { exact: cam.deviceId } } : { facingMode: 'user' }),
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        break;
      } catch (err) {
        if (attempt >= 8) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await video.play();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const asBase64 = (blob) =>
      new Promise((done) => {
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result).split(',')[1]);
        reader.readAsDataURL(blob);
      });
    const pump = async () => {
      try {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          canvas.width = 960;
          canvas.height = Math.round((960 * video.videoHeight) / video.videoWidth);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
          if (blob) await window.__eyetrackFrame(await asBase64(blob));
        }
      } catch (err) {
        log(`frame not sent: ${err?.message ?? err}`);
      }
      setTimeout(pump, 25);
    };
    pump();
  };
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
  const goCalibrate = () => {
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

  // ---- the screen-plane point to pixels: least squares for x and for y, three terms each
  const solve3 = (A, b) => {
    const det = (m) =>
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const d = det(A);
    return [0, 1, 2].map(
      (c) => det(A.map((row, r) => row.map((v, k) => (k === c ? b[r] : v)))) / d,
    );
  };
  const plane = (p, lambda) => [p.ox - lambda * p.qx, p.oy - lambda * p.qy];
  const affine = (pts, lambda) => {
    const rows = pts.map((p) => [...plane(p, lambda), 1]);
    const AtA = [0, 1, 2].map((i) =>
      [0, 1, 2].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0)),
    );
    const Atb = (key) => [0, 1, 2].map((i) => rows.reduce((s, r, n) => s + r[i] * pts[n][key], 0));
    return { lambda, ax: solve3(AtA, Atb('x')), ay: solve3(AtA, Atb('y')) };
  };
  const toPx = (m, p) => {
    const [X, Y] = plane(p, m.lambda);
    return [m.ax[0] * X + m.ax[1] * Y + m.ax[2], m.ay[0] * X + m.ay[1] * Y + m.ay[2]];
  };
  // The lambda whose affine fit lands the dots best. With the head still, every lambda fits
  // alike, and the small pull towards 1 keeps the camera's own geometry.
  const fit = (pts) => {
    let best = null;
    for (let lambda = 0.3; lambda <= 3.0001; lambda += 0.05) {
      const m = affine(pts, lambda);
      const sse =
        pts.reduce((e, p) => {
          const [x, y] = toPx(m, p);
          return e + (x - p.x) ** 2 + (y - p.y) ** 2;
        }, 0) / pts.length;
      const score = sse + 400 * (lambda - 1) ** 2;
      if (!best || score < best.score) best = { score, m };
    }
    return best.m;
  };

  // ---- every frame, pushed in by track.mjs
  window.__eyetrackRaw = (s) => {
    if (!s.ok) return;
    latest = { ...lift(s), t: performance.now() };
    if (!live || !map) return;
    const [rx, ry] = toPx(map, latest);
    const now = performance.now() / 1000;
    const x = Math.max(0, Math.min(innerWidth, fx(rx, now)));
    const y = Math.max(0, Math.min(innerHeight, fy(ry, now)));
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

  // Frames gathered while `ms` passes, skipping the eye's travel to the target.
  const gather = (ms, skipMs = 300) =>
    new Promise((done) => {
      const out = [];
      const t0 = performance.now();
      const tick = () => {
        const now = performance.now();
        if (latest && now - latest.t < 120 && now - t0 > skipMs && out.at(-1) !== latest)
          out.push(latest);
        if (now - t0 < ms) requestAnimationFrame(tick);
        else done(out);
      };
      requestAnimationFrame(tick);
    });
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  // ---- calibration: nine dots sitting naturally, then four that measure with the head moving
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
      [30, 30],
      [70, 30],
      [30, 70],
      [70, 70],
    ].map(([x, y]) => ({ x, y, kind: 'check' })),
  ];
  const TEXT = {
    click:
      '<b>1 / 2 · Look and click</b><br>Look at the red dot and click it. Keep looking at it until the next one appears.<br><small>Sit naturally.</small>',
    check:
      '<b>2 / 2 · Check</b><br>Look at the blue dot and click it. <b>Move your head</b> between dots — this measures accuracy as you really sit.',
  };
  let aim = null;

  const calibrate = async () => {
    calibrating = true;
    live = false;
    dot.style.display = 'none';
    video.style.display = 'block';
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
    // A dot waits for the face: grey while it is not seen, so a tap that is not taken never
    // looks like a frozen dot.
    const face = setInterval(() => {
      const seen = latest && performance.now() - latest.t < 400;
      status.textContent = seen
        ? 'face found ✓'
        : 'face not found — sit facing the camera, light on your face';
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

    const progress = (await window.__eyetrackGetProgress()) ?? { done: 0, points: [], errs: [] };
    if (progress.done > 0)
      log(`resuming calibration at dot ${progress.done + 1} of ${DOTS.length}`);
    for (let i = progress.done; i < DOTS.length; i++) {
      const d = DOTS[i];
      box.innerHTML = TEXT[d.kind];
      count.textContent = `dot ${i + 1} of ${DOTS.length}`;
      const b = await target(d);
      b.style.transform = 'scale(.3)';
      const x = (d.x / 100) * innerWidth,
        y = (d.y / 100) * innerHeight;
      const got = await gather(1000);
      if (d.kind === 'check' && got.length > 0) {
        // Measured with the fit the dots so far made, before this dot joins it.
        const m = fit(progress.points);
        for (const s of got) {
          const [px, py] = toPx(m, s);
          progress.errs.push(Math.hypot(px - x, py - y));
        }
      }
      if (got.length > 0)
        progress.points.push({
          ox: median(got.map((s) => s.ox)),
          oy: median(got.map((s) => s.oy)),
          qx: median(got.map((s) => s.qx)),
          qy: median(got.map((s) => s.qy)),
          x,
          y,
        });
      progress.done = i + 1;
      await window.__eyetrackSetProgress(progress);
      log(`dot ${i + 1}/${DOTS.length} (${d.kind}) done: ${got.length} face frames`);
      b.remove();
    }
    points = progress.points;
    map = fit(points);
    log(`head-to-gaze scale learned: ${map.lambda.toFixed(2)} (1 = the camera guess was right)`);
    const px = Math.round(progress.errs.length ? median(progress.errs) : 9999);
    await window.__eyetrackSetProgress(null);
    await window.__eyetrackSave({ points });
    box.innerHTML = `Accuracy ≈ <b>${px} px</b> ${px < 150 ? '— good' : px < 250 ? '— usable' : '— poor: press Recalibrate'}<br><small>Move your head freely. Clicking anything you are looking at sharpens tracking.<br>H hides the dot · Recalibrate (bottom-left) or C calibrates again · close the window to finish</small>`;
    window.__eyetrackCalibrated(location.origin, px);
    await new Promise((r) => setTimeout(r, 3000));
    clearInterval(face);
    video.style.display = 'none';
    layer.remove();
    calibrating = false;
  };

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
      // Not before the face is seen: a dot clicked while the model warms up would teach nothing.
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
      if (
        calibrating ||
        !live ||
        e.target?.closest?.('[data-eyetrack]') ||
        !latest ||
        performance.now() - latest.t > 150
      )
        return;
      points = [
        ...points,
        { ox: latest.ox, oy: latest.oy, qx: latest.qx, qy: latest.qy, x: e.clientX, y: e.clientY },
      ].slice(-60);
      map = fit(points);
      window.__eyetrackSave({ points });
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
    await startCamera();
    log(`started on ${location.href}`);
    window.__eyetrackReady = true;
    if (onCalPage) {
      await calibrate();
      location.href = new URL(location.href).searchParams.get('back') || '/';
      return;
    }
    points = (await window.__eyetrackLoad())?.points ?? [];
    if (points.length < 3) return goCalibrate();
    map = fit(points);
    live = true;
    recal.style.display = 'block';
  };
  const run = () => start().catch((err) => log(`could not start: ${err?.stack ?? err}`));
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', run);
  else run();
})();
