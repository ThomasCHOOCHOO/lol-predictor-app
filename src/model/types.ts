/** Types mirroring model/phone_artifacts.json (model_version 1.x, read dynamically). */

/** Calibration map selector (v1.4.0 Phase 1, Wave 2 — Model tab toggle).
 *  'standard' = shipped v1.3.2 map (fit on the Jul–Oct tail, graded on those
 *  same games — its ~0 ECE is in-sample, not quality). 'honest' = map fit on
 *  Jul–Aug only, graded on untouched Sep games. Same model, same features —
 *  only the final raw-score → probability mapping changes. */
export type CalibrationMode = 'standard' | 'honest';

export interface CalibrationMap {
  xs: number[];
  ys: number[];
  x_min: number;
  x_max: number;
  y_min: number;
  y_max: number;
}

export interface ModelJson {
  model_type: string;
  features: string[];
  coef: number[];
  intercept: number;
  scaler_mean: number[];
  scaler_scale: number[];
  calibration: CalibrationMap;
  /** Honest map, when the artifact carries it (v1.4.0+). Older artifacts
   *  resolve it from the bundled src/data/honest_calibration.json. */
  calibration_honest?: CalibrationMap;
}

export interface LiveModelJson {
  model_type: string;
  features: string[]; // ["pre_logit", "golddiff_k", "killdiff"] — no scaler
  coef: number[];
  intercept: number;
  calibration: CalibrationMap;
}

/** Live variant A (role-gold) model. No calibration map exists for A yet —
 *  the research export carries metrics only — so liveProbaA returns the RAW
 *  prob and the UI must label it uncalibrated. */
export interface LiveModelAJson {
  features: string[]; // ["pre_logit", "top_gold", "jng_gold", "mid_gold", "bot_gold", "sup_gold", "killdiff"]
  coef: number[];
  intercept: number;
}

export interface TeamRecord {
  elo: number; // roster-adjusted (what predictions use)
  elo_raw: number; // pre-adjustment snapshot Elo
  roster_delta: number;
  form: number; // trailing-20 win rate (comfort fallback only since v1.3.0)
  eg_gold: number; // trailing-20 mean own-side gold diff at 15, shrunk (v1.3.0+)
  turnover_2025_2026: number | null;
  roster_2025: string[];
  roster_2026: string[];
}

export interface CalibrationBin {
  bin: number;
  pred_range: [number, number];
  mean_pred: number;
  observed_acc: number;
  n: number;
}

export interface Artifacts {
  model_version: string;
  snapshot_date: string;
  generated_at: string;
  models: { full: ModelJson; nodraft: ModelJson };
  /** v1.3+: per-bucket live in-game models, keyed "10" | "15" | "20" | "25". */
  live_models?: Record<string, LiveModelJson>;
  blue_edge: number;
  teams: Record<string, TeamRecord>;
  team_aliases: Record<string, string>;
  // v1.0: flat {champ: power}. v1.2+: per-patch tables + current_patch.
  champion_power: Record<string, number> | Record<string, Record<string, number>>;
  champion_power_by_patch?: Record<string, Record<string, number>>;
  recent_patches?: string[];
  current_patch?: string;
  champions: string[];
  team_champion_comfort: Record<string, Record<string, number>>;
  roster_formula: string;
  calibration_table: CalibrationBin[];
  calibration_note: string;
  backtests: Record<string, { n: number; accuracy: number; log_loss: number; note: string }>;
  metrics: {
    holdout_n: number;
    holdout_accuracy: number;
    holdout_ece: number;
    holdout_ece_note: string;
    holdout_period: [string, string];
  };
}

export interface DraftInput {
  bluePicks: string[]; // display names, e.g. "Aatrox"
  redPicks: string[];
  blueBans: string[];
  redBans: string[];
}

export interface PredictionResult {
  blue: string;
  red: string;
  pBlue: number; // calibrated P(blue wins)
  pBlueRaw: number; // pre-calibration
  mode: 'predraft' | 'draft';
  patch: string | null; // patch used for champion power (draft mode)
  features: Record<string, number>;
  /** Calibration map this prediction was computed with. */
  calibration: CalibrationMode;
}

/** One entry of the bundled src/data/honest_calibration.json. */
export interface HonestCalibrationEntry {
  xs: number[];
  ys: number[];
  fitted_on: string;
  n: number;
  honest_eval: { logloss: number; ece: number; n: number };
  raw_eval: { logloss: number; ece: number };
  shipped_style_in_sample: { logloss: number; ece: number; n: number; note: string };
  n_steps: number;
}
