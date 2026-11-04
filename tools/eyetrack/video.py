"""Gaze on a screen recording of the phone session:
    tools/eyetrack/ptgaze/.venv/bin/python tools/eyetrack/video.py <session dir> <recording.mp4>

The phone flashes the whole page green when tracking goes live; that flash, found in the
recording, gives both the time (the phone's clock at the flash = that frame) and where the page
sits in the recording (the green rectangle = the viewport). Writes, into the session:
  gaze-video.mp4    the recording with the gaze drawn on it (dot and a half-second trail)
  video-heatmaps/   one heatmap per stretch where the screen held still, on that very frame
  video-report.md   per stretch: when, how long, and what the gaze rested on
"""
import bisect
import json
import sys
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

run, recording = Path(sys.argv[1]), sys.argv[2]
meta = json.loads((run / "screens.json").read_text())
samples = sorted((json.loads(l) for l in (run / "samples.jsonl").read_text().splitlines() if l.strip()), key=lambda s: s["t"])
syncs = meta.get("syncs") or []
if not syncs:
    sys.exit("this session has no sync flash: record a session made with the flash (the tracker going live on a page)")
times = [s["t"] for s in samples]

cap = cv2.VideoCapture(recording)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))


def green_box(frame):
    """The bounding box of the flash's pure green, if it covers much of the frame."""
    g = (frame[:, :, 1] > 200) & (frame[:, :, 0] < 90) & (frame[:, :, 2] < 90)  # BGR
    if g.mean() < 0.25:
        return None
    ys, xs = np.nonzero(g)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


# ---- the first flash: its time in the recording and the viewport's rectangle
flash = None
while True:
    ok, frame = cap.read()
    if not ok:
        break
    box = green_box(frame)
    if box:
        flash = (cap.get(cv2.CAP_PROP_POS_MSEC), box)
        break
if flash is None:
    sys.exit("no green flash found in the recording: start the screen recording before the tracker goes live on the site")
flash_ms, (x0, y0, x1, y1) = flash
sync = syncs[0]
scale = (x1 - x0) / sync["vw"]  # recording pixels per CSS pixel
print(f"flash at {flash_ms / 1000:.2f}s in the recording; page at ({x0},{y0})-({x1},{y1}), {scale:.2f} px per CSS px")
phone_ms = lambda video_ms: sync["t"] + (video_ms - flash_ms)  # noqa: E731
to_px = lambda s: (int(x0 + s["x"] * scale), int(y0 + s["y"] * scale))  # noqa: E731

# ---- the overlay video, and the stretches where the page held still
cap.set(cv2.CAP_PROP_POS_MSEC, 0)
out_scale = 0.5 if W > 1000 else 1.0
ow, oh = int(W * out_scale) // 2 * 2, int(H * out_scale) // 2 * 2
writer = cv2.VideoWriter(str(run / "gaze-video.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), fps, (ow, oh))
segments, current, prev_small = [], None, None
while True:
    ok, frame = cap.read()
    if not ok:
        break
    vms = cap.get(cv2.CAP_PROP_POS_MSEC)
    t = phone_ms(vms)
    # a new stretch when most of the page changes at once (a scroll, a new page); a video playing
    # in one card or a carousel turning changes only part of it and does not cut the stretch
    # Compared with the stretch's first frame, not the last one: a slow scroll changes little from
    # frame to frame but soon most of the page from where it began.
    small = cv2.resize(cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY), (64, 128)).astype(np.float32)
    moving = prev_small is not None and (np.abs(small - prev_small) > 25).mean() > 0.3
    if prev_small is None:
        prev_small = small
    if vms >= flash_ms + 600:  # the flash itself is not part of the session
        if moving or current is None:
            if current and current["end"] - current["start"] >= 800:
                segments.append(current)
            current = {"start": t, "end": t, "frame": frame.copy()}
            prev_small = small
        else:
            current["end"] = t
    # the gaze: the last half second as a fading trail, the newest as the dot
    i0, i1 = bisect.bisect_left(times, t - 500), bisect.bisect_right(times, t)
    trail = samples[i0:i1]
    for a, b in zip(trail, trail[1:]):
        cv2.line(frame, to_px(a), to_px(b), (255, 140, 40), max(2, int(scale)))
    if trail and t - trail[-1]["t"] < 200:
        cv2.circle(frame, to_px(trail[-1]), int(14 * scale), (40, 40, 255), -1)
        cv2.circle(frame, to_px(trail[-1]), int(14 * scale), (255, 255, 255), max(2, int(scale)))
    writer.write(cv2.resize(frame, (ow, oh)))
if current and current["end"] - current["start"] >= 800:
    segments.append(current)
writer.release()

# ---- one heatmap per still stretch, on its own frame, and what the gaze rested on
hm_dir = run / "video-heatmaps"
hm_dir.mkdir(exist_ok=True)
lines = [f"# Gaze on the recording — {meta['url']}", "",
         f"Calibration accuracy: {', '.join(f'{px} px' for px in meta.get('calibration', {}).values()) or 'unknown'} · "
         f"gaze video: [gaze-video.mp4](gaze-video.mp4)", ""]
for n, seg in enumerate(segments, 1):
    ss = samples[bisect.bisect_left(times, seg["start"]):bisect.bisect_right(times, seg["end"])]
    if len(ss) < 5:
        continue
    page = seg["frame"][y0:y1, x0:x1]
    h = np.zeros(page.shape[:2], np.float32)
    for s in ss:
        cv2.circle(h, (int(s["x"] * scale), int(s["y"] * scale)), 1, 1.0, -1)
    h = cv2.GaussianBlur(h, (0, 0), 40 * scale)
    h /= h.max() or 1
    color = cv2.applyColorMap((h * 255).astype(np.uint8), cv2.COLORMAP_JET)
    alpha = np.clip(h * 1.6, 0, 0.75)[..., None]
    img = (page * (1 - alpha) + color * alpha).astype(np.uint8)
    name = f"{n:02d}.jpg"
    cv2.imwrite(str(hm_dir / name), cv2.resize(img, (int(page.shape[1] / scale), int(page.shape[0] / scale))))
    secs = (seg["end"] - seg["start"]) / 1000
    at = (seg["start"] - sync["t"] + flash_ms) / 1000
    top = Counter(s.get("el") or "(nothing)" for s in ss).most_common(5)
    lines += [f"## {n}. at {at:.1f}s in the recording, {secs:.1f}s still", "", f"![](video-heatmaps/{name})", ""]
    lines += [f"- {c * 100 // len(ss)}% · {el}" for el, c in top] + [""]
(run / "video-report.md").write_text("\n".join(lines))
print(f"{len(segments)} still stretches; wrote {run / 'gaze-video.mp4'}, {hm_dir}/ and {run / 'video-report.md'}")
