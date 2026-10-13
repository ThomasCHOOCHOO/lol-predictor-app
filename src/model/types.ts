/** Types mirroring model/phone_artifacts.json (model_version 1.x, read dynamically). */

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
}

export interface TeamRecord {
  elo: number; // roster-adjusted (what predictions use)
  elo_raw: number; // pre-adjustment snapshot Elo
  roster_delta: number;
  form: number;
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
}
