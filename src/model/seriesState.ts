/**
 * Stateful series model (v1.4.0 Phase 1) — spec: reports/series_state_design.md.
 *
 * Replaces the binomial series conversion for any series that has STARTED.
 * The Predict tab keeps the binomial for pre-series predictions; this module
 * engages once games are being played (Live tab).
 *
 * Model: a series holds a posterior over a latent neutral-ground logit
 * advantage Δ ~ N(μ, 1/λ) for team A over team B. After each map, one
 * Bayesian update (one Newton step on the log-posterior) moves μ toward the
 * surprise, with the live model's closing estimate entering as a WEIGHT
 * (how much the game counts), never as a second observation.
 *
 * Team A is fixed for the whole series: the first-listed team (the match's
 * blueCode team). All probs in this module are P(A wins ...).
 */

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function logit(p: number): number {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
}

/** P(loser of a game takes blue next game). Fitted: 1,798 transitions,
 *  2024–2026 (design §7.4). The Play-In "winner stays blue" pattern (7/8)
 *  was a small-sample fluke — do not use it. */
export const LOSER_BLUE_PROB = 0.622;

/** Prior SD of Δ before map 1. One map moves μ by ~0.1 logit at this value. */
export const SIGMA0_DEFAULT = 0.5;

/**
 * Previous-map-winner coefficient (logit). Fitted value from the momentum
 * analysis: +0.284 vs the current-Elo control, SHRUNK to half (+0.14) for
 * shipping because the mechanism is unidentified (psychological momentum vs
 * latent form vs draft adaptation) and the out-of-sample gain is small.
 *
 * ⚠️ PENDING VALIDATION: a separate validation is checking this coefficient
 * on Worlds 2026 Play-In + Swiss games 2+ (pre-registered: log-loss lift
 * must be > 0). If that validation fails, this coefficient must be removed
 * (set to 0) — do not "re-tune" it to fit the validation set.
 */
export const PREV_WIN_COEF = 0.14;

export interface SeriesGameRecord {
  gameNumber: number;
  /** True if team A won this map. */
  winnerA: boolean;
  /** Stateful per-map prob used for this game (pre-game state, A perspective). */
  pMap: number;
  /** Live model's closing estimate P(A wins), last in-game frame. */
  closingC: number;
  /** True if team A was blue in this game. */
  blueA: boolean;
  draftLift: number;
  picksA: string[];
  picksB: string[];
}

export interface SeriesState {
  teamA: string;
  teamB: string;
  bestOf: number;
  need: number;
  /** Maps won by A / B so far. */
  a: number;
  b: number;
  /** Posterior over Δ (A's neutral-ground logit advantage). */
  mu: number;
  lambda: number;
  /** Pre-series neutral per-map prob (kept so the posterior can be
   *  restarted from the prior at the live score after a multi-game gap). */
  pNeutral: number;
  /** Side logit bonus for A (fixed for the series, from the pre-series model). */
  s: number;
  /** Score-state momentum γ[a,b] (default: all 0 — use prevWinCoef instead). */
  gamma: Record<string, number>;
  /** Streak term coefficient (default 0 — use prevWinCoef instead). */
  delta: number;
  /** Previous-map-winner coefficient (default PREV_WIN_COEF). */
  prevWinCoef: number;
  /** +1 if A won the last map, -1 if B won it, 0 before game 1. */
  prevWin: number;
  /** Net consecutive wins: +n if A won the last n, -n if B won the last n. */
  streakA: number;
  /** Fearless pool-depletion coefficient (default 0 — not yet fitted). */
  lambdaPool: number;
  /** Net burned comfort champions (depl_A - depl_B); see computeDeplNet. */
  deplNet: number;
  /** Side of the next game, when known. Null = unknown (side term 0). */
  nextBlue: 'A' | 'B' | null;
  /** Champions used per team so far (Fearless pool tracking). */
  usedChamps: Record<string, string[]>;
  history: SeriesGameRecord[];
  /** Highest game number whose outcome is folded into this state — either
   *  recorded in history, or covered by a restart at the live score (see
   *  reconcileSeries). Prevents re-processing restart-covered games. */
  accountedThrough: number;
}

export interface SeriesParams {
  sigma0?: number;
  prevWinCoef?: number;
  gamma?: Record<string, number>;
  delta?: number;
  lambdaPool?: number;
  loserBlueProb?: number;
}

export function initSeries(
  teamA: string,
  teamB: string,
  bestOf: number,
  pNeutral: number,
  s: number,
  params: SeriesParams = {},
): SeriesState {
  const sigma0 = params.sigma0 ?? SIGMA0_DEFAULT;
  return {
    teamA,
    teamB,
    bestOf,
    need: Math.floor(bestOf / 2) + 1,
    a: 0,
    b: 0,
    mu: logit(pNeutral),
    lambda: 1 / (sigma0 * sigma0),
    pNeutral,
    s,
    gamma: params.gamma ?? {},
    delta: params.delta ?? 0,
    prevWinCoef: params.prevWinCoef ?? PREV_WIN_COEF,
    prevWin: 0,
    streakA: 0,
    lambdaPool: params.lambdaPool ?? 0,
    deplNet: 0,
    nextBlue: null,
    usedChamps: { [teamA]: [], [teamB]: [] },
    history: [],
    accountedThrough: 0,
  };
}

function sideTerm(state: SeriesState, blueA: boolean | null): number {
  if (blueA === null) return 0;
  return blueA ? state.s : -state.s;
}

/** Per-map win prob P(A wins) from an explicit game context. */
function mapWinProbFrom(
  state: SeriesState,
  a: number,
  b: number,
  blueA: boolean | null,
  prevWin: number,
  streakA: number,
  draftLift: number,
): number {
  const gamma = state.gamma[`${a},${b}`] ?? 0;
  const z =
    state.mu +
    sideTerm(state, blueA) +
    gamma +
    state.delta * streakA +
    state.prevWinCoef * prevWin +
    draftLift -
    state.lambdaPool * state.deplNet;
  return sigmoid(z);
}

/** P(A wins the NEXT map) from the current state. draftLift = 0 until a
 *  draft source exists in the Live tab. */
export function mapWinProb(state: SeriesState, draftLift = 0): number {
  const blueA = state.nextBlue === null ? null : state.nextBlue === 'A';
  return mapWinProbFrom(state, state.a, state.b, blueA, state.prevWin, state.streakA, draftLift);
}

type DpKey = string;

/** Backward induction over (score, next side, prevWin, streak). (μ, λ) and
 *  the streak/depletion terms are held fixed during lookahead, per the
 *  design — the update happens for real after each map. prevWin evolves
 *  exactly because it is first-order path information and cheap. */
function dpValue(
  state: SeriesState,
  a: number,
  b: number,
  blueA: boolean,
  prevWin: number,
  streakA: number,
  memo: Map<DpKey, number>,
  loserBlueProb: number,
): number {
  if (a >= state.need) return 1;
  if (b >= state.need) return 0;
  const key = `${a},${b},${blueA ? 1 : 0},${prevWin},${streakA}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  // Future games have neutral drafts in expectation (draftLift = 0).
  const p = mapWinProbFrom(state, a, b, blueA, prevWin, streakA, 0);
  const nextStreakA = streakA > 0 ? streakA + 1 : 1;
  const nextStreakB = streakA < 0 ? streakA - 1 : -1;
  // A wins: loser (B) takes blue w.p. π.
  const vA =
    (1 - loserBlueProb) * dpValue(state, a + 1, b, true, 1, nextStreakA, memo, loserBlueProb) +
    loserBlueProb * dpValue(state, a + 1, b, false, 1, nextStreakA, memo, loserBlueProb);
  // B wins: loser (A) takes blue w.p. π.
  const vB =
    loserBlueProb * dpValue(state, a, b + 1, true, -1, nextStreakB, memo, loserBlueProb) +
    (1 - loserBlueProb) * dpValue(state, a, b + 1, false, -1, nextStreakB, memo, loserBlueProb);
  const v = p * vA + (1 - p) * vB;
  memo.set(key, v);
  return v;
}

/** P(A wins the series) from the current state. Replaces the binomial for
 *  any series that has started. With an unknown next side, the first step
 *  averages over both sides 50/50; later steps use the loser-takes-blue
 *  transition (π = 0.622). */
export function seriesWinProb(state: SeriesState, loserBlueProb = LOSER_BLUE_PROB): number {
  if (state.a >= state.need) return 1;
  if (state.b >= state.need) return 0;
  const memo = new Map<DpKey, number>();
  if (state.nextBlue !== null) {
    return dpValue(state, state.a, state.b, state.nextBlue === 'A', state.prevWin, state.streakA, memo, loserBlueProb);
  }
  const blueA = dpValue(state, state.a, state.b, true, state.prevWin, state.streakA, memo, loserBlueProb);
  const redA = dpValue(state, state.a, state.b, false, state.prevWin, state.streakA, memo, loserBlueProb);
  return (blueA + redA) / 2;
}

export interface RecordGameInput {
  gameNumber: number;
  /** True if team A won this map. */
  winnerA: boolean;
  /** Live model's closing estimate P(A wins) from the last in-game frame.
   *  Defaults to 0.5 (neutral weight) when unavailable. */
  closingC?: number;
  /** True if team A was blue in this game. */
  blueA: boolean;
  draftLift?: number;
  /** Champions picked by each team in this game (Fearless tracking). */
  picksA?: string[];
  picksB?: string[];
  /** deplNet applicable to the NEXT game (recomputed after adding picks).
   *  When omitted, the current deplNet carries over. */
  nextDeplNet?: number;
}

/**
 * Apply one completed map (design §5). Returns a NEW state (immutable).
 *
 * p̂ uses the PRE-game state (score, side, momentum, draft, depletion), so
 * the update attributes to μ only what those terms don't explain. The
 * closing estimate c sets the weight w = 0.5 + |c − 0.5| — a decisive game
 * counts more than a coin-flip game. It is never a second observation.
 *
 * No-ops (returns the state unchanged) if the series is already terminal
 * or this game number is already in history — recording is idempotent,
 * so the Live tab can safely re-reconcile on every poll.
 */
export function recordGame(state: SeriesState, input: RecordGameInput): SeriesState {
  if (state.a >= state.need || state.b >= state.need) return state;
  if (state.history.some((h) => h.gameNumber === input.gameNumber)) return state;
  const draftLift = input.draftLift ?? 0;
  const pHat = mapWinProbFrom(
    state,
    state.a,
    state.b,
    input.blueA,
    state.prevWin,
    state.streakA,
    draftLift,
  );
  const c = Math.min(Math.max(input.closingC ?? 0.5, 0), 1);
  const w = 0.5 + Math.abs(c - 0.5);
  const y = input.winnerA ? 1 : 0;
  const lambdaNext = state.lambda + w * pHat * (1 - pHat);
  const muNext = state.mu + (w * (y - pHat)) / lambdaNext;
  const picksA = input.picksA ?? [];
  const picksB = input.picksB ?? [];
  const usedA = [...(state.usedChamps[state.teamA] ?? [])];
  const usedB = [...(state.usedChamps[state.teamB] ?? [])];
  for (const ch of picksA) if (!usedA.includes(ch)) usedA.push(ch);
  for (const ch of picksB) if (!usedB.includes(ch)) usedB.push(ch);
  return {
    ...state,
    a: state.a + (input.winnerA ? 1 : 0),
    b: state.b + (input.winnerA ? 0 : 1),
    mu: muNext,
    lambda: lambdaNext,
    prevWin: input.winnerA ? 1 : -1,
    streakA: input.winnerA
      ? state.streakA > 0
        ? state.streakA + 1
        : 1
      : state.streakA < 0
        ? state.streakA - 1
        : -1,
    deplNet: input.nextDeplNet ?? state.deplNet,
    nextBlue: null, // unknown until the next game's sides arrive
    usedChamps: { [state.teamA]: usedA, [state.teamB]: usedB },
    accountedThrough: Math.max(state.accountedThrough, input.gameNumber),
    history: [
      ...state.history,
      {
        gameNumber: input.gameNumber,
        winnerA: input.winnerA,
        pMap: pHat,
        closingC: c,
        blueA: input.blueA,
        draftLift,
        picksA,
        picksB,
      },
    ],
  };
}

/** Set the next game's side once it is known (from the new game's sides).
 *  Returns a new state. */
export function withNextBlue(state: SeriesState, side: 'A' | 'B' | null): SeriesState {
  if (state.nextBlue === side) return state;
  return { ...state, nextBlue: side };
}
