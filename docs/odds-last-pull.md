# Odds tab — last saved pull banner

**What:** a prominent "Last saved pull" banner at the **top** of the Odds tab
(`src/app/odds.tsx`, `LastPullBanner`), directly under the intro text and
above the source picker — outside the refresh gate, so it is visible even
before any API key is saved.

## What it shows

- **Header row:** "Last saved pull" + "Saved pull — not live data".
- **Timestamp, prominent:** `Last pulled: Fri, Oct 17, 1:32 PM EDT (32 min ago)` —
  absolute time in America/Toronto plus relative age. The relative age
  re-computes every 60s while the tab is open.
- **Staleness, never hidden:**
  - `< 1h`: age in green.
  - `1–24h`: age in amber + "Prices may have moved — refresh before betting."
  - `> 24h`: age in red + "Stale — these prices are over a day old. Refresh
    before betting." The banner's border takes the same color.
- **The pull's actual saved odds rows:** one block per game
  (`HOME vs AWAY`, commence time), with a row per saved book
  (title, home price, away price) and a "Best:" line with the best leg per
  side and the book that offered it.
- **Empty state** (same spot): "No odds pulled yet — pull odds to see them
  here." plus "Saved pulls appear here after a successful OddsPapi refresh."
  While history is still loading from storage the banner renders nothing,
  so a saved pull never flashes as "no pulls yet".

## What "saved pull" means

- Source of truth: AsyncStorage key `odds_history_v1`
  (`src/model/oddsHistory.ts`), capped at 100 snapshots.
- A pull writes one snapshot per event, all sharing one `ts`. The banner
  groups by that `ts` (latest wins) to recover exactly the most recent
  pull's rows — it does not mix snapshots across pulls.
- **OddsPapi only.** `buildSnapshots` saves OddsPapi pulls; The Odds API
  pulls are never persisted, so the banner is labeled as an OddsPapi pull.
- **Read-only.** Saved prices are stale by definition, so banner rows never
  hand off to Kelly (unlike the live match cards below). The banner also
  updates automatically after a fresh refresh, since `refresh()` writes
  history state.

## What was not changed

- Pull behavior and storage: untouched. Source picker, pinned books,
  history tables (book stats / arb pairs), arb math, and Kelly handoff all
  work exactly as before.
- The pre-existing "Saved pulls" card (aggregates) stays where it was; the
  banner is the per-pull view on top of it.

## Verification

- `npx tsc --noEmit` — clean.
- `npx expo lint` — 0 errors, 7 warnings, all pre-existing in other files
  (`live.tsx`, `artifacts.ts`, `odds.ts`); none in `odds.tsx`.
- No live Expo run of the UI in this task.
