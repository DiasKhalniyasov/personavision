// node tools/eyetrack/test-model.mjs — the gaze model on a simulated head and screen.
import './gaze-model.js';
const { fit, predict } = globalThis.EyeModel;
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const PX_PER_CM = 38; // a laptop screen

// A person 55-65 cm away looks at (x, y); the head moves and turns by up to `head`, the eyes make up the rest.
const sample = (x, y, head) => {
  const tx = (rnd() - 0.5) * 12 * head,
    ty = (rnd() - 0.5) * 8 * head,
    tz = -(55 + rnd() * 10 * head);
  const yaw = (rnd() - 0.5) * 0.5 * head,
    pitch = (rnd() - 0.5) * 0.4 * head;
  const gx = Math.atan2((x - 720) / PX_PER_CM - tx, -tz),
    gy = Math.atan2((y - 450) / PX_PER_CM - ty, -tz);
  const noise = () => (rnd() - 0.5) * 0.01;
  // The iris shows the eye's angle inside the head, about 0.5 eye widths per radian.
  const f = [
    (gx - yaw) * 0.5 + noise(),
    (gy - pitch) * 0.5 + noise(),
    0.3 - (gy - pitch) * 0.1,
    yaw,
    pitch,
    0,
    tx,
    ty,
    tz,
  ];
  return { f, x, y };
};
const grid = (n, head) =>
  Array.from({ length: n }, () => sample(100 + rnd() * 1240, 80 + rnd() * 740, head));
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const err = (model, set) =>
  median(
    set.map((s) => {
      const p = predict(model, s.f);
      return Math.hypot(p.x - s.x, p.y - s.y);
    }),
  );

const moving = grid(150, 1);
const withSweep = fit(grid(400, 1));
const stillOnly = fit(grid(400, 0.05));
const a = err(withSweep, moving),
  b = err(stillOnly, moving);
console.log(
  `head moving: calibrated with head movement ${a.toFixed(0)} px, calibrated head-still ${b.toFixed(0)} px`,
);
if (!(a < 60 && b > 2 * a)) {
  console.error('FAIL');
  process.exit(1);
}
console.log('ok');
