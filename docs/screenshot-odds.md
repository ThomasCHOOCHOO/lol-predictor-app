# Screenshot odds

Odds tab section "Screenshot odds — should you bet?" prices a book's
moneyline board from a screenshot, one verdict per game.

## Pipeline

1. Pick an image (`expo-image-picker`). On web, Tesseract.js reads it
   on-device (worker + English data load from its CDN on first use; the
   image itself never leaves the device). On native, Tesseract cannot run
   — React Native has no WebAssembly support — so the section falls back
   to pasting OCR text or adding games by hand, which still parse and price.
2. `parseScreenshotOdds` (src/model/screenshotOdds.ts, pure, tested on
   sample OCR text) pairs team names to odds in reading order, two
   distinct teams per game, handling decimal and American odds and
   odds-on-the-next-line boards. Team names resolve through the artifact
   alias table (LOS -> LØS, GenG -> Gen.G, etc.).
3. Every parsed row is editable in place (teams, odds, Bo1/3/5). Verdicts
   recompute on edit. Nothing is trusted blindly: OCR misreads names and
   digits, and a board can mix series prices with map-1/handicap prices.
   Low-confidence rows are flagged "Check this row".
4. `verdictForGame` prices each game with the series conversion
   (side-averaged per-map prob, binomial for the row's best-of, default
   Bo1). Per side: implied = 1/odds, ROI edge = p*odds - 1, Kelly via the
   adaptive rule. Verdict bar: BET at ROI edge >= 5% (the edge-watch bar),
   THIN at 0–5% (positive, quarter Kelly), NO BET at or below 0%.
   Verdicts are per game, priced independently — not a parlay ticket.
   Pricing only; no bet is placed from here.

## Board rules (learned from a real Pinnacle Oct 23 board, 2026-10-20)

- Only "(Match)" rows are series prices. "(Map 1)" rows repeat the same
  match at the same odds and are skipped; a repeated team pair is also
  deduplicated (keep the first), so a misread Map label can't double a game.
- Tesseract puts both moneyline odds on the second team's line
  ("Gen.G (Match)" / "Invictus (Match) -417 +312"), so odds on a team
  line are assigned to pending teams first, then to teams on that line.
  Position-only pairing would shift every favourite's price onto the
  underdog — this was the actual bug on the Oct 23 board.
- Teams and odds may split across lines or arrive column-wise; teams
  without odds queue up and odds-only lines drain that queue in order.
- Book truncations are mapped parser-locally: "Liquid" -> Team Liquid,
  "KOI" -> Movistar KOI (artifact aliases already cover Invictus, G2,
  Karmine, LYON, Secret Whales, CTBC Flying Oyster, Bilibili).
- Upscaling is load-bearing: at the board's native 714 px width
  Tesseract returned gibberish; at 2x it returned the board almost
  verbatim. Images narrower than 1200 px are drawn to a 2x canvas
  before recognition.

## Validation on the Oct 23 board

Parser + verdicts were run on real 2x OCR output from the user's
Pinnacle screenshot: exactly 8 games, all teams mapped, all odds correct
(American -> decimal, e.g. -417 -> 1.24, +534 -> 6.34), no Map
duplicates. Verdicts on that board: BET on Invictus Gaming, Team
Liquid, Karmine Corp, Top Esports, LØS, Movistar KOI; THIN on G2
Esports; NO BET on Secret Whales vs LYON. Note the LØS verdict
(ROI +119.5%) is a model-vs-Pinnacle disagreement — LØS Elo is a
known weak-region-dominator inflation case, so treat that one as a
model outlier to check, not a confident bet.

## Limits

- Only h2h series-winner odds are priced. Map, handicap, and totals
  rows must be deleted or corrected.
- A screenshot with many games, small text, or a dark board will parse
  worse — crop to just the odds board before uploading.
