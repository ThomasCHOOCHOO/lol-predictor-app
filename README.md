# LoL Predictor — iPhone app (React Native + Expo)

Predicts League of Legends match winners from champion drafts, with roster-aware
team strength, patch-aware champion strength, calibrated win probabilities, and
a Kelly-criterion bet-sizing tab. **100% offline** — the trained model ships
bundled as JSON; no backend, no network calls.

## Run it on your iPhone (Windows PowerShell)

```powershell
cd C:\path\to\lol-predictor-app
npm install
npx expo start
```

1. Install **Expo Go** from the App Store on your iPhone.
2. Connect your iPhone to the **same Wi-Fi** as the PC.
3. Scan the QR code shown in the terminal with the iPhone camera (or the Expo Go app).
4. The app loads in Expo Go — no App Store, no build step.

`npm install` is only needed once. If the QR doesn't scan, make sure Windows
Firewall isn't blocking Node.js and both devices are on the same network.

## What's inside

- **Predict tab** — pick blue/red side teams (searchable, understands tags like
  `t1`, `g2`, `c9`), pre-draft or draft mode (5 picks + 5 bans per side),
  patch selector (defaults to the Worlds patch the bundle was built for).
  Each team card shows roster-adjusted Elo, raw Elo, roster Δ, turnover note
  (e.g. "2/5 starters changed 2025→2026") and the 2026 starting roster.
- **Result** — big calibrated win % per side (that percentage *is* the
  confidence figure), a calibration honesty note ("when the model said 63–67%,
  that side won 63% of 773 holdout games"), feature contributions, and a
  metrics footnote (holdout accuracy, ECE, snapshot date).
- **Kelly tab** — type the book's **decimal odds** manually, optional bankroll.
  Shows implied probability, edge, full / half / quarter-Kelly stakes, and a
  **NO BET** state when edge ≤ 0. Defaults to highlighting half-Kelly, with the
  caveat that Kelly assumes the model's p is true (it isn't — 64.5% holdout
  accuracy), so fractional Kelly is the responsible default.
- **Model tab** — model card: version, snapshot date, patches, honest metrics,
  backtests, roster formula, feature list.

## Model bundle

`src/data/phone_artifacts.json` is a copy of
`~/workspace/lol-worlds-model/model/phone_artifacts.json`. It carries:

- logistic-regression coefficients + intercept + StandardScaler params
  (`full` draft model and `nodraft` pre-draft model),
- isotonic calibration maps as plain xs/ys arrays,
- roster-adjusted team Elo + raw Elo + turnover + yearly rosters,
- **per-patch champion power tables** (`champion_power_by_patch`, 12 patches)
  + `current_patch` — draft predictions use the selected patch's table;
  champions missing from a patch table fall back to 0.5 (same as the Python CLI),
- team-champion comfort, blue-side edge, calibration table, metrics, backtests.

The app reads `model_version` / `snapshot_date` / `current_patch` from the JSON
— nothing is hardcoded. **To refresh the model** (new retrain, new patch):
re-copy `phone_artifacts.json` over `src/data/phone_artifacts.json`, restart
Expo, and re-run the parity check below.

## Parity validation (TS vs Python CLI)

`node scripts/parity_check.mjs` compiles `src/model/*.ts` and diffs the TS
inference against `scripts/parity_ref.py`, which mirrors the TS math in Python
**and** runs the real `src/predict.py::predict_game` CLI code path
(using the venv Python). The TS side uses `elo_raw` so it matches the CLI,
which predicts from raw snapshot Elo; the app itself defaults to
roster-adjusted `elo`.

Last run (model v1.2.0, patch 16.18), 5 cases — T1 vs BLG pre-draft & draft,
Gen.G vs G2 pre-draft, C9 vs KC draft, FURIA vs LØS pre-draft:

| check | max abs diff |
|---|---|
| TS vs Python reference (p_cal, p_raw, all features) | 4.4e-16 |
| Python reference vs real CLI `predict_game` | 0.0 |

Sample calibrated outputs: T1 vs BLG pre-draft 38.0% blue; with drafts 47.7%;
Gen.G vs G2 pre-draft 58.6%; C9 vs KC draft 42.1%; FURIA vs LØS pre-draft 41.0%.

## Future

- **Live sportsbook odds** (The Odds API / PandaScore) to auto-fill the Kelly
  tab — parked per 2026-10-10; Kelly uses manual decimal-odds entry for now.
