/** Kelly criterion for a single binary bet at decimal odds. */

export interface KellyResult {
  odds: number;
  p: number; // model's calibrated win probability for the chosen side
  implied: number; // 1 / odds
  edge: number; // p - implied
  fStar: number; // full-Kelly fraction of bankroll
  bet: boolean; // edge > 0
}

export function kelly(odds: number, p: number): KellyResult | null {
  if (!Number.isFinite(odds) || odds <= 1 || !Number.isFinite(p) || p <= 0 || p >= 1) return null;
  const implied = 1 / odds;
  const b = odds - 1;
  const q = 1 - p;
  const edge = p - implied;
  const fStar = (b * p - q) / b; // == p - q / b
  return { odds, p, implied, edge, fStar, bet: edge > 0 };
}

export const KELLY_CAVEAT =
  'Kelly assumes the model\u2019s p is the true probability. It isn\u2019t — the model is 64% accurate on holdout, so half-Kelly (or less) is the responsible default.';

export function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtMoney(x: number): string {
  return `$${x.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}
