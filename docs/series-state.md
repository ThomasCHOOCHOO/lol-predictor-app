# Stateful series model (v1.4.0 Phase 1) — Live tab

Implemented per `lol-worlds-model/reports/series_state_design.md`. The Predict tab
is untouched: its pre-series mode still uses the binomial conversion.

## New module: `src/model/seriesState.ts` (pure TS, no feed I/O)

- `initSeries(teamA, teamB, bestOf, pNeutral, s)` — prior μ₀ = logit(pNeutral),
  λ₀ = 1/σ₀² with `SIGMA0_DEFAULT = 0.5`.
- `mapWinProb(state, draftLift?)` — next-map P(A) from current state:
  μ + side term s + previous-map-winner term + streak term + depletion term
  + draft lift.
- `seriesWinProb(state)` — backward induction over (score, next side,
  prevWin, streak). μ/λ/streak/depletion held fixed in lookahead, per the
  design. Unknown next side averages 50/50 for the first step; later steps
  use the loser-takes-blue rule `LOSER_BLUE_PROB = 0.622` (the Play-In
  "winner stays blue" pattern was a small-sample fluke).
- `recordGame(state, input)` — immutable, idempotent by game number, no-op
  once terminal. Update: p̂ from pre-game state; weight
  `w = 0.5 + |c − 0.5|` from the closing live estimate; λ′ = λ + w·p̂(1−p̂);
  μ′ = μ + w·(y − p̂)/λ′. The closing estimate enters as a **weight**, never
  as a second observation. `withNextBlue(state, side)` sets the side of the
  next unresolved game (`null` = unknown, DP averages).
- `PREV_WIN_COEF = 0.14` (shrunk previous-map-winner term). **Pending
  validation: a separate validation is checking this coefficient against
  Worlds 2026 Play-In + Swiss games 2+ (pre-registered criterion: log-loss
  lift > 0), and it must be removed if validation fails.**
- `gamma` / `delta` default to 0; the prev-win term is the active momentum.
  `lambdaPool` defaults to 0 — Fearless depletion is plumbed but does not
  move any probability yet.
- `pNeutral` is stored on the state so the posterior can be restarted from
  the prior at the live score after a multi-game gap; `accountedThrough`
  marks games covered by such a restart so they are not re-processed.

## Feed plumbing: `src/model/live.ts`

- `fetchMatchGames(matchId)` — all games with per-game sides (GW
  `getEventDetails`). The GW API exposes **no per-game winner and no
  picks/bans**.
- `fetchMatchScore(matchId)` — current `gameWins` by team code. `getLive`
  first; `getSchedule` (Worlds league) as fallback.
- `fetchWindow(gameId)` now returns `{ frames, bluePicks, redPicks }` —
  picks come from livestats window `gameMetadata` participant data.
- `computeDeplNet(teamA, teamB, usedChamps)` — net burned top-5-comfort
  champions (A − B). Provisional definition pending a fitted λ_pool.
- `loadSeriesState` / `saveSeriesState` — per-match AsyncStorage
  persistence (`series_state_<matchId>`), so a refresh mid-series resumes.
- `fetchLiveGame` refactored onto `fetchMatchGames`.

## Live tab wiring: `src/app/live.tsx`

- On match select: state is fresh, persisted, or reconciled against the live
  score (team/bestOf mismatch discards a stale state). The current game's
  side becomes `nextBlue` while it is in progress.
- Every poll: the closing live estimate (A perspective, from the last poll's
  `liveP`) is kept in a ref; picks from window metadata are kept in a ref;
  when a game ends, `reconcileSeries` folds it in.
- Winner attribution: exactly one missing completed game + score moved by
  exactly one win for one team → that team won it. If the score hasn't
  moved yet, attribution is deferred (no reset). If several games finished
  while the tab was away (or the score jumped), the posterior restarts from
  the prior at the live score — per-game order is never fabricated; only
  the μ adjustment resets, the banked score is preserved.
- Advancing to a new game sets `nextBlue` from the new game's sides;
  between games `nextBlue` is cleared (DP averages 50/50) instead of
  reusing the last game's side.
- Series card under the Watching card: score, series win %, next-map win %
  (between games), and per-map winners.

## Still missing / not wired

- **Draft lift = 0.** There is no draft source in the Live tab yet, so
  `draft_lift` is always 0. When one exists, it enters separately as
  `draft_lift = logit(p_draft) − logit(p_predraft)`.
- **Fearless depletion does not move probabilities** (`lambdaPool = 0`).
  `computeDeplNet` + `usedChamps` tracking are plumbing only until λ_pool
  is fitted.
- **Validation of `PREV_WIN_COEF = 0.14` not yet run** (see above). The
  coefficient must be removed if validation fails.
- **No live test against a real in-progress series yet.** The reconcile /
  advance paths have not been exercised against a live match (feed shape
  for `getEventDetails` / `getLive` / `getSchedule` / window metadata was
  verified against recorded fixtures, not a live series).
- **Closing estimate is the t≤25 bucket proxy** from the last poll, not a
  true at-buzzer value; and it inherits the tab's pre-existing
  swapped-orientation caveat (with `swapped=true`, `goldDiffK` stays in
  feed orientation while `liveP` is swapped-aware).
- If the score feed lags at match end, the final game may stay unrecorded
  (attribution defers until the score moves).
- `getSchedule` fallback is Worlds-league only; `getLive` covers all
  leagues first.

## Verification

- `npx tsc --noEmit` — clean.
- `npx expo lint` — 0 errors, 8 warnings (all pre-existing in unrelated
  files / unused imports that predate this change).
- Golden replay from the design doc (§7.1, KC–C9) re-verified after the
  final edits: series/map probs match to ≤0.004, final μ +0.5009 vs +0.50.
