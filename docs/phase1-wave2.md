# Phase 1 Wave 2 — app work (calibration toggle, diagnostic flag, role-gold live)

Implemented 2026-10-17. Nothing pushed, no bets, no model-repo changes.
`src/data/phone_artifacts.json` was NOT hand-edited (standing rule) — the new
data lives in three small bundled files (see §4).

## 1. Model tab toggle: Standard (v1.3.2) ↔ Honest calibration

- **Model tab** (`src/app/info.tsx`): segmented toggle, active-model display,
  side-by-side honest metrics, plain-language note of what the toggle changes.
- **State** (`src/state/PredictionContext.tsx`): `calibrationMode` persisted
  in AsyncStorage (`calibration_mode_v1`). Default `standard` — current
  behavior preserved until flipped. Flipping **clears the current
  prediction** (it was computed under the other map) and must be re-run.
- **Plumbing**: `predictMatchup` / `seriesConversion` / `predictProba` take a
  `calibration` option; `PredictionResult.calibration` records which map a
  prediction used. Predict, Kelly, Live, Odds, and Parlay all follow the
  toggle (Odds/Parlay included so no tab silently disagrees with it).
  Kelly and Predict display which calibration the shown number used.

Side-by-side numbers (full model; pre-draft in the tab):

| Variant | Log-loss | ECE | n | Basis |
|---|---|---|---|---|
| Standard (shipped map) | 0.6253 | 0.000 | 3,368 | IN-SAMPLE — graded on its own fit games, never quality |
| Honest map | 0.6545 | 0.054 | 1,142 | Untouched Sep games |
| Raw, no calibration | 0.6488 | 0.040 | 1,142 | Same untouched Sep games |

Same story for pre-draft (honest 0.6524 / raw 0.6468). On that September
slice the raw model still beats both maps — September was a different world.
The toggle exists to answer which map wins on *future* games.

## 2. Diagnostic flag (Predict tab, display only)

When either team's |player − team Elo gap| > 100, a warning shows under the
prediction: the roster on paper is much stronger/weaker than the org's
results suggest. **It never changes the prediction** — no code path reads
the gap except the display. No gap data for a team = no flag (never a false
warning). 16 of 883 teams currently trip the flag (largest: Team Secret
+220). All 883 gap-team names match app team names exactly.

## 3. Role-gold live: variant A shadow comparison

- `src/model/live.ts`: `liveProbaA` implements variant A
  (`[pre_logit, top/jng/mid/bot/sup gold (k), killdiff]`, per-bucket coefs).
  **Shadow only** — it never feeds Kelly sizing.
- **Feed parsing**: the livestats window *does* carry per-participant gold
  (`frames[].blueTeam.participants[].totalGold`) + roles in
  `gameMetadata.*TeamMetadata.participantMetadata` (`participantId → role`).
  `fetchWindow` now returns `roleGold` (blue − red per role, k gold) from
  the latest in-game frame with complete participant data, null otherwise.
- **Live tab**: when a bucket model fires, shows
  "Variant A (role gold, shadow — uncalibrated): X% vs baseline Y%".
  When the frame lacks role data: "n/a — this frame has no per-role gold".
  OCR frames have team totals only → variant A n/a under OCR fallback.
- **Swap handling**: variant A orients role gold / killDiff to the displayed
  sides (negated when the user swaps). The baseline does NOT (pre-existing
  caveat — see §6). A-vs-baseline comparisons while swapped are not
  apples-to-apples.
- **No calibration map exists for variant A** (the research export carries
  metrics only). The shadow display shows variant A's **raw** prob, labeled
  uncalibrated. A fitted calibration map for A is a remaining item (§5).

## 4. Data files + provenance

`scripts/build_wave2_data.py` (read-only against the model repo) generates:

| App file | Source | Contents |
|---|---|---|
| `src/data/honest_calibration.json` | v1.3.2 bundle `model.joblib.bak-pre-region-offsets` + `features.csv` | Full (12 steps) + nodraft (11 steps) honest maps + eval numbers |
| `src/data/player_gaps.json` | `player_ratings.json` teams | 883 team gaps |
| `src/data/live_models_role_gold.json` | `live_models_role_gold.json` `variants.A_roles` | Per-bucket features/coef/intercept |

**Why the v1.3.2 backup bundle, not the model repo's `honest_calibration.json`:**
the model repo's file was rebuilt from the retrained (region-offset) model,
so it belongs to the in-progress 1.4.0 model. The app's shipped artifact is
still v1.3.2 — an honest map must be fit on the *same* model's raw scores.
Recomputation from the backup reproduces the original honest numbers exactly
(full 0.6545 / 0.0536), confirming the backup is the v1.3.2 bundle.
Regenerate with `PYTHONPATH=~/workspace/lol-worlds-model/src
~/workspace/lol-worlds-model/.venv/bin/python scripts/build_wave2_data.py`
when the 1.4.0 artifact ships.

**Forward compatibility**: `artifacts.ts` prefers the artifact's own
`calibration_honest` / `player_gaps` / `live_models_role_gold` fields when a
future artifact carries them, falling back to the bundled files.

## 5. Integration still remaining

1. **Regenerate on the 1.4.0 artifact** (§4) — the honest maps, gaps, and
   variant A must come from the same bundle as the shipped artifact.
2. **Fitted calibration map for variant A** — needs the export step re-run
   (or an isotonic fit on the variant-A raw scores). Until then the shadow
   shows raw probs.
3. **Shadow test on live Swiss games** — the code paths are verified (see
   §7) but no live game has exercised them yet; the Swiss shadow test is
   still the gate before variant A drives any sizing.
4. **No live Expo run** — the toggle UI itself was not tapped in a running
   app here; logic verified via compiled-code tests (§7).

## 6. Findings (flagged, NOT fixed — each changes behavior, needs a decision)

1. **Baseline live model train/serve skew (2× gold).** The shipped live
   model was trained on `golddiff_k` = 2× the true team gold diff (the
   training script sums the team row + all five players). The app feeds
   `(blueTeam.totalGold − redTeam.totalGold) / 1000` = 1× true. So the
   Live tab's baseline prob is computed with gold at **half** the scale the
   model was trained on — systematically under-responsive to gold swings.
   Variant A is unaffected (its role diffs sum to the true 1× total, as
   trained). Fixing the baseline (halve the feed value's coefficient
   equivalent, i.e. feed 2×, or refit) changes live predictions — needs an
   explicit call, so it is left as-is.
2. **Baseline swapped-orientation caveat** (pre-existing, also noted in
   `docs/series-state.md`): when the user swaps sides, the baseline's prior
   flips but its gold feature stays feed-oriented. Variant A handles swap
   correctly (§3).

## 7. Verification

- `npx tsc --noEmit` — clean. `npx expo lint` — 0 errors, 7 warnings, all
  pre-existing (unused imports, one odds.ts import-order).
- Compiled-code test of the real `predict.ts`/`artifacts.ts`: toggle
  switches maps end-to-end (T1 vs BLG nodraft 0.2617 → 0.3496; draft 0.2927
  → 0.3251; Bo5 series 0.1082 → 0.1620); `result.calibration` carries the
  mode; gaps + variant A resolve from bundled files.
- Compiled-code test of the real `live.ts`: `liveProbaA` synthetic
  (top +0.5k, bot +1.2k, +2 kills, t=15) → 0.7158; neutral → 0.4866;
  `fetchWindow` against a real archived game parses `roleGold`
  (all-zero archived frames) + 5 picks per side.
- Bundled honest maps verified monotone, ys in (0, 1), interpolation sane.
