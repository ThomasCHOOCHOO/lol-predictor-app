/**
 * Prop pricing + related-parlay joint simulation for the Derivatives tab.
 *
 * Mirrors the Python fits in the model repo (src/prop_models.py) exactly:
 * same formulas, same sidecar constants, same joint-table strata. The Python
 * side is the reference; this file is the port. Parity examples are printed
 * by `prop_models.py` (total-kills mu, first-dragon P, series exact @p=0.6)
 * and must match these functions' outputs.
 *
 * Pure functions only — no React Native imports — so the module can be
 * compiled standalone for parity checks.
 */
import propRaw from '../data/prop_models.json';
import { TEAMS } from './artifacts';

/* ------------------------------------------------------------------ types */

export interface TeamPropStats {
  pace_for: number;
  pace_against: number;
  fb: number;
  fd: number;
  ft: number;
  games: number;
  last_date: string;
}

export interface PlayerPropStats {
  name: string;
  team: string;
  position: string;
  rate: number;
  games: number;
}

/**
 * App-sidecar player rows are compact tuples [name, team, position, rate,
 * games] — the model-repo sidecar keys players by Oracle's Elixir playerid
 * (a 42-char key), which would add ~95 KB of dead weight to the app bundle.
 * The copy step (see docs/derivatives.md) converts dict → tuples.
 */
export type PlayerTuple = [string, string, string, number, number];

export function playerFromTuple(t: PlayerTuple): PlayerPropStats {
  return { name: t[0], team: t[1], position: t[2], rate: t[3], games: t[4] };
}

export interface PropSidecar {
  version: string;
  fitted_on: string;
  validated_on: string;
  gate: number;
  total_kills: {
    coef: number[];
    alpha: number;
    n_train: number;
    validation: { n: number; ll: number; naive_ll: number; delta: number };
    shipped: boolean;
  };
  player_kills: {
    coef: number[];
    alpha: number;
    n_train: number;
    positions: string[];
    shrink: number;
    pos_means: Record<string, number>;
    validation: { n: number; ll: number; naive_ll: number; delta: number };
    shipped: boolean;
  };
  first_x: Record<
    string,
    {
      coef: number[];
      intercept: number;
      base_rate: number;
      n_train: number;
      validation: { n: number; ll: number; naive_ll: number; delta: number };
      shipped: boolean;
    }
  >;
  series: {
    method: string;
    validation: {
      n: number;
      exact_ll: number;
      exact_naive_ll: number;
      maps_ll: number;
      maps_naive_ll: number;
      shipped: boolean;
    };
    shipped: boolean;
    maps_model: {
      bo5: { classes: number[]; coef: number[][]; intercept: number[]; n_train: number };
      bo3: { coef: number[]; intercept: number; n_train: number };
      validation: { n: number; ll: number; naive_ll: number; delta: number };
      shipped: boolean;
    };
  };
  joint: {
    p_bins: number[];
    kill_buckets: number[][];
    /** table[winner][p-bin][map-index bucket][tied?] = 80 cell probabilities. */
    table: Record<string, number[][][][]>;
    validation: {
      n_series: number;
      n_sims: number;
      joint_ll: number;
      naive_ll: number;
      combos: Record<string, { joint_ll: number; naive_ll: number; mean_joint: number; actual_rate: number }>;
    };
  };
  teams: Record<string, TeamPropStats>;
  /** Compact tuples — see PlayerTuple. */
  players: PlayerTuple[];
}

export const PROPS = propRaw as unknown as PropSidecar;

/** Elo diff (plain, no region offset) for a matchup, from the artifact. */
export function eloDiffFor(a: string, b: string): number {
  const ea = TEAMS[a] ? TEAMS[a].elo : 1500;
  const eb = TEAMS[b] ? TEAMS[b].elo : 1500;
  return ea - eb;
}

export function teamPropStats(team: string): TeamPropStats | null {
  return PROPS.teams[team] ?? null;
}

/* ------------------------------------------------------- (a) total kills */

function nbOverProb(mu: number, alpha: number, line: number): number {
  const a = Math.max(alpha, 1e-6);
  const n = 1 / a;
  const p = n / (n + mu);
  // P(X > line) = 1 - CDF(floor(line)) for NB(n, p).
  return 1 - nbinomCdf(Math.floor(line), n, p);
}

/** NB CDF via the regularized incomplete beta: CDF(k) = I_p(n, k+1). */
function nbinomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  return regularizedBeta(p, n, k + 1);
}

/**
 * Regularized incomplete beta I_x(a, b), continued-fraction (Numerical
 * Recipes betacf). Accurate enough for pricing (matches scipy to ~1e-10
 * on the ranges used here).
 */
function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt =
    Math.exp(
      logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
    );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaCf(x, a, b)) / a;
  }
  return 1 - (bt * betaCf(1 - x, b, a)) / b;
}

function betaCf(x: number, a: number, b: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function logGamma(z: number): number {
  // Lanczos approximation (g = 7, 9 coefficients).
  const COEF = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const zz = z - 1;
  let x = COEF[0];
  for (let i = 1; i < 9; i++) x += COEF[i] / (zz + i);
  const t = zz + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

export interface TotalKillsPrice {
  mu: number;
  pOver: number;
  pUnder: number;
}

export function priceTotalKills(
  paceA: TeamPropStats,
  paceB: TeamPropStats,
  eloDiff: number,
  line: number,
): TotalKillsPrice | null {
  if (!PROPS.total_kills.shipped) return null;
  const c = PROPS.total_kills.coef;
  const mu0 = (paceA.pace_for + paceA.pace_against + paceB.pace_for + paceB.pace_against) / 2;
  const mu = Math.exp(c[0] + c[1] * Math.log(Math.max(mu0, 1)) + c[2] * (Math.abs(eloDiff) / 100));
  const pOver = nbOverProb(mu, PROPS.total_kills.alpha, line);
  return { mu, pOver, pUnder: 1 - pOver };
}

/* ------------------------------------------------------ (b) player kills */

export interface PlayerKillsPrice {
  mu: number;
  pOver: number;
  pUnder: number;
}

export function pricePlayerKills(
  player: PlayerPropStats,
  teamPace: number,
  oppPace: number,
  eloSigned: number,
  line: number,
): PlayerKillsPrice | null {
  if (!PROPS.player_kills.shipped) return null;
  const c = PROPS.player_kills.coef;
  const posIdx = PROPS.player_kills.positions.indexOf(player.position);
  if (posIdx < 0) return null;
  const z =
    c[0] +
    c[1] * Math.log(Math.max(player.rate, 0.05)) +
    c[2] * teamPace +
    c[3] * oppPace +
    c[4] * (eloSigned / 100) +
    c[5 + posIdx];
  const muRaw = Math.exp(z);
  // Same shrinkage toward the position mean as the Python fit.
  const shrink = PROPS.player_kills.shrink ?? 1;
  const posMean = PROPS.player_kills.pos_means?.[player.position] ?? muRaw;
  const mu = posMean + shrink * (muRaw - posMean);
  const pOver = nbOverProb(mu, PROPS.player_kills.alpha, line);
  return { mu, pOver, pUnder: 1 - pOver };
}

/* ----------------------------------------------------------- (c) first-X */

export type FirstObj = 'blood' | 'dragon' | 'tower';

export function priceFirstX(
  obj: FirstObj,
  eloDiff: number,
  ownRate: number,
  oppRate: number,
): number | null {
  const m = PROPS.first_x[obj];
  if (!m || !m.shipped) return null;
  const c = m.coef;
  const z = m.intercept + c[0] * (eloDiff / 100) + c[1] * ownRate + c[2] * oppRate;
  return 1 / (1 + Math.exp(-z));
}

export function firstXRate(team: string, obj: FirstObj): number | null {
  const s = teamPropStats(team);
  if (!s) return null;
  return obj === 'blood' ? s.fb : obj === 'dragon' ? s.fd : s.ft;
}

/* ------------------------------------------------------------ (d) series */

/** Exact-score distribution for Bo1/Bo3/Bo5, fixed per-map p (P(A wins a map)). */
export function seriesExactProbs(p: number, bestOf: number): Record<string, number> {
  const q = 1 - p;
  if (bestOf <= 1) return { '1-0': p, '0-1': q };
  if (bestOf === 3) {
    return {
      '2-0': p ** 2,
      '2-1': 2 * p ** 2 * q,
      '1-2': 2 * p * q ** 2,
      '0-2': q ** 2,
    };
  }
  return {
    '3-0': p ** 3,
    '3-1': 3 * p ** 3 * q,
    '3-2': 6 * p ** 3 * q ** 2,
    '2-3': 6 * p ** 2 * q ** 3,
    '1-3': 3 * p * q ** 3,
    '0-3': q ** 3,
  };
}

/** Total-maps distribution for Bo1/Bo3/Bo5, fixed per-map p. */
export function seriesMapsProbs(p: number, bestOf: number): Record<string, number> {
  const e = seriesExactProbs(p, bestOf);
  if (bestOf <= 1) return { '1': 1 };
  if (bestOf === 3) return { '2': e['2-0'] + e['0-2'], '3': e['2-1'] + e['1-2'] };
  return { '3': e['3-0'] + e['0-3'], '4': e['3-1'] + e['1-3'], '5': e['3-2'] + e['2-3'] };
}

function logit(p: number): number {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
}

/**
 * Total-maps distribution conditional on per-map p (multinomial logistic
 * on [logit(p), |logit(p)|]). The binomial maps marginal LOSES to the
 * empirical distribution out-of-sample, so the standalone total-maps prop
 * uses this model. Falls back to the binomial when the model didn't ship.
 * The joint simulator still draws winners Bernoulli(p) — its maps marginal
 * inherits the small binomial deficit; documented in docs/derivatives.md.
 */
export function seriesMapsProbsConditional(p: number, bestOf: number): Record<string, number> {
  const m = PROPS.series.maps_model;
  if (!m || !m.shipped) return seriesMapsProbs(p, bestOf);
  if (bestOf <= 1) return { '1': 1 };
  const z = [logit(p), Math.abs(logit(p))];
  if (bestOf === 3) {
    const lin = m.bo3.intercept + m.bo3.coef[0] * z[0] + m.bo3.coef[1] * z[1];
    const p3 = 1 / (1 + Math.exp(-lin));
    return { '2': 1 - p3, '3': p3 };
  }
  const logits = m.bo5.coef.map((row, i) => m.bo5.intercept[i] + row[0] * z[0] + row[1] * z[1]);
  const mx = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - mx));
  const tot = exps.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  m.bo5.classes.forEach((c, i) => {
    out[String(c)] = exps[i] / tot;
  });
  return out;
}

/* ----------------------------------------------------- joint simulation */

/** mulberry32 — same seeded PRNG family as the Monte Carlo simulator. */
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

function hashSeed(parts: string): number {
  let h = 2166136261;
  const s = parts;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pbinIndex(p: number): number {
  const bins = PROPS.joint.p_bins;
  for (let i = 0; i < bins.length - 1; i++) {
    if (p >= bins[i] && p < bins[i + 1]) return i;
  }
  return bins.length - 2;
}

export interface SimSeries {
  winner: 'A' | 'B';
  aWins: number;
  bWins: number;
  maps: number;
  kills: number;
  map1: { fb: number; fd: number; ft: number };
}

/**
 * Simulate `nSims` series for a matchup with per-map P(A wins) = p.
 * Per map: winner ~ Bernoulli(p), then a (kill bucket, firsts combo) cell
 * drawn JOINTLY from the empirical table for (winner, p-bin) — this is what
 * preserves the kills<->firsts correlation inside each stratum. Identical
 * algorithm to the Python validator (src/prop_models.py).
 */
export function simulateSeries(p: number, bestOf: number, nSims: number): SimSeries[] {
  const need = Math.floor(bestOf / 2) + 1;
  const b = pbinIndex(p);
  const table = PROPS.joint.table;
  const buckets = PROPS.joint.kill_buckets;
  const rng = mulberry32(hashSeed(`${p.toFixed(6)}|${bestOf}|${nSims}`));
  const out: SimSeries[] = [];
  for (let s = 0; s < nSims; s++) {
    let aWins = 0;
    let bWins = 0;
    let kills = 0;
    let maps = 0;
    let map1 = { fb: 0, fd: 0, ft: 0 };
    while (aWins < need && bWins < need) {
      const winner: 'A' | 'B' = rng() < p ? 'A' : 'B';
      // Map-index bucket: decider maps are slower (game-5 maps average
      // ~29.5 kills vs ~33.3 for game 2) — same strata as Python.
      const gb = Math.min(maps + 1, 4) - 1;
      // Tied flag: level series are slower (~31.3 kills when tied vs ~33.4
      // when a side leads) — same strata as Python.
      const tb = aWins === bWins ? 1 : 0;
      const probs = table[winner][b][gb][tb];
      let u = rng();
      let cell = probs.length - 1;
      for (let i = 0; i < probs.length; i++) {
        u -= probs[i];
        if (u <= 0) {
          cell = i;
          break;
        }
      }
      const nCombos = 8;
      const kb = Math.floor(cell / nCombos);
      const combo = cell % nCombos;
      const [lo, hi] = buckets[kb];
      const k = lo + Math.floor(rng() * (hi - lo + 1));
      if (maps === 0) {
        map1 = { fb: combo & 1, fd: (combo >> 1) & 1, ft: (combo >> 2) & 1 };
      }
      if (winner === 'A') aWins++;
      else bWins++;
      kills += k;
      maps++;
    }
    out.push({ winner: aWins === need ? 'A' : 'B', aWins, bWins, maps, kills, map1 });
  }
  return out;
}

/* ------------------------------------------------------------- legs */

export type RelatedLeg =
  | { kind: 'series'; team: 'A' | 'B' }
  | { kind: 'kills'; dir: 'over' | 'under'; line: number }
  | { kind: 'maps'; dir: 'over' | 'under'; line: number }
  | { kind: 'first'; obj: 'fb' | 'fd' | 'ft'; team: 'A' | 'B' };

export function legKey(leg: RelatedLeg): string {
  return JSON.stringify(leg);
}

export function legLabel(leg: RelatedLeg, teamA: string, teamB: string): string {
  switch (leg.kind) {
    case 'series':
      return `${leg.team === 'A' ? teamA : teamB} wins series`;
    case 'kills':
      return `${leg.dir === 'over' ? 'Over' : 'Under'} ${leg.line} total kills (series)`;
    case 'maps':
      return `${leg.dir === 'over' ? 'Over' : 'Under'} ${leg.line} maps`;
    case 'first': {
      const obj = leg.obj === 'fb' ? 'first blood' : leg.obj === 'fd' ? 'first dragon' : 'first tower';
      return `${leg.team === 'A' ? teamA : teamB} ${obj} (map 1)`;
    }
  }
}

export function legSatisfied(sim: SimSeries, leg: RelatedLeg): boolean {
  switch (leg.kind) {
    case 'series':
      return sim.winner === leg.team;
    case 'kills':
      return leg.dir === 'over' ? sim.kills > leg.line : sim.kills < leg.line;
    case 'maps':
      return leg.dir === 'over' ? sim.maps > leg.line : sim.maps < leg.line;
    case 'first': {
      const v = leg.obj === 'fb' ? sim.map1.fb : leg.obj === 'fd' ? sim.map1.fd : sim.map1.ft;
      return leg.team === 'A' ? v === 1 : v === 0;
    }
  }
}

export interface ComboStats {
  joint: number;
  marginals: number[];
  naive: number;
  /** joint − naive, in percentage points. */
  adjustmentPp: number;
  /** (joint − naive) / naive, as a fraction. */
  adjustmentRel: number;
  /** Phi coefficient (2-leg combos only): Pearson correlation of the two binary legs. */
  phi: number | null;
}

/**
 * Raking weight for one simulated series: reweights the sim's maps marginal
 * (binomial, from Bernoulli winner draws) to the shipped p-conditional maps
 * model, so the joint sim's maps marginal matches the standalone total-maps
 * prop exactly. Without this, the sim would overstate P(long series) — the
 * same fixed-p-binomial deficit that made the binomial maps LL lose to the
 * empirical distribution out-of-sample.
 */
export function simMapWeight(nMaps: number, pA: number, bestOf: number): number {
  const cond = seriesMapsProbsConditional(pA, bestOf);
  const binom = seriesMapsProbs(pA, bestOf);
  return cond[String(nMaps)] / Math.max(binom[String(nMaps)], 1e-9);
}

export function weightedMean(values: number[], weights: number[]): number {
  const w = weights.reduce((a, b) => a + b, 0);
  if (w <= 0) return 0;
  return values.reduce((a, v, i) => a + v * weights[i], 0) / w;
}

export function weightedMedian(values: number[], weights: number[]): number {
  const pairs = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  const total = pairs.reduce((a, p) => a + p.w, 0);
  if (total <= 0) return 0;
  let acc = 0;
  for (const p of pairs) {
    acc += p.w;
    if (acc >= total / 2) return p.v;
  }
  return pairs[pairs.length - 1].v;
}

export function comboStats(sims: SimSeries[], legs: RelatedLeg[], pA: number, bestOf: number): ComboStats {
  const weights = sims.map((s) => simMapWeight(s.maps, pA, bestOf));
  const wTot = weights.reduce((a, b) => a + b, 0) || 1;
  const marginals = legs.map((leg) => {
    let c = 0;
    for (let i = 0; i < sims.length; i++) if (legSatisfied(sims[i], leg)) c += weights[i];
    return c / wTot;
  });
  let jointW = 0;
  for (let i = 0; i < sims.length; i++) {
    if (legs.every((leg) => legSatisfied(sims[i], leg))) jointW += weights[i];
  }
  const joint = jointW / wTot;
  const naive = marginals.reduce((a, m) => a * m, 1);
  let phi: number | null = null;
  if (legs.length === 2) {
    const [p1, p2] = marginals;
    const denom = Math.sqrt(p1 * (1 - p1) * p2 * (1 - p2));
    phi = denom > 1e-9 ? (joint - p1 * p2) / denom : 0;
  }
  return {
    joint,
    marginals,
    naive,
    adjustmentPp: (joint - naive) * 100,
    adjustmentRel: naive > 1e-9 ? (joint - naive) / naive : 0,
    phi,
  };
}

/* ------------------------------------------------- candidates + reasons */

export interface Candidate {
  legs: RelatedLeg[];
  stats: ComboStats;
  reason: string;
}

function otherSide(side: 'A' | 'B'): 'A' | 'B' {
  return side === 'A' ? 'B' : 'A';
}

function reasonFor(
  legs: RelatedLeg[],
  stats: ComboStats,
  pA: number,
  teamA: string,
  teamB: string,
): string {
  const fav = pA >= 0.5 ? 'A' : 'B';
  const favName = fav === 'A' ? teamA : teamB;
  const dogName = fav === 'A' ? teamB : teamA;
  const sign = stats.adjustmentPp >= 0 ? 'positive' : 'negative';
  const kinds = legs.map((l) => l.kind).join('+');
  const seriesLeg = legs.find((l) => l.kind === 'series') as
    | { kind: 'series'; team: 'A' | 'B' }
    | undefined;
  const sideName = (s: 'A' | 'B') => (s === 'A' ? teamA : teamB);

  if (kinds === 'series+kills' && seriesLeg) {
    return stats.adjustmentPp >= 0
      ? `${sideName(seriesLeg.team)} winning tends to come with more kills, so these legs reinforce each other — the true joint price is higher than the independent product.`
      : `${sideName(seriesLeg.team)} winning tends to come with fewer kills, so these legs fight each other — the true joint price is lower than the independent product.`;
  }
  if (kinds === 'series+maps' && seriesLeg) {
    const isFav = seriesLeg.team === fav;
    if (stats.adjustmentPp >= 0) {
      return isFav
        ? `${favName} is the favorite, but when a series goes long the underdog ${dogName} gets more chances — a long series and a ${favName} win still land together more often than independence says.`
        : `When the underdog ${sideName(seriesLeg.team)} wins, the series usually goes the distance — a long series and an upset go together, so the joint price beats the independent product.`;
    }
    return isFav
      ? `${favName} wins are usually stomps (fewer maps), so a favorite win and a long series fight each other — the joint price is below the independent product.`
      : `An upset win for ${sideName(seriesLeg.team)} usually needs a long series, so a short series and an upset win fight each other.`;
  }
  if (kinds === 'series+first' && seriesLeg) {
    const first = legs.find((l) => l.kind === 'first') as { kind: 'first'; obj: string; team: 'A' | 'B' };
    const obj = first.obj === 'fb' ? 'first blood' : first.obj === 'fd' ? 'first dragon' : 'first tower';
    const sameSide = first.team === seriesLeg.team;
    if (stats.adjustmentPp >= 0) {
      return sameSide
        ? `Grabbing ${obj} in map 1 and winning the series go together for ${sideName(seriesLeg.team)} — early control snowballs, so the joint price beats independence.`
        : `The series winner often still drops map 1's ${obj} — but the ${sign} correlation means the combo is priced ${stats.adjustmentPp >= 0 ? 'above' : 'below'} the independent product.`;
    }
    return sameSide
      ? `${sideName(seriesLeg.team)} can win the series without map 1's ${obj}, so the legs are less aligned than independence assumes.`
      : `Map 1's ${obj} for ${sideName(first.team)} and a ${sideName(seriesLeg.team)} series win pull in opposite directions.`;
  }
  if (kinds === 'maps+kills') {
    return stats.adjustmentPp >= 0
      ? `Long series produce more total kills — more maps means more chances to fight, so the joint price beats independence.`
      : `This maps/kills direction is unusual: the sim says these legs fight each other slightly.`;
  }
  if (kinds === 'first+first') {
    return stats.adjustmentPp >= 0
      ? `First objectives in map 1 cluster: a team that takes one early objective usually takes the others too.`
      : `These two map-1 firsts rarely land together in the sim.`;
  }
  return `These legs are ${sign}ly correlated (adjustment ${stats.adjustmentPp >= 0 ? '+' : ''}${stats.adjustmentPp.toFixed(1)}pp vs independent).`;
}

/**
 * The ranked "Watch out for" candidate menu for a matchup: 2-leg related
 * combos built from the leg vocabulary. Exact-score legs are deliberately
 * excluded — exact score is nested inside series winner, so its
 * "correlation" is structural, not insight.
 */
export function buildCandidates(
  teamA: string,
  teamB: string,
  bestOf: number,
  sims: SimSeries[],
  pA: number,
): Candidate[] {
  // Series-kills line: nearest .5 to the sim median (where the book line sits).
  // Weighted (raked) median, so the line matches the raked sim marginals.
  const weights = sims.map((s) => simMapWeight(s.maps, pA, bestOf));
  const median = weightedMedian(
    sims.map((s) => s.kills),
    weights,
  );
  const killsLine = Math.floor(median) + 0.5;
  const mapsLine = bestOf >= 5 ? 3.5 : bestOf === 3 ? 2.5 : 0.5;

  const pair = (l1: RelatedLeg, l2: RelatedLeg): Candidate => {
    const stats = comboStats(sims, [l1, l2], pA, bestOf);
    return { legs: [l1, l2], stats, reason: reasonFor([l1, l2], stats, pA, teamA, teamB) };
  };
  const out: Candidate[] = [];
  (['A', 'B'] as const).forEach((side) => {
    const opp = otherSide(side);
    const series: RelatedLeg = { kind: 'series', team: side };
    out.push(pair(series, { kind: 'kills', dir: 'over', line: killsLine }));
    out.push(pair(series, { kind: 'kills', dir: 'under', line: killsLine }));
    if (bestOf > 1) {
      out.push(pair(series, { kind: 'maps', dir: 'over', line: mapsLine }));
      out.push(pair(series, { kind: 'maps', dir: 'under', line: mapsLine }));
    }
    out.push(pair(series, { kind: 'first', obj: 'fd', team: side }));
    out.push(pair(series, { kind: 'first', obj: 'fb', team: side }));
    out.push(pair(series, { kind: 'first', obj: 'ft', team: side }));
    out.push(pair(series, { kind: 'first', obj: 'fd', team: opp }));
  });
  if (bestOf > 1) {
    out.push(pair({ kind: 'maps', dir: 'over', line: mapsLine }, { kind: 'kills', dir: 'over', line: killsLine }));
    out.push(pair({ kind: 'maps', dir: 'over', line: mapsLine }, { kind: 'kills', dir: 'under', line: killsLine }));
    out.push(pair({ kind: 'maps', dir: 'under', line: mapsLine }, { kind: 'kills', dir: 'over', line: killsLine }));
    out.push(pair({ kind: 'maps', dir: 'under', line: mapsLine }, { kind: 'kills', dir: 'under', line: killsLine }));
  }
  (['A', 'B'] as const).forEach((side) => {
    out.push(pair({ kind: 'first', obj: 'fd', team: side }, { kind: 'first', obj: 'fb', team: side }));
  });
  return out;
}

/** Rank candidates: entries with book odds first (by edge desc), then the rest by |adjustment|. */
export function rankCandidates(
  candidates: Candidate[],
  bookOdds: Record<string, number>,
): { candidate: Candidate; key: string; edge: number | null }[] {
  const withEdge: { candidate: Candidate; key: string; edge: number | null }[] = [];
  const without: { candidate: Candidate; key: string; edge: number | null }[] = [];
  for (const c of candidates) {
    const key = c.legs.map(legKey).sort().join('|');
    const odds = bookOdds[key];
    const edge = odds !== undefined && odds > 1 ? c.stats.joint - 1 / odds : null;
    const row = { candidate: c, key, edge };
    if (edge !== null) withEdge.push(row);
    else without.push(row);
  }
  withEdge.sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0));
  without.sort(
    (a, b) => Math.abs(b.candidate.stats.adjustmentPp) - Math.abs(a.candidate.stats.adjustmentPp),
  );
  return [...withEdge, ...without];
}

/** Tappable suggestions after a first leg: candidates containing it, by |adjustment|. */
export function suggestFor(firstLeg: RelatedLeg, candidates: Candidate[]): Candidate[] {
  const key = legKey(firstLeg);
  return candidates
    .filter((c) => c.legs.some((l) => legKey(l) === key))
    .sort((a, b) => Math.abs(b.stats.adjustmentPp) - Math.abs(a.stats.adjustmentPp))
    .slice(0, 4);
}
