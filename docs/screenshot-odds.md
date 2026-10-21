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

## Limits (not yet validated)

- The OCR path itself has NOT been validated on a real book screenshot
  (parser + verdicts were tested on clean OCR text, including American
  odds). First real-screenshot test should check parsed rows against the
  board before trusting any verdict.
- Only h2h series-winner odds are priced. Map, handicap, and totals
  rows must be deleted or corrected.
- A screenshot with many games, small text, or a dark board will parse
  worse — crop to just the odds board before uploading.
