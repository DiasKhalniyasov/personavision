// Gaze from face landmarks, robust to head movement: where the irises sit inside the eyes
// plus where the head points and where it is, mapped to the screen by ridge regression that
// is trained on calibration in which the head moves. Plain script: the page and Node both load it.
(function (root) {
  // MediaPipe FaceLandmarker indices. Corners are taken image-left then image-right for both
  // eyes, so a look to one side moves both irises the same way along their axis.
  const EYES = [
    { iris: 468, a: 33, b: 133, top: 159, bot: 145 },
    { iris: 473, a: 362, b: 263, top: 386, bot: 374 },
  ];

  /** Iris offset along the eye's axis and across it, and how open the eye is, all in eye widths. */
  function eye(lm, w, h, e) {
    const ax = (lm[e.b].x - lm[e.a].x) * w,
      ay = (lm[e.b].y - lm[e.a].y) * h;
    const width = Math.hypot(ax, ay) || 1;
    const ux = ax / width,
      uy = ay / width;
    const mx = ((lm[e.a].x + lm[e.b].x) / 2) * w,
      my = ((lm[e.a].y + lm[e.b].y) / 2) * h;
    const dx = lm[e.iris].x * w - mx,
      dy = lm[e.iris].y * h - my;
    const open =
      Math.hypot((lm[e.top].x - lm[e.bot].x) * w, (lm[e.top].y - lm[e.bot].y) * h) / width;
    return [(dx * ux + dy * uy) / width, (-dx * uy + dy * ux) / width, open];
  }

  /**
   * The feature vector of one frame: eye-in-head (horizontal, vertical, openness), head
   * rotation (yaw, pitch, roll) and head position (x, y, distance) from the face's
   * transformation matrix, a column-major 4x4.
   */
  function features(lm, m, w, h) {
    const [r, l] = EYES.map((e) => eye(lm, w, h, e));
    const fx = m[8],
      fy = m[9],
      fz = m[10];
    return [
      (r[0] + l[0]) / 2,
      (r[1] + l[1]) / 2,
      (r[2] + l[2]) / 2,
      Math.atan2(fx, fz),
      Math.atan2(fy, Math.hypot(fx, fz)),
      Math.atan2(m[1], m[0]),
      m[12],
      m[13],
      m[14],
    ];
  }

  /** Standardised features plus the interactions gaze needs: eye angle and head angle add up. */
  function expand(z) {
    const [h, v, , yaw, pitch] = z;
    return [1, ...z, h * h, v * v, yaw * yaw, pitch * pitch, h * yaw, v * pitch, h * v];
  }

  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) {
        const k = M[r][c] / M[c][c];
        for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
      x[r] = s / M[r][r];
    }
    return x;
  }

  /** Ridge regression from samples [{f, x, y}] to screen x and y. */
  function fit(samples, lambda = 1) {
    const d = samples[0].f.length;
    const mu = Array.from(
      { length: d },
      (_, j) => samples.reduce((s, p) => s + p.f[j], 0) / samples.length,
    );
    const sd = Array.from(
      { length: d },
      (_, j) =>
        Math.sqrt(samples.reduce((s, p) => s + (p.f[j] - mu[j]) ** 2, 0) / samples.length) || 1,
    );
    const X = samples.map((p) => expand(p.f.map((v, j) => (v - mu[j]) / sd[j])));
    const k = X[0].length;
    const XtX = Array.from({ length: k }, (_, i) =>
      Array.from(
        { length: k },
        (_, j) => X.reduce((s, row) => s + row[i] * row[j], 0) + (i === j && i > 0 ? lambda : 0),
      ),
    );
    const Xt = (ys) =>
      Array.from({ length: k }, (_, i) => X.reduce((s, row, n) => s + row[i] * ys[n], 0));
    return {
      mu,
      sd,
      wx: solve(XtX, Xt(samples.map((p) => p.x))),
      wy: solve(XtX, Xt(samples.map((p) => p.y))),
    };
  }

  function predict(model, f) {
    const x = expand(f.map((v, j) => (v - model.mu[j]) / model.sd[j]));
    const dot = (w) => w.reduce((s, wi, i) => s + wi * x[i], 0);
    return { x: dot(model.wx), y: dot(model.wy) };
  }

  /** One Euro filter: steady when the gaze rests, quick when it jumps. */
  function oneEuro(minCutoff = 0.6, beta = 0.004, dCutoff = 1) {
    let prev = null,
      dPrev = 0,
      tPrev = 0;
    const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    return (v, t) => {
      if (prev === null) {
        prev = v;
        tPrev = t;
        return v;
      }
      const dt = Math.max(1e-3, t - tPrev);
      tPrev = t;
      const d = (v - prev) / dt;
      dPrev += alpha(dCutoff, dt) * (d - dPrev);
      prev += alpha(minCutoff + beta * Math.abs(dPrev), dt) * (v - prev);
      return prev;
    };
  }

  root.EyeModel = { features, fit, predict, oneEuro };
})(globalThis);
