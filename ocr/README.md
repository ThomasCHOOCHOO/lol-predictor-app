# Stream-OCR fallback for the Live tab

When the lolesports data feed freezes or 403s, the Live tab can fall back to
numbers read off the broadcast itself: a worker grabs frames from the live
stream, OCRs the scoreboard (game clock, kills, gold per side), and serves
the latest snapshot as JSON. The app polls it only when the data feed goes
stale for the current game.

Speed is deliberately not a goal: expect ~1–2 min of lag (stream delay +
poll interval). That is fine for a fallback.

## What it reads

- Game clock, kills, gold per side — the three inputs the live model needs.
- Towers / dragons / barons are NOT in the top bar, so the fallback reports
  them as 0 / empty. The live model only uses gold + kills anyway.
- Broadcast convention: blue side on the LEFT of the scoreboard. The app
  maps left → blue, right → red.

## Setup

Requires Python 3.10+, ffmpeg on PATH, and a machine whose network can
reach Twitch/YouTube (the sandbox VM this was built on cannot — YouTube
429s, Twitch GQL timeouts — so run it on your PC or a small VPS).

```powershell
cd lol-predictor-app\ocr
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Calibrate once (important)

The crop boxes in `scoreboard.py` are initial guesses for the standard
broadcast top bar. Before relying on it, run against a live frame:

```powershell
python worker.py --calibrate --url https://www.twitch.tv/lolesports
```

Open `calibration/full.jpg` and the `crop_*.jpg` files. Each crop should
contain exactly one number (clock, one kill count, or one gold figure).
If a box is off, copy `crops.example.json` to `crops.json`, adjust the
fractions, and rerun with `--crops crops.json`.

## Run

```powershell
python worker.py --url https://www.twitch.tv/lolesports --interval 20 --port 8787
```

Serves `GET /snapshot` with CORS open. Test it:

```powershell
curl http://localhost:8787/snapshot
```

## App config

Live tab → "Stream OCR fallback" → enter the worker URL → Save.

- Same machine as the browser: `http://localhost:8787/snapshot`
- Phone (Expo Go) + worker on your PC: `http://<PC-LAN-IP>:8787/snapshot`
  (find it with `ipconfig`; the phone and PC must share Wi-Fi)

When the data feed goes stale mid-game, the tab shows "Live stats via
stream OCR (backup — data feed stale)" and keeps updating from the worker.
When the data feed recovers, it switches back automatically.

## Limitations

- OCR misreads happen. The worker sanity-checks every field (kills 0–80,
  gold 0–200k, clock ≤ 90 min) and keeps the last-good snapshot on a bad
  read; the app ignores snapshots older than 120 s.
- Drafts, analyst desk, replays, and post-game screens have no scoreboard —
  the worker keeps the last in-game snapshot through those, marked stale.
- Stream access: YouTube/Twitch may rate-limit or block datacenter IPs.
  If `streamlink` cannot resolve a URL, try the other platform (Twitch vs
  YouTube) or a residential/cloud host.
