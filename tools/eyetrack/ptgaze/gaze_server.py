"""Webcam gaze with the head free to move.

ptgaze (MIT; ETH-XGaze ResNet-18) finds the face, normalises it and predicts a 3D gaze ray that
starts at the face and points in camera coordinates, so the head's position and turn are part
of the ray. This prints, one JSON line per frame, where that ray meets the camera's own plane,
which is (nearly) the screen's: a head that moves moves the ray's start, and the point stays
where the eyes are looking. The page maps the point to pixels with a calibration fit.

    .venv/bin/python gaze_server.py [--camera 0] [--video file] [--fov 70]
"""
import argparse
import json
import math
import pathlib
import sys
import tempfile
import time

import cv2
import numpy as np
import torch
from ptgaze.gaze_estimator import GazeEstimator
from ptgaze.main import _load_config_file
from ptgaze.utils import download_ethxgaze_model, download_mediapipe_face_landmarker, expanduser_all

parser = argparse.ArgumentParser()
parser.add_argument("--camera", type=int, default=0)
parser.add_argument("--video", help="a video file instead of the camera (for testing)")
parser.add_argument("--stdin", action="store_true",
                    help="frames from stdin, each a 4-byte big-endian length and a JPEG: the browser's camera, "
                         "which needs no camera permission of this process's own")
parser.add_argument("--fov", type=float, default=70.0, help="the camera's horizontal field of view in degrees")
args = parser.parse_args()

class StdinFrames:
    """The VideoCapture calls this script makes, over JPEGs arriving on stdin."""

    def read(self):
        head = sys.stdin.buffer.read(4)
        if len(head) < 4:
            sys.exit(0)  # the tracker closed the pipe: it is finished
        data = sys.stdin.buffer.read(int.from_bytes(head, "big"))
        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        return frame is not None, frame


if args.stdin:
    cap = StdinFrames()
else:
    cap = cv2.VideoCapture(args.video if args.video else args.camera)
    if not args.video:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
ok, frame = cap.read()
if not ok:
    sys.exit("no camera image: allow camera access for the terminal in System Settings > Privacy > Camera")
h, w = frame.shape[:2]

# The camera's intrinsics from its field of view: a guess, and the page's calibration fit absorbs
# what the guess gets wrong about scale.
f = w / (2 * math.tan(math.radians(args.fov) / 2))
params = pathlib.Path(tempfile.gettempdir()) / "eyetrack_camera.yaml"
params.write_text(
    f"image_width: {w}\nimage_height: {h}\n"
    f"camera_matrix:\n  rows: 3\n  cols: 3\n  data: [{f}, 0., {w / 2}, 0., {f}, {h / 2}, 0., 0., 1.]\n"
    "distortion_coefficients:\n  rows: 1\n  cols: 5\n  data: [0., 0., 0., 0., 0.]\n"
)

package = pathlib.Path(__import__("ptgaze").__file__).parent
config = _load_config_file(package / "data/configs/eth-xgaze.yaml")
config.PACKAGE_ROOT = package.as_posix()
config.gaze_estimator.checkpoint = download_ethxgaze_model().as_posix()
config.gaze_estimator.camera_params = params.as_posix()
config.device = "mps" if torch.backends.mps.is_available() else "cpu"
expanduser_all(config)
download_mediapipe_face_landmarker()
estimator = GazeEstimator(config)
print(json.dumps({"ready": True, "width": w, "height": h, "device": config.device}), flush=True)

frames, since = 0, time.time()
while True:
    if not ok:
        if args.video:  # a test video plays on a loop, as a camera would never end
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        ok, frame = cap.read()
        continue
    faces = estimator.detect_faces(frame)
    out = {"t": time.time() * 1000, "ok": False}
    if faces:
        face = max(faces, key=lambda fc: (fc.bbox[1] - fc.bbox[0]).prod())
        estimator.estimate_gaze(frame, face)
        o, g = face.center, face.gaze_vector
        # The camera looks along +z towards the person; a look at the screen runs back along -z.
        if g[2] < -1e-3:
            t = -o[2] / g[2]
            out = {"t": out["t"], "ok": True, "px": float(o[0] + t * g[0]), "py": float(o[1] + t * g[1]),
                   "head": [float(v) for v in o]}
    print(json.dumps(out), flush=True)
    frames += 1
    if time.time() - since > 5:
        print(f"{frames / (time.time() - since):.1f} fps on {config.device}", file=sys.stderr, flush=True)
        frames, since = 0, time.time()
    if args.video:  # and at the camera's pace, not as fast as the file can be read
        time.sleep(max(0.0, 1 / 15 - (time.time() * 1000 - out["t"]) / 1000))
    ok, frame = cap.read()
