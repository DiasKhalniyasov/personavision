"""A narrated replay: Muse Spark watches a session's screen video (the gaze dot on it) and writes,
for every fixation, what the person saw there and what went through their head, in their voice:
    set -a; . ~/.config/personavision/.env; set +a
    tools/eyetrack/ptgaze/.venv/bin/python tools/eyetrack/narrate.py <session dir>
Needs what a Telegram session's report leaves: screen.mp4, fixations.json, rrweb.jsonl,
session.json. A session with tasks is narrated task by task (each task's stretch of the video);
one without, as a whole. Writes into the session:
  narration.json   per task: the task, a summary, and every fixation with saw / thought / kind
  narration.md     the same, to read
  narrated.mp4     the video with the thoughts written under it
Real people's sessions go to muse-spark-1.3, the standard mode: in contributor mode Meta may train
on what it is sent (docs/meta-model-api.md)."""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.error
import urllib.request
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

MODEL = "muse-spark-1.3"
PRICE = {"input": 1.25, "cached": 0.15, "output": 4.25}  # USD per million tokens (packages/provider/src/meta-pricing.ts)
ENDPOINT = "https://api.meta.ai/v1/responses"
KINDS = ["search", "read", "check", "distracted", "glance"]

run = Path(sys.argv[1])
session = json.loads((run / "session.json").read_text())
fixations = json.loads((run / "fixations.json").read_text())
events = sorted((json.loads(l) for l in (run / "rrweb.jsonl").read_text().splitlines() if l.strip()), key=lambda e: e["timestamp"])
t0 = events[0]["timestamp"]  # the video's first frame: the recording's start (render.mjs)
tasks_file = Path(__file__).parent / "telegram" / "tasks.json"
task_text = {t["id"]: t["text"]["en"] for t in json.loads(tasks_file.read_text())} if tasks_file.exists() else {}
clock = lambda s: f"{int(s // 60)}:{s % 60:04.1f}"  # noqa: E731


def actions(a, b):
    """What the person did between a and b (phone clock): pages opened, taps, scrolls."""
    out, last_y, scroll = [], {}, None
    for e in events:
        d = e.get("data") or {}
        if e["type"] == 3 and d.get("source") == 3:  # a scroll, of the page or of anything in it
            dy = d["y"] - last_y.get(d["id"], 0)
            last_y[d["id"]] = d["y"]
            if a <= e["timestamp"] <= b and dy:
                if scroll and scroll["id"] == d["id"] and e["timestamp"] - scroll["end"] < 700:
                    scroll.update(end=e["timestamp"], dy=scroll["dy"] + dy)
                else:
                    scroll = {"id": d["id"], "t": e["timestamp"], "end": e["timestamp"], "dy": dy}
                    out.append(scroll)
            continue
        if not a <= e["timestamp"] <= b:
            continue
        if e["type"] == 4:
            out.append({"t": e["timestamp"], "page": d.get("href")})
        elif e["type"] == 3 and d.get("source") == 2 and d.get("type") == 2 and "x" in d:
            out.append({"t": e["timestamp"], "tap": (round(d["x"]), round(d["y"]))})
    return [(x["t"], f"page opened: {x['page']}" if "page" in x else f"tap at x={x['tap'][0]} y={x['tap'][1]}" if "tap" in x
             else f"scrolled {'down' if x['dy'] > 0 else 'up'} {abs(x['dy'])} px") for x in out]


def who():
    p = session.get("profile")
    if not p:
        return "not given"
    bits = [f"{p['age']} years old" if p.get("age") else None, p.get("gender"), f"native language {p['language']}" if p.get("language") else None,
            f"does: {p['occupation']}" if p.get("occupation") else None, f"hobbies: {p['hobbies']}" if p.get("hobbies") else None,
            f"daily apps: {p['apps']}" if p.get("apps") else None, f"{p['phone_hours']} h a day on the phone" if p.get("phone_hours") else None]
    return "; ".join(b for b in bits if b)


INSTRUCTIONS = f"""You narrate the inner monologue of a real person in a screen recording from an eye-tracking study.

The video is their phone screen while they used {session['url']}. The red dot with a short blue trail is where a webcam eye tracker estimated their gaze. It is noisy: the true spot can be about {session.get('calibration') or 150} px away, so use the element named for each fixation and common sense about what a person would look at to decide what they were really looking at. A ring is a tap.

You get every fixation (a moment the eyes rested): its time in the video, how long it lasted, where it was (x, y in pixels of the video frame) and the page element under it (from the page's code; it can be a big container when the gaze falls between things). You also get their taps and scrolls.

For EACH fixation write, in the person's voice — first person, present tense, plain spoken English, short — like "I see a light-green Continue button", "a woman is dancing on the left, looks fun", "I'll scroll a little to find where Supercomputer is":
- "saw": what is at that spot at that moment, concretely (its text, colour, what a picture shows). Only what is really in the video.
- "thought": what goes through their head, at most 20 words, consistent with their task, with what they do next (taps, scrolls) and with what they look at next. A glance under about 200 ms gets a very short thought or "—".
- "kind": one of {', '.join(KINDS)} — scanning for the target, reading text, checking a candidate, pulled away by something off-task, or a glance that takes nothing in.
Use the profile only to make the voice plausible (words, what would catch their interest). Never invent opinions or UI the video does not support. If the dot sits on nothing meaningful (an edge, a background), name what is nearest and say it may be tracker error.

Also write "summary": two or three sentences on how they went about it: their strategy, what distracted them, where they hesitated, whether they found it.

Reply with one JSON object only: {{"looks": [{{"i": 1, "saw": "...", "thought": "...", "kind": "search"}}, ...], "summary": "..."}} — one entry per fixation, in order, with the same i."""


def ask(text, video):
    body = json.dumps({
        "model": MODEL,
        "input": [
            {"role": "developer", "content": [{"type": "input_text", "text": INSTRUCTIONS}]},
            {"role": "user", "content": [{"type": "input_text", "text": text},
                                         {"type": "input_video", "video_url": "data:video/mp4;base64," + base64.b64encode(video).decode()}]},
        ],
        "max_output_tokens": 24000,
    }).encode()
    key = os.environ.get("MODEL_API_KEY", "").strip()
    if not key:
        sys.exit("MODEL_API_KEY is not in the environment: set -a; . ~/.config/personavision/.env; set +a")
    for attempt in range(4):
        req = urllib.request.Request(ENDPOINT, body, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:500]
            if err.code in (429, 500, 502, 503, 504) and attempt < 3:  # the API answers 503 now and then
                print(f"  {err.code}, trying again: {detail[:120]}")
                time.sleep(5 * (attempt + 1))
                continue
            sys.exit(f"the model API answered {err.code}: {detail}")


def reply_json(resp):
    texts = [p["text"] for o in resp.get("output", []) if o.get("type") == "message" for p in o.get("content", []) if p.get("type") == "output_text"]
    raw = "".join(texts).strip()
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw)
    if resp.get("status") != "completed":
        print(f"  the response came back {resp.get('status')}: {resp.get('incomplete_details')}")
    return json.loads(raw[raw.find("{"): raw.rfind("}") + 1])


# ---- the stretches to narrate: each task, or the whole session
segments = []
for t in session.get("tasks") or []:
    if t.get("start"):
        end = t.get("end") or max(f["t"] + f["ms"] for f in fixations)
        segments.append({"task": t["id"], "text": task_text.get(t["id"], t["id"]), "outcome": t.get("outcome"), "reached": t.get("reached"), "a": t["start"], "b": end})
if not segments:
    segments.append({"task": None, "text": "no task: they browse freely", "outcome": None, "reached": None,
                     "a": min(t0, fixations[0]["t"]), "b": max(f["t"] + f["ms"] for f in fixations)})

usage = {"input": 0, "cached": 0, "output": 0}
for seg in segments:
    seg["a"] = max(seg["a"], t0)  # the video starts with the recording: gaze before it has no picture
    fx = [f for f in fixations if seg["a"] <= f["t"] < seg["b"]]
    if not fx:
        print(f"{seg['task'] or 'session'}: no fixations, skipped")
        continue
    a_s, b_s = max(0, (seg["a"] - t0) / 1000), (seg["b"] - t0) / 1000
    with tempfile.NamedTemporaryFile(suffix=".mp4") as clip:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{a_s:.2f}", "-to", f"{b_s:.2f}", "-i", str(run / "screen.mp4"),
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-an", clip.name], check=True)
        video = Path(clip.name).read_bytes()
    rel = lambda t: clock(max(0, t - seg["a"]) / 1000)  # noqa: E731
    text = "\n".join([
        f"Who they are: {who()}.",
        f"Their task: {seg['text']}" + (f" (they ended it as: {seg['outcome']}{'' if seg['reached'] is None else ', on the right page' if seg['reached'] else ', not on the page asked for'})" if seg["outcome"] else ""),
        "",
        "Fixations (i · time in this video · duration · x,y · element under the gaze):",
        *[f"{i} · {rel(f['t'])} · {f['ms']} ms · {round(f['x'])},{round(f['y'])} · {f['el'] or '(nothing)'}" for i, f in enumerate(fx, 1)],
        "",
        "What they did (time in this video):",
        *([f"{rel(t)} {what}" for t, what in actions(seg["a"], seg["b"])] or ["nothing: no taps or scrolls"]),
    ])
    print(f"{seg['task'] or 'session'}: {len(fx)} fixations, {len(video) // 1024} KB of video, asking {MODEL}…")
    resp = ask(text, video)
    u = resp.get("usage") or {}
    cached = (u.get("input_tokens_details") or {}).get("cached_tokens", 0)
    usage["input"] += u.get("input_tokens", 0) - cached
    usage["cached"] += cached
    usage["output"] += u.get("output_tokens", 0)
    out = reply_json(resp)
    said = {int(x["i"]): x for x in out.get("looks", []) if str(x.get("i", "")).isdigit()}
    if len(said) != len(fx):
        print(f"  the model described {len(said)} of {len(fx)} fixations")
    seg["summary"] = out.get("summary", "")
    seg["looks"] = [{"t": f["t"], "video_s": round((f["t"] - t0) / 1000, 2), "ms": f["ms"], "x": round(f["x"]), "y": round(f["y"]), "el": f["el"], "url": f["url"],
                     "saw": said.get(i, {}).get("saw"), "thought": said.get(i, {}).get("thought"), "kind": said.get(i, {}).get("kind")} for i, f in enumerate(fx, 1)]

cost = sum(usage[k] * PRICE[k] for k in usage) / 1e6

# ---- the session as an example for persona agents (the CLI's --gaze-examples): fixations and
# actions in time order, where on the screen as words (their screen is not this one)
screens = {s["index"] + 1: s for s in json.loads((run / "screens.json").read_text())["screens"]}


def where(f):
    sc = screens.get(f.get("screen"), {})
    w, h = sc.get("vw") or 390, sc.get("vh") or 700
    return f"{['top', 'upper middle', 'lower middle', 'bottom'][min(3, int(4 * f['y'] / h))]} {['left', 'centre', 'right'][min(2, int(3 * f['x'] / w))]}"


example = []
for seg in (s for s in segments if "looks" in s):
    outcome = {"done": "they said they found it", "gave_up": "they gave up"}.get(seg["outcome"], "")
    if seg["reached"] is not None and outcome:
        outcome += ", and were on the right page" if seg["reached"] else ", but were not on the page asked for"
    example += [f"Example — a real person: {who()}.", f"Task: {seg['text']}" + (f" ({outcome}, after {round((seg['b'] - seg['a']) / 1000)} s)." if outcome else ".")]
    rows = [(l["t"], "look", l) for l in seg["looks"]] + [(t, "act", what) for t, what in actions(seg["a"], seg["b"])]
    url = None
    for t, kind, x in sorted(rows, key=lambda r: r[0]):
        if kind == "act":
            example.append(f"  → {x}")
            continue
        if x["url"] != url:
            url = x["url"]
            example.append(f"On {url}:")
        f = next((f for f in fixations if f["t"] == x["t"]), x)
        example.append(f"  {x['ms']} ms · {x['kind']} · {where(f)}{' · on ' + x['el'] if x['el'] else ''} — saw: {x['saw']} — thought: {x['thought']}")
    example += [f"How they went about it: {seg['summary']}", ""]
(run / "gaze-example.txt").write_text("\n".join(example))
done = [s for s in segments if "looks" in s]
(run / "narration.json").write_text(json.dumps({"model": MODEL, "profile": session.get("profile"), "usage": usage, "cost_usd": round(cost, 4),
                                                 "segments": [{k: v for k, v in s.items() if k not in ("a", "b")} | {"start": s["a"], "end": s["b"]} for s in done]},
                                                indent=1, ensure_ascii=False))
md = [f"# What {session.get('who', 'they')} saw and thought — {session['url']}", "", f"Who: {who()}", f"Narrated by {MODEL} from the screen video and the gaze · ${cost:.3f}", ""]
for s in done:
    md += [f"## {s['text']}", "", f"_{s['summary']}_", ""]
    md += [f"- {clock(l['video_s'])} · {l['ms']} ms · {l['kind'] or '?'} · **saw** {l['saw']} — “{l['thought']}”" for l in s["looks"]] + [""]
(run / "narration.md").write_text("\n".join(md))

# ---- the video with the thoughts under it: one at a time, each held at least a second (a burst of
# glances would flicker past unread), at twice the size so the words are sharp
MIN_S, MAX_S = 1.0, 5.0
captions = []
for l in (l for s in done for l in s["looks"]):
    if not l["thought"] or l["thought"].strip() in ("—", "-"):
        continue
    if captions and l["video_s"] < captions[-1]["from"] + MIN_S:
        continue
    captions.append({"from": l["video_s"], **l})
for c, nxt in zip(captions, captions[1:] + [None]):
    c["to"] = min(c["from"] + MAX_S, nxt["from"] if nxt else c["from"] + MAX_S)
cap = cv2.VideoCapture(str(run / "screen.mp4"))
fps = cap.get(cv2.CAP_PROP_FPS) or 25
W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) * 2, int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) * 2
BAND = 260
fonts = Path("/System/Library/Fonts/Supplemental")
small, big = ImageFont.truetype(str(fonts / "Arial.ttf"), 22), ImageFont.truetype(str(fonts / "Arial Bold.ttf"), 30)
raw = run / "narrated-raw.mp4"
writer = cv2.VideoWriter(str(raw), cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H + BAND))
n = 0
while True:
    ok, frame = cap.read()
    if not ok:
        break
    t = n / fps
    n += 1
    img = Image.new("RGB", (W, H + BAND), (17, 17, 22))
    img.paste(Image.fromarray(cv2.cvtColor(cv2.resize(frame, (W, H)), cv2.COLOR_BGR2RGB)), (0, 0))
    c = next((c for c in captions if c["from"] <= t < c["to"]), None)
    if c:
        d = ImageDraw.Draw(img)
        d.text((24, H + 18), textwrap.shorten(f"{clock(c['video_s'])} · {c['kind']} · sees: {c['saw']}", 70), font=small, fill=(250, 204, 21))
        for k, line in enumerate(textwrap.wrap(f"“{c['thought']}”", 40)[:5]):
            d.text((24, H + 56 + k * 38), line, font=big, fill=(255, 255, 255))
    writer.write(cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR))
writer.release()
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", str(run / "narrated.mp4")], check=True)
raw.unlink()
print(f"{sum(len(s['looks']) for s in done)} fixations narrated in {len(done)} part(s) · {usage} tokens · ${cost:.3f}")
print(f"wrote {run / 'narration.json'}, {run / 'narration.md'}, {run / 'gaze-example.txt'}, {run / 'narrated.mp4'}")
