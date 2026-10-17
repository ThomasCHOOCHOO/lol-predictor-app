# Odds tab: saved-pull arb rows + arb calculator

## Part 1 — Arb instances + % in the saved lines

Each game in the last-saved-pull banner now gets an arb row when the pull
contains an arbitrage at or above the alert bar.

- **Detection:** from the pull's stored `bestHome` / `bestAway` legs — the
  best price per side across *all* books in that pull (computed at save time
  in `buildSnapshots`, not just the user's stored book rows). Arb exists
  when `1/best_home + 1/best_away < 1`.
- **Arb % formula:** `arb% = (1 − (1/best_home + 1/best_away)) × 100`, i.e.
  `profitPct` from the shared arb helper (see below).
- **Alert bar:** only arbs with `profitPct >= ARB_ALERT_BAR` (1%) get a row.
  `ARB_ALERT_BAR = 0.01` is exported from `src/model/odds.ts`; no arb
  threshold constant existed in the app before — 1% matches the edge-watch
  arb alert bar. Games with no arb (or a sub-1% arb) show nothing extra.
- **Row format:** `ARB 2.40% (saved pull)` + `Back T1 @ 2.10 (Pinnacle) +
  Back BLG @ 1.95 (bet365)` + `Computed from this saved pull — prices may
  have moved. Tap to load into the arb calculator ↓`. The "(saved pull)"
  label and the banner's existing "Saved pull — not live data" header make
  clear this is stale-pull math, not live data.
- **Tapping a row** prefills the calculator (Part 2) with that pair's odds +
  book names.

### Reuse, not duplication

- `src/model/odds.ts` gained `arbFromBestLegs(home, away)` — the single
  source of the arb-existence / profit formula. `detectArb` (live board)
  was refactored to call it; the saved-pull banner calls it with the
  snapshot's best legs converted to `ArbLeg`s (title resolved via the
  banner's existing `titleOf`). No second copy of the formula exists.
- The calculator reuses `splitStake` (equal-payout stake split) and
  `parseOddsInput` (decimal/American auto-detection, same as Kelly) from
  `src/model/kelly.ts`, and the existing `ARB_CAVEAT` text.

## Part 2 — Arb calculator

New `ArbCalculator` card in the Odds tab, rendered right after the
last-saved-pull banner, outside the refresh gate (usable without API keys).

- **Inputs:** odds for outcome A, odds for outcome B (each accepts decimal
  `1.85` or American `-122` / `+183`, auto-detected via `parseOddsInput`),
  total stake (default `$100`), optional book-name label per side.
- **Outputs (arb exists):** arb %; stake for A and stake for B (split via
  `splitStake` so both outcomes pay the same); guaranteed profit in dollars
  (same whichever side wins); ROI %. Odds shown back in decimal + American.
- **Outputs (no arb):** `No arb — combined implied probability X%`, where
  `X = (1/oddsA + 1/oddsB) × 100`. No stake split is shown (it would imply
  a guaranteed loss).
- **Invalid input:** `Enter valid odds for both sides…` / `Enter a total
  stake above 0…`.
- **Prefill:** tapping an arb row in the banner loads that pair's odds +
  book names into the calculator and shows `Loaded from saved pull:
  <matchup>`. Implemented via a `key` remount on each tap, so user edits
  between taps are preserved and no effect-based state sync is needed.
- **Scope:** 2-way only (LoL match-winner). Planning tool only — places no
  bets, never hands off to Kelly, never modifies saved pulls. Carries the
  `ARB_CAVEAT` warning (arb windows close in seconds; confirm both legs).

## Verification

- `npx tsc --noEmit`: clean.
- `npx expo lint`: 0 errors, 7 warnings — all pre-existing (unused imports
  in `artifacts.ts`, import order in `odds.ts`), none in `odds.tsx`.
- Existing Odds tab behavior untouched: MatchCard arb badge/panel, source
  picker, pinned books, history tables, arb-pair stats, Kelly handoff.

## Notes / limitations

- Saved snapshots store best legs across all books in the pull, so banner
  arb rows consider the full board — but the pull itself may be stale; the
  banner's staleness coloring still applies.
- Sub-1% arbs exist in the math but are deliberately not surfaced in the
  banner (below the alert bar); the calculator will compute them if the
  user types the odds in manually.
