/**
 * Monte Carlo bankroll simulation for repeated Kelly-sized bets.
 *
 * Setup: the bettor repeats the same bet N times — decimal odds `odds`,
 * ROI edge `edge` (so win prob p = (1 + edge) / odds), and a stake of
 * `kellyMultiplier` x the full-Kelly fraction on every bet, re-sized to the
 * current bankroll each time (compounding, same as the Kelly tab).
 *
 * Full-Kelly fraction for decimal odds: f* = edge / (odds - 1).
 *
 * Pure functions, no network, no randomness source beyond the seeded PRNG —
 * the same inputs always produce the same paths, so the chart never jitters
 * on unrelated re-renders.
 */

export interface MonteCarloParams {
  bankroll: number;
  odds: number;
  edge: number; // ROI edge as a fraction, e.g. 0.05 = 5%
  kellyMultiplier: number; // 1 = full Kelly, 0.5 = half, 0.25 = quarter
  nBets: number;
  nSims: number;
}

export interface MonteCarloResult {
  /** Full-Kelly stake fraction (before the multiplier). */
  fullKellyFraction: number;
  /** Stake fraction actually used per bet. */
  stakeFraction: number;
  /** Implied win probability. */
  winProb: number;
  /** Per-bet bankroll percentiles: index 0 = before bet 1. */
  p10: number[];
  p50: number[];
  p90: number[];
  /** A few full trajectories, for faint sample lines. */
  samplePaths: number[][];
  /** Final-bankroll stats. */
  finalMedian: number;
  finalP10: number;
  finalP90: number;
  probProfit: number; // P(final > starting bankroll)
  probHalved: number; // P(final < half the starting bankroll)
  probBust: number; // P(final < $1)
}

/** mulberry32 — small seeded PRNG, deterministic per seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a-ish hash so the seed is a deterministic function of the inputs. */
function hashParams(p: MonteCarloParams): number {
  const s = [p.bankroll, p.odds, p.edge, p.kellyMultiplier, p.nBets, p.nSims].join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx];
}

export function runMonteCarlo(params: MonteCarloParams): MonteCarloResult {
  const { bankroll, odds, edge, kellyMultiplier, nBets, nSims } = params;
  const winProb = (1 + edge) / odds;
  const fullKellyFraction = Math.max(0, edge / (odds - 1));
  const stakeFraction = Math.min(1, kellyMultiplier * fullKellyFraction);
  const winGrowth = 1 + stakeFraction * (odds - 1);
  const lossGrowth = 1 - stakeFraction;

  const rng = mulberry32(hashParams(params));
  // bankrolls[sim][bet] — bet 0 is the starting bankroll.
  const bankrolls: number[][] = [];
  const finals: number[] = [];
  for (let s = 0; s < nSims; s++) {
    const path: number[] = [bankroll];
    let b = bankroll;
    for (let i = 0; i < nBets; i++) {
      b *= rng() < winProb ? winGrowth : lossGrowth;
      path.push(b);
    }
    bankrolls.push(path);
    finals.push(b);
  }

  const p10: number[] = [];
  const p50: number[] = [];
  const p90: number[] = [];
  const col: number[] = new Array(nSims);
  for (let i = 0; i <= nBets; i++) {
    for (let s = 0; s < nSims; s++) col[s] = bankrolls[s][i];
    col.sort((a, b2) => a - b2);
    p10.push(percentile(col, 0.1));
    p50.push(percentile(col, 0.5));
    p90.push(percentile(col, 0.9));
  }

  const sortedFinals = [...finals].sort((a, b) => a - b);
  const countBelow = (t: number): number => {
    let c = 0;
    for (const f of finals) if (f < t) c++;
    return c;
  };
  return {
    fullKellyFraction,
    stakeFraction,
    winProb,
    p10,
    p50,
    p90,
    samplePaths: bankrolls.slice(0, 10),
    finalMedian: percentile(sortedFinals, 0.5),
    finalP10: percentile(sortedFinals, 0.1),
    finalP90: percentile(sortedFinals, 0.9),
    probProfit: finals.filter((f) => f > bankroll).length / nSims,
    probHalved: countBelow(bankroll * 0.5) / nSims,
    probBust: countBelow(1) / nSims,
  };
}
