"""Fixations, heatmaps and a what-you-looked-at report for one tracker session:
python3 tools/eyetrack/report.py <session dir>"""
import json, sys
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

DISPERSION_PX = 100  # webcam gaze is noisy: a fixation is a cluster this tight (x spread + y spread)
MIN_FIX_MS = 120

run = Path(sys.argv[1])
meta = json.loads((run / "screens.json").read_text())
screens = meta["screens"]
samples = [json.loads(l) for l in (run / "samples.jsonl").read_text().splitlines() if l.strip()]


def screen_of(s):
    """The screen a sample was taken on: the latest one begun before it, at the same place."""
    best = None
    for sc in screens:
        if sc["t"] <= s["t"]:
            best = sc
    if best and "end" in best:  # screens cut from a recording, where the page held still: by time alone
        return best["index"] if s["t"] < best["end"] else None
    if best and best["url"] == s["url"] and abs(best["sy"] - s["sy"]) <= 30 and abs(best["sx"] - s["sx"]) <= 30:
        return best["index"]
    return None  # mid-scroll or mid-navigation


def fixations(ss):
    """I-DT: grow a window while its points stay within DISPERSION_PX; keep it if it lasted MIN_FIX_MS."""
    out, i = [], 0
    while i < len(ss):
        j = i
        while j + 1 < len(ss):
            w = ss[i : j + 2]
            xs, ys = [p["x"] for p in w], [p["y"] for p in w]
            if (max(xs) - min(xs)) + (max(ys) - min(ys)) > DISPERSION_PX:
                break
            j += 1
        w = ss[i : j + 1]
        dur = w[-1]["t"] - w[0]["t"]
        if dur >= MIN_FIX_MS:
            labels = Counter(p["el"] for p in w if p.get("el"))
            out.append({"t": w[0]["t"], "ms": dur, "x": float(np.mean([p["x"] for p in w])), "y": float(np.mean([p["y"] for p in w])),
                        "el": labels.most_common(1)[0][0] if labels else None})
            i = j + 1
        else:
            i += 1
    return out


by_screen = defaultdict(list)
for s in samples:
    k = screen_of(s)
    if k is not None:
        by_screen[k].append(s)

(run / "heatmaps").mkdir(exist_ok=True)
lines = [f"# What {meta.get('who', 'you')} looked at — {meta['url']}", ""]
lines += [f"Calibration accuracy: {', '.join(f'{o} ≈ {px} px' for o, px in meta['calibration'].items()) or 'not calibrated'}", ""]
if (run / "replay.html").exists():
    lines += ["The whole session, replayed with the gaze on it: [replay.html](replay.html)", ""]
# The tasks of a Telegram study session: how each went
tasks = json.loads((run / "session.json").read_text()).get("tasks") if (run / "session.json").exists() else None
if tasks:
    lines += ["## Tasks", "", "| task | outcome | time | right page |", "|---|---|---|---|"]
    for t in tasks:
        secs = f"{(t['end'] - t['start']) / 1000:.0f} s" if t.get("end") and t.get("start") else "—"
        right = {True: "yes", False: "no", None: "—"}[t.get("reached")]
        lines.append(f"| {t['id']} | {t.get('outcome') or 'not finished'} | {secs} | {right} |")
    lines.append("")
dwell = Counter()
everything = []  # every fixation, for narrate.py and anything else that reads them
for sc in screens:
    ss = sorted(by_screen.get(sc["index"], []), key=lambda p: p["t"])
    fx = fixations(ss)
    if not fx:
        continue
    everything += [dict(f, screen=sc["index"] + 1, url=sc["url"]) for f in fx]
    shot = Image.open(run / sc["file"]).convert("RGB")
    k = shot.width / sc["vw"]
    h = np.zeros((shot.height, shot.width), np.float32)
    yy, xx = np.mgrid[0 : shot.height, 0 : shot.width]
    sigma = 50 * k
    for f in fx:
        h += f["ms"] * np.exp(-((xx - f["x"] * k) ** 2 + (yy - f["y"] * k) ** 2) / (2 * sigma**2))
    h /= h.max()
    rgba = np.zeros((*h.shape, 4), np.uint8)
    rgba[..., 0] = 255
    rgba[..., 1] = (255 * (1 - h)).astype(np.uint8)
    rgba[..., 3] = (190 * np.clip(h * 1.6, 0, 1)).astype(np.uint8)
    img = Image.alpha_composite(shot.convert("RGBA"), Image.fromarray(rgba, "RGBA"))
    d = ImageDraw.Draw(img)
    pts = [(f["x"] * k, f["y"] * k) for f in fx]
    if len(pts) > 1:
        d.line(pts, fill=(60, 120, 255), width=2)
    for n, (x, y) in enumerate(pts, 1):
        d.ellipse([x - 11, y - 11, x + 11, y + 11], fill=(30, 60, 200), outline="white", width=2)
        d.text((x - 4, y - 6), str(n), fill="white")
    dest = run / "heatmaps" / f"{sc['index'] + 1:02d}.png"
    img.convert("RGB").save(dest)
    secs = (ss[-1]["t"] - ss[0]["t"]) / 1000
    where = f"at {sc['at']}" if "at" in sc else f"scrolled {sc['sy']} px"
    lines += [f"## Screen {sc['index'] + 1} — {sc['url']} ({where})", "",
              f"{secs:.1f} s here · {len(fx)} fixations · ![](heatmaps/{dest.name})", ""]
    for n, f in enumerate(fx, 1):
        lines.append(f"{n}. **{f['ms']} ms** · {f['el'] or '(nothing)'}")
        dwell[f["el"] or "(nothing)"] += f["ms"]
    lines.append("")
    print(dest, len(fx), "fixations")

lines += ["## Where your time went", ""] + [f"- {ms / 1000:.1f} s · {el}" for el, ms in dwell.most_common(15)]
(run / "report.md").write_text("\n".join(lines))
(run / "fixations.json").write_text(json.dumps(everything, indent=1, ensure_ascii=False))
print(run / "report.md")
