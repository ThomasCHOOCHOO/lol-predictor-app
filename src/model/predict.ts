import {
  BLUE_EDGE,
  COMFORT,
  MODELS,
  TEAMS,
  calibrationFor,
  championPower,
  hasChampionPower,
  teamComfort,
} from './artifacts';
import type { CalibrationBin, CalibrationMap, CalibrationMode, DraftInput, ModelJson, PredictionResult } from './types';

export type EloField = 'elo' | 'elo_raw'; // 'elo' = roster-adjusted (app default)

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Pure-TS replica of the sklearn IsotonicRegression(out_of_bounds="clip") map
 * from src/export_artifacts.py: clip p_raw to [x_min, x_max], linear-interp
 * over (xs, ys) with bisect_right semantics, clip to [1e-6, 1-1e-6].
 */
export function isotonicCalibrate(pRaw: number, cal: CalibrationMap): number {
  const p = Math.min(Math.max(pRaw, cal.x_min), cal.x_max);
  const { xs, ys } = cal;
  let y: number;
  if (p <= xs[0]) {
    y = ys[0];
  } else if (p >= xs[xs.length - 1]) {
    y = ys[ys.length - 1];
  } else {
    // bisect_right(xs, p) - 1
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= p) lo = mid + 1;
      else hi = mid;
    }
    const i = lo - 1;
    const x0 = xs[i];
    const x1 = xs[i + 1];
    const y0 = ys[i];
    const y1 = ys[i + 1];
    y = x1 > x0 ? y0 + ((p - x0) * (y1 - y0)) / (x1 - x0) : y0;
  }
  return Math.min(Math.max(y, 1e-6), 1 - 1e-6);
}

/**
 * Feature math mirrors src/predict.py::predict_game + draft_features exactly:
 *   elo_diff    = elo(blue) - elo(red)
 *   eg_gold_diff = eg_gold(blue) - eg_gold(red)  (v1.3.0+; replaces form_diff)
 *   blue_edge   = trailing-90d global blue-side win rate (constant in artifact)
 *   d_power     = sum(power(blue picks)) - sum(power(red picks))
 *   d_comfort   = sum(comfort(blue, c)) - sum(comfort(red, c)); missing -> team form
 *   ban_edge    = sum(power(champs banned BY blue)) - sum(power(banned BY red))
 * Unknown champions fall back to 0.5 power (same as Python .get(c, 0.5)).
 */
export function computeFeatures(
  blue: string,
  red: string,
  draft: DraftInput | null,
  patch: string,
  eloField: EloField,
): Record<string, number> {
  const tb = TEAMS[blue];
  const tr = TEAMS[red];
  const eb = tb ? tb[eloField] : 1500.0;
  const er = tr ? tr[eloField] : 1500.0;
  const gb = tb ? tb.eg_gold : 0.0;
  const gr = tr ? tr.eg_gold : 0.0;
  const fb = tb ? tb.form : 0.5; // comfort fallback only (not a model feature)
  const fr = tr ? tr.form : 0.5;

  const feats: Record<string, number> = {
    elo_diff: eb - er,
    eg_gold_diff: gb - gr,
    blue_edge: BLUE_EDGE,
  };

  if (draft) {
    const power = (names: string[]) =>
      names.reduce((s, n) => s + (hasChampionPower(n, patch) ? championPower(n, patch) : 0.5), 0);
    const comfort = (team: string, names: string[], f: number) =>
      names.reduce((s, n) => s + teamComfort(team, n, f), 0);
    feats.d_power = power(draft.bluePicks) - power(draft.redPicks);
    feats.d_comfort = comfort(blue, draft.bluePicks, fb) - comfort(red, draft.redPicks, fr);
    feats.ban_edge = power(draft.blueBans) - power(draft.redBans);
  }
  return feats;
}

export function predictProba(
  features: Record<string, number>,
  model: ModelJson,
  mode: CalibrationMode = 'standard',
  modelKey: 'full' | 'nodraft' = 'full',
): { pRaw: number; pCal: number } {
  let z = model.intercept;
  for (let i = 0; i < model.features.length; i++) {
    const f = features[model.features[i]];
    z += ((f - model.scaler_mean[i]) / model.scaler_scale[i]) * model.coef[i];
  }
  const pRaw = sigmoid(z);
  return { pRaw, pCal: isotonicCalibrate(pRaw, calibrationFor(modelKey, mode)) };
}

export interface PredictOptions {
  eloField?: EloField;
  patch?: string; // required for draft mode; pre-draft ignores champion power
  /** Calibration map selector — the Model tab toggle. Default 'standard'. */
  calibration?: CalibrationMode;
}

/** Full pipeline: features -> standardized logistic regression -> isotonic calibration. */
export function predictMatchup(
  blue: string,
  red: string,
  draft: DraftInput | null,
  opts: PredictOptions = {},
): PredictionResult {
  const eloField = opts.eloField ?? 'elo';
  const calibration = opts.calibration ?? 'standard';
  const modelKey = draft ? 'full' : 'nodraft';
  const model = draft ? MODELS.full : MODELS.nodraft;
  const feats = computeFeatures(blue, red, draft, opts.patch ?? 'all', eloField);
  const { pRaw, pCal } = predictProba(feats, model, calibration, modelKey);
  return {
    blue,
    red,
    pBlue: pCal,
    pBlueRaw: pRaw,
    mode: draft ? 'draft' : 'predraft',
    patch: draft ? (opts.patch ?? null) : null,
    features: feats,
    calibration,
  };
}

/** Honesty note: calibration bin containing p -> observed holdout accuracy. */
export function honestyNote(p: number, table: CalibrationBin[]): string {
  let bin = table[table.length - 1];
  for (const b of table) {
    if (p < b.pred_range[1] || b === table[table.length - 1]) {
      bin = b;
      break;
    }
  }
  const lo = Math.round(bin.pred_range[0] * 100);
  const hi = Math.round(bin.pred_range[1] * 100);
  const obs = Math.round(bin.observed_acc * 100);
  return `when the model said ${lo}–${hi}%, that side won ${obs}% of ${bin.n.toLocaleString()} holdout games`;
}

function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/**
 * P(a team wins a best-of-N series) from its per-map win prob p.
 * Assumes independent maps with fixed p (same as Python series_prob).
 * bestOf <= 1 (or non-integer) returns p unchanged.
 */
export function seriesProb(p: number, bestOf: number): number {
  if (!Number.isFinite(p)) return p;
  if (!Number.isInteger(bestOf) || bestOf <= 1) return p;
  const need = Math.floor(bestOf / 2) + 1;
  let s = 0;
  for (let k = need; k <= bestOf; k++) {
    s += binom(bestOf, k) * Math.pow(p, k) * Math.pow(1 - p, bestOf - k);
  }
  return Math.min(Math.max(s, 0), 1);
}

export interface SeriesConversion {
  /** P(first team wins one map as blue). */
  pMapAsBlue: number;
  /** P(first team wins one map as red). */
  pMapAsRed: number;
  /** Side-averaged per-map prob (sides alternate in a real series). */
  pNeutral: number;
  /** P(first team wins the best-of-N series) from the neutral per-map prob. */
  pSeries: number;
}

/**
 * Pre-draft series conversion for a matchup (first vs second).
 *
 * A real series doesn't let one team stay on blue every map — sides
 * alternate (loser picks) — so the series prob is built from the
 * side-averaged per-map prob, NOT from one orientation's per-map prob.
 * E.g. KC vs C9: 70% as blue / 60% as red -> neutral 65% -> Bo5 76%,
 * not the 84% a naive binomial on 70% would give.
 *
 * Only valid pre-draft (draft=null); draft mode stays per-map.
 */
export function seriesConversion(
  first: string,
  second: string,
  bestOf: number,
  calibration: CalibrationMode = 'standard',
): SeriesConversion {
  const asBlue = predictMatchup(first, second, null, { calibration }).pBlue;
  const asRed = 1 - predictMatchup(second, first, null, { calibration }).pBlue;
  const neutral = (asBlue + asRed) / 2;
  return { pMapAsBlue: asBlue, pMapAsRed: asRed, pNeutral: neutral, pSeries: seriesProb(neutral, bestOf) };
}

export { COMFORT };
