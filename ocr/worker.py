"""Stream-OCR worker: live match stats from the broadcast when the data feed is down.

Reads frames from a live stream (Twitch/YouTube via streamlink, or any direct
.m3u8 URL), OCRs the broadcast scoreboard (game clock, kills, gold per side),
and serves the latest snapshot as JSON for the app's Live tab fallback:

    GET http://<host>:8787/snapshot

Snapshot shape:
    {"source": "ocr", "captured_at": "...", "game_time_min": 24.6,
     "left": {"kills": 12, "gold_k": 45.2}, "right": {"kills": 8, "gold_k": 38.1},
     "stale": false, "age_s": 4.2}

"left" is the blue side (broadcast convention: blue on the left). The app
maps left -> blue, right -> red.

Speed is deliberately not a goal: frames are grabbed every --interval
seconds (default 20) and OCR runs on CPU. Expect ~1-2 minutes of lag behind
real time (stream delay + poll interval). That is fine for a fallback.

Usage:
    python worker.py --url https://www.twitch.tv/lolesports
    python worker.py --url <youtube-live-url> --interval 30 --port 8787
    python worker.py --calibrate --url <stream>   # save one frame + crops for inspection
    python worker.py --once --image frame.jpg     # OCR a single saved frame

Requires: ffmpeg on PATH, streamlink (pip), rapidocr-onnxruntime (pip).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from scoreboard import crop_region, load_crops, parse_frame

HERE = Path(__file__).parent
SNAPSHOT_PATH = HERE / "snapshot.json"

# A snapshot counts as fresh for this long; older -> served with stale: true.
FRESH_S = 120


def resolve_stream_url(url: str) -> str:
    """Turn a channel/page URL into a direct media URL via streamlink.

    Direct .m3u8/.mp4 URLs pass through untouched.
    """
    if url.endswith(".m3u8") or url.endswith(".mp4"):
        return url
    try:
        out = subprocess.run(
            ["streamlink", "--stream-url", url, "720p,best"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        resolved = out.stdout.strip()
        if resolved.startswith("http"):
            return resolved
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    raise RuntimeError(
        "streamlink could not resolve a media URL for %s "
        "(is streamlink installed and the stream live?)" % url
    )


def grab_frame(stream_url: str, dest: Path, timeout_s: int = 45) -> bool:
    """Grab one frame from the live edge of the stream. True on success."""
    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-i",
                stream_url,
                "-vframes",
                "1",
                "-q:v",
                "3",
                str(dest),
            ],
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
        return proc.returncode == 0 and dest.exists() and dest.stat().st_size > 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def build_snapshot(parsed: dict, captured_at: str) -> dict:
    return {
        "source": "ocr",
        "captured_at": captured_at,
        "game_time_min": parsed["game_time_min"],
        "left": parsed["left"],
        "right": parsed["right"],
        "stale": False,
        "age_s": 0.0,
    }


class SnapshotState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.snapshot: dict | None = None

    def update(self, snap: dict) -> None:
        with self.lock:
            self.snapshot = snap
            SNAPSHOT_PATH.write_text(json.dumps(snap, indent=2))

    def read(self) -> dict | None:
        with self.lock:
            if self.snapshot is None:
                return None
            snap = dict(self.snapshot)
        # Age is computed at read time so staleness is always current.
        try:
            ts = datetime.fromisoformat(snap["captured_at"])
            age = (datetime.now(timezone.utc) - ts).total_seconds()
        except (KeyError, ValueError):
            age = 1e9
        snap["age_s"] = round(age, 1)
        snap["stale"] = age > FRESH_S
        return snap


def make_handler(state: SnapshotState):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path not in ("/", "/snapshot"):
                self.send_response(404)
                self.end_headers()
                return
            snap = state.read()
            body = json.dumps(snap or {"source": "ocr", "stale": True, "error": "no snapshot yet"})
            data = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):  # keep stdout clean
            pass

    return Handler


def poll_loop(url: str, interval: float, crops_path: str | None, state: SnapshotState) -> None:
    crops = load_crops(crops_path)
    frame_path = HERE / "frame.jpg"
    while True:
        try:
            stream_url = resolve_stream_url(url)
            ok = grab_frame(stream_url, frame_path)
            if not ok:
                print("frame grab failed; keeping last snapshot", flush=True)
            else:
                parsed = parse_frame(str(frame_path), crops)
                if parsed["game_time_min"] is None:
                    print("OCR could not read the clock; keeping last snapshot", flush=True)
                else:
                    snap = build_snapshot(parsed, datetime.now(timezone.utc).isoformat())
                    state.update(snap)
                    print(
                        "snapshot: %.1f min  L %s/%s  R %s/%s"
                        % (
                            parsed["game_time_min"],
                            parsed["left"]["kills"],
                            parsed["left"]["gold_k"],
                            parsed["right"]["kills"],
                            parsed["right"]["gold_k"],
                        ),
                        flush=True,
                    )
        except Exception as exc:  # never let one bad poll kill the worker
            print("poll error: %s" % exc, flush=True)
        time.sleep(interval)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", help="Stream URL (Twitch/YouTube channel or live URL, or direct .m3u8)")
    ap.add_argument("--interval", type=float, default=20, help="seconds between frames (default 20)")
    ap.add_argument("--port", type=int, default=8787, help="HTTP port for /snapshot (default 8787)")
    ap.add_argument("--crops", help="JSON file overriding the default crop boxes")
    ap.add_argument("--once", action="store_true", help="OCR one frame and print the snapshot, then exit")
    ap.add_argument("--image", help="with --once/--calibrate: use this saved frame instead of grabbing one")
    ap.add_argument("--calibrate", action="store_true", help="save one frame + crops for inspection, then exit")
    args = ap.parse_args()

    crops = load_crops(args.crops)

    if args.calibrate:
        from PIL import Image

        if args.image:
            frame = Path(args.image)
        else:
            if not args.url:
                ap.error("--calibrate needs --url or --image")
            frame = HERE / "calibration_frame.jpg"
            if not grab_frame(resolve_stream_url(args.url), frame):
                print("could not grab a frame", file=sys.stderr)
                return 1
        out_dir = HERE / "calibration"
        out_dir.mkdir(exist_ok=True)
        img = Image.open(frame).convert("RGB")
        img.save(out_dir / "full.jpg")
        for name, box in crops.items():
            crop_region(img, box).save(out_dir / f"crop_{name}.jpg")
        print("saved %s (full frame + %d crops) -- open them to check the boxes" % (out_dir, len(crops)))
        print("if a box is off, copy ocr/crops.example.json to crops.json, adjust, and rerun with --crops")
        return 0

    if args.once:
        if args.image:
            parsed = parse_frame(args.image, crops)
        else:
            if not args.url:
                ap.error("--once needs --url or --image")
            frame = HERE / "frame.jpg"
            if not grab_frame(resolve_stream_url(args.url), frame):
                print("could not grab a frame", file=sys.stderr)
                return 1
            parsed = parse_frame(str(frame), crops)
        print(json.dumps(build_snapshot(parsed, datetime.now(timezone.utc).isoformat()), indent=2))
        return 0

    if not args.url:
        ap.error("--url is required (or use --once/--calibrate with --image)")

    state = SnapshotState()
    server = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(state))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print("serving /snapshot on http://localhost:%d (CORS open)" % args.port, flush=True)
    try:
        poll_loop(args.url, args.interval, args.crops, state)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
