/** Kelly criterion for a single binary bet at decimal odds. */
import { CALIBRATION_TABLE } from './artifacts';
import type { CalibrationBin } from './types';

/* ------------------------- odds formats ------------------------- */

/**
 * American -> decimal. American odds are integers with |odds| >= 100
 * (-110 = risk $110 to win $100; +150 = win $150 on $100).
 * Returns null for invalid input (0, |odds| < 100, non-finite).
 */
export function americanToDecimal(american: number): number | null {
  if (!Number.isFinite(american) || american === 0 || Math.abs(american) < 100) return null;
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

/**
 * Decimal -> American (rounded to the nearest whole number).
 * Returns null for decimal <= 1 or non-finite input.
 */
export function decimalToAmerican(decimal: number): number | null {
  if (!Number.isFinite(decimal) || decimal <= 1) return null;
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

export interface ParsedOdds {
  /** Decimal odds (the canonical form Kelly math uses). */
  decimal: number;
  /** Which format the input was detected as. */
  format: 'decimal' | 'american';
  /** Equivalent American odds (rounded), for display. */
  american: number;
}

/**
 * Parse an odds field that accepts EITHER decimal or American odds.
 *
 * Detection (no toggle needed):
 * - starts with + or - (e.g. -222, +183) -> American (must be an integer, |odds| >= 100)
 * - bare integer >= 100 (e.g. 222) -> American +222 (decimal odds that large don't exist in practice)
 * - anything else (e.g. 1.85) -> decimal, must be > 1
 *
 * Returns null for empty / incomplete / invalid input (e.g. "-", "0", "-50").
 */
export function parseOddsInput(text: string): ParsedOdds | null {
  const s = text.trim().replace(',', '.');
  if (!s) return null;
  if (s.startsWith('+') || s.startsWith('-')) {
    if (!/^[+-]\d+$/.test(s)) return null;
    const american = parseInt(s, 10);
    const decimal = americanToDecimal(american);
    if (decimal === null) return null;
    return { decimal, format: 'american', american };
  }
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  if (v >= 100) {
    // Bare large integer: American without the + sign.
    if (!Number.isInteger(v)) return null;
    const decimal = americanToDecimal(v);
    if (decimal === null) return null;
    return { decimal, format: 'american', american: v };
  }
  if (v <= 1) return null;
  const american = decimalToAmerican(v);
  if (american === null) return null;
  return { decimal: v, format: 'decimal', american };
}

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

/** n of the calibration-table bin containing p (evidence behind this probability). */
export function binNForP(p: number): number {
  const table: CalibrationBin[] = CALIBRATION_TABLE;
  let bin = table[table.length - 1];
  for (const b of table) {
    if (p < b.pred_range[1] || b === table[table.length - 1]) {
      bin = b;
      break;
    }
  }
  return bin.n;
}

export interface KellyRecommendation {
  frac: 1 | 0.5 | 0.25;
  label: 'Full Kelly' | 'Half Kelly' | 'Quarter Kelly';
  reason: string;
}

/**
 * Adaptive fraction recommendation from edge size and calibration evidence.
 * - edge < 3% or thin evidence (bin n < 30) -> quarter Kelly (caution)
 * - edge >= 8% on strong evidence (bin n >= 300) -> full Kelly
 * - otherwise -> half Kelly (default)
 */
export function recommendKelly(edge: number, binN: number): KellyRecommendation {
  if (edge < 0.03 || binN < 30) {
    const why =
      edge < 0.03 && binN < 30
        ? `thin edge (${fmtPct(edge)}) on thin evidence (n=${binN})`
        : edge < 0.03
          ? `thin edge (${fmtPct(edge)})`
          : `thin evidence (n=${binN})`;
    return { frac: 0.25, label: 'Quarter Kelly', reason: `Recommended: quarter Kelly — ${why}.` };
  }
  if (edge >= 0.08 && binN >= 300) {
    return {
      frac: 1,
      label: 'Full Kelly',
      reason: `Recommended: full Kelly — large edge (${fmtPct(edge)}) with strong evidence (n=${binN}).`,
    };
  }
  return {
    frac: 0.5,
    label: 'Half Kelly',
    reason: `Recommended: half Kelly — moderate edge (${fmtPct(edge)}, n=${binN}).`,
  };
}

export interface AgreementResult {
  /**
   * true = Pinnacle confirms value at the book's price;
   * false = model is the outlier vs smart money;
   * null = no check (no Pinnacle price, or the bet itself is priced at Pinnacle).
   */
  agrees: boolean | null;
  /** De-vigged Pinnacle implied probability for the bet side; null when unavailable. */
  q: number | null;
  /** Recommended fraction after the agreement adjustment. */
  adjFrac: 1 | 0.5 | 0.25;
  /** One-line UI note. */
  note: string;
}

/**
 * Smart-money agreement check against Pinnacle (the sharp reference).
 *
 * @param p        model win probability for the bet side
 * @param dBook    decimal price taken at the user's book
 * @param dPinX    Pinnacle's decimal price on the bet side (null when not posted)
 * @param dPinOther Pinnacle's decimal price on the other side (null when not posted)
 * @param baseFrac adaptive fraction from recommendKelly
 *
 * Pinnacle agrees there is value at the book's price iff its (de-vigged)
 * implied probability beats the book's implied probability. On disagreement
 * the recommended fraction is halved (floor: quarter Kelly).
 */
export function agreementAdjust(
  p: number,
  dBook: number,
  dPinX: number | null,
  dPinOther: number | null,
  baseFrac: 1 | 0.5 | 0.25,
): AgreementResult {
  const valid = (x: number | null): x is number => x !== null && Number.isFinite(x) && x > 1;
  if (!valid(dPinX)) {
    return {
      agrees: null,
      q: null,
      adjFrac: baseFrac,
      note: 'No Pinnacle price for this match — no smart-money check.',
    };
  }
  if (Math.abs(dBook - dPinX) < 1e-9) {
    return {
      agrees: null,
      q: null,
      adjFrac: baseFrac,
      note: 'Priced at Pinnacle (sharp reference) — no adjustment needed.',
    };
  }
  let q: number;
  if (valid(dPinOther)) {
    const overround = 1 / dPinX + 1 / dPinOther;
    q = 1 / dPinX / overround;
  } else {
    q = 1 / dPinX; // one-sided: raw implied, can't de-vig
  }
  const impliedBook = 1 / dBook;
  if (q > impliedBook) {
    return {
      agrees: true,
      q,
      adjFrac: baseFrac,
      note: `Pinnacle agrees — de-vigged Pinnacle implies ${fmtPct(q)} vs ${fmtPct(impliedBook)} at your book.`,
    };
  }
  const adjFrac: 1 | 0.5 | 0.25 = baseFrac === 1 ? 0.5 : 0.25;
  return {
    agrees: false,
    q,
    adjFrac,
    note: `Pinnacle disagrees — Pinnacle implies ${fmtPct(q)} vs ${fmtPct(impliedBook)} at your book; model is the outlier, sizing down.`,
  };
}

export function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtMoney(x: number): string {
  return `$${x.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}
