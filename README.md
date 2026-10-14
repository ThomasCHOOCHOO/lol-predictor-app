# LoL Predictor — iPhone app (React Native + Expo)

Predicts League of Legends match winners from champion drafts, with roster-aware
team strength, patch-aware champion strength, calibrated win probabilities,
a Kelly-criterion bet-sizing tab, a **Live tab** with in-game win
probability that updates from the live match feed, and an **Odds tab** that
pulls live sportsbook moneyline odds. Predictions are **fully
offline** — the trained model ships bundled as JSON; only the Live tab's match
feed and the Odds tab's odds API need internet.

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

## Web version (no PC needed)

The app also runs in a browser, auto-deployed to GitHub Pages on every push to
`main` (`.github/workflows/web.yml`):

**https://thomaschoochoo.github.io/lol-predictor-app/**

- Predictions, draft mode, Kelly, Odds and Parlay tabs work fully in the browser.
- The Odds API key is stored in the browser's `localStorage` on web (secure
  keychain on native) — set it once in the Odds tab.
- The Live tab's match feed may be blocked by browser cross-site restrictions;
  it works in Expo Go.
- iPhone install: open the URL in Safari → Share → **Add to Home Screen**.

One-time setup: repo **Settings → Pages → Source: GitHub Actions**.

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
  **NO BET** state when edge ≤ 0. The recommended fraction is **adaptive**:
  quarter Kelly on thin edges (<3%) or thin calibration evidence (bin n < 30),
  full Kelly only on large edges (≥8%) with strong evidence (n ≥ 300),
  half Kelly otherwise — each with a one-line reason. The caveat stands: Kelly
  assumes the model's p is true (it isn't — 64.5% holdout accuracy), so
  fractional Kelly is the responsible default.
  **Smart-money agreement.** When you tap a price in from the Odds tab, the
  app also carries Pinnacle's price for that side. Pinnacle is the sharp
  reference: its two-way price is de-vigged to a fair probability q, and if
  q beats your book's implied probability, Pinnacle confirms the value
  ("Pinnacle agrees") and the recommended fraction stands. If not — your
  model is the outlier vs smart money — the recommendation is halved
  (floored at quarter Kelly) with a "Pinnacle disagrees — sizing down" note.
  No Pinnacle price, or betting Pinnacle's own price, means no adjustment.
- **Live tab** 📡 — in-game win probability for live Worlds matches (see
  "Live tab" section below).
- **Odds tab** 🎲 — live sportsbook moneyline odds for LoL via The Odds API
  (see "Odds tab" section below). Tap any price to carry it into the Kelly tab
  with the model's probability for that side.
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
- **live in-game models** (`live_models`, v1.3+): per-bucket (t=10/15/20/25)
  logistic regressions on `[pre_logit, golddiff_k, killdiff]` (no scaler —
  raw features) + isotonic calibration maps. Used by the Live tab.

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

Live-bucket parity (`/tmp/live_parity_check.mjs`, 4 sample game states × 4
buckets vs the Python `IsotonicCalibrated` wrappers): max abs diff **0.00e+0**.

## Live tab

Win probability that updates mid-game from live game state. The **only** part
of the app that needs internet.

**Data source.** The unofficial LoL Esports API — the same feed lolesports.com
uses. Free, no signup, public key:
- Match discovery: `GET https://esports-api.lolesports.com/persisted/gw/getLive?hl=en-US`
  with header `x-api-key: 0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z`
- Game details: `GET …/getEventDetails?hl=en-US&id={matchId}` → pick the
  `inProgress` game
- Live frames: `GET https://feed.lolesports.com/livestats/v1/window/{gameId}`
  (no key needed), polled every 12s

**How it works.** The tab lists in-progress matches; tap one to watch. Each
poll takes the latest `in_game` frame: gold diff (k) and kill diff feed the
t=10/15/20/25 bucket model matching elapsed game minutes, combined with the
pre-game prediction as the prior (logit). If you ran a **draft-adjusted**
prediction for the same matchup on the Predict tab, that probability is used
as the prior instead (noted as "using draft-adjusted prior") — the draft is
real information the pre-game model doesn't have. Under 10 minutes, or if the
feed fails, it falls back to the pre-game probability. Dragons/towers/barons
are displayed from the frame (they're not model features — objectives have no
at-t training data; gold diff already prices most objective value).

**Quirks handled.** The window endpoint only retains recent frames (~10s
cadence) — no historical replay, so the tab must be opened while the game is
live. Feed team sides are matched to model teams via `team_aliases`, with a
manual **Swap sides** button as fallback. Polling stops when the game ends.
Unofficial API: Riot can change or rate-limit it; the tab degrades to the
pre-game model on any failure.

**Testing.** Needs a live game — best verified during a scheduled Worlds 2026
match (Play-In Oct 16–19, Swiss from Oct 24). Open the Live tab during a game:
the match should appear in the list, the win % should move as gold/kills
change, and the bucket label (t=10/15/20/25) should advance with game time.
Offline check: `npx tsc --noEmit` and the live parity script above.

## Odds tab

Live sportsbook odds via [The Odds API](https://the-odds-api.com) (`esports_lol`,
moneyline, decimal). **Manual refresh only** — never auto-polls.

Setup: sign up free at the-odds-api.com, paste the key into the Odds tab. The
key is stored in the device keychain (`expo-secure-store`) — never logged, never
uploaded.

Quota guidance: the free tier gives **500 requests/month**; the app shows
`X-Requests-Remaining` after every fetch. One refresh pulls all upcoming
matches in a single request. During Worlds, refreshing a few times a day costs
well under 100/month — avoid hammering the button.

Features: per-bookmaker decimal odds per match with the best price per side
highlighted; a "My books" multi-select filter (persisted) so you only see the
books you have accounts with; tapping a price runs the model matchup for those
two teams and hands the price + model probability to the Kelly tab, which then
sizes it with the adaptive fraction. Teams the model doesn't know show their
odds with the Kelly handoff disabled and a note.

**Arbitrage**: each match takes the best price per side *across* your selected
books (legs may sit at different books). If `1/bestA + 1/bestB < 1`, the match
gets an **ARB** badge with the guaranteed profit %. Tapping it opens an arb
panel: best price + book per side, profit %, and a stake splitter — enter a
total stake and it shows the exact stake per side per book so the payout is
identical either way. Place each leg at the book shown. Caveat: arb windows
close in seconds and books may void palpable-error lines — confirm both legs
are placed before counting the profit.

## Parlay tab

Ranks 2-leg and 3-leg parlay combinations by **expected value per $1 staked, net
of the books' compounded holds** (EV = P × D − 1, where P is the product of
model win probabilities and D the product of decimal odds — the compounded
margin lives inside D).

Legs come from two places: **add from cached odds** (best price per side from
your last Odds-tab refresh, one tap per side) or **manual entry** (team names
mapped through the model's aliases, model probability computed on the spot,
your book + decimal odds). Totals legs (over/under maps) can be added manually
for same-match structural analysis.

Rules the engine enforces:
- **A parlay is one ticket at one book** — combos only mix legs from the same
  book. Cross-book "parlays" can't be placed, so they aren't ranked.
- Legs must be moneylines from **different matches** (independence assumption)
  with model p ≥ 5%. Totals legs never enter auto-combos.
- Each combo shows EV, edge, and a Kelly stake (full-Kelly f* scaled by the
  existing adaptive fraction rule; bankroll carries over from the Kelly tab).
  EV > 0 combos are flagged **VALUE**; negative-EV ones are labeled **cover**
  (camouflage bets — no Kelly stake, since Kelly says bet nothing).
- **Same-match legs get structural notes, never numbers**: the model has no
  map-total distribution, so it won't fake a joint probability. Favorite ML +
  over maps (or underdog ML + under) are negatively correlated → the book's
  independent pricing likely overpays (structural value, unquantified);
  favorite + under (or underdog + over) are positively correlated → the book
  underpays → avoid. Favorite = lower decimal odds of the two sides.

## Future

- Live in-play odds (The Odds API's live markets) for the Odds tab.
