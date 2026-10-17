"""Generate the small Wave 2 data files for the app (v1.4.0 Phase 1, Wave 2).

READ-ONLY against the model repo: nothing under ~/workspace/lol-worlds-model
is written. Outputs land in this repo under src/data/.

Provenance — the app's shipped phone_artifacts.json is v1.3.2, so the honest
maps MUST be built from the v1.3.2 bundle, not from the model repo's current
model.joblib (which the region-offsets work has retrained on elo_diff_adj)
or model/honest_calibration.json (same reason: it belongs to the in-progress
1.4.0 model). The v1.3.2 bundle is model.joblib.bak-pre-region-offsets.
When the 1.4.0 artifact ships, regenerate from the new bundle — and only
then does the model repo's honest_calibration.json become the right source.

Outputs:
  src/data/honest_calibration.json — {full, nodraft} honest maps + eval
    numbers for the Model tab side-by-side table.
  src/data/player_gaps.json — {team: player_elo - team_elo} for the
    diagnostic flag.
  src/data/live_models_role_gold.json — variant A per-bucket
    {features, coef, intercept} (no calibration map exists for A yet —
    the research JSON carries metrics only, so the shadow display shows
    variant A's RAW prob, labeled uncalibrated).

Usage:
  cd ~/workspace/lol-predictor-app
  PYTHONPATH=~/workspace/lol-worlds-model/src \
    ~/workspace/lol-worlds-model/.venv/bin/python scripts/build_wave2_data.py
"""
import json
import os
import sys

import joblib
import pandas as pd

MODEL_REPO = os.path.expanduser("~/workspace/lol-worlds-model")
APP_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

sys.path.insert(0, os.path.join(MODEL_REPO, "src"))
from train import honest_map_from_bundle  # noqa: E402


def main() -> None:
    # ---- honest calibration maps (full + nodraft) from the v1.3.2 bundle ----
    bundle = joblib.load(os.path.join(MODEL_REPO, "model", "model.joblib.bak-pre-region-offsets"))
    assert bundle["features_full"][0] == "elo_diff", "backup bundle is not v1.3.2 (expected elo_diff)"
    df = pd.read_csv(
        os.path.join(MODEL_REPO, "data", "processed", "features.csv"), parse_dates=["date"]
    )
    df = df.sort_values("date").reset_index(drop=True)

    honest: dict = {}
    for key in ("full", "nodraft"):
        honest_json, report = honest_map_from_bundle(bundle, df, key)
        honest[key] = {
            "xs": honest_json["xs"],
            "ys": honest_json["ys"],
            "fitted_on": honest_json["fitted_on"],
            "n": honest_json["n"],
            "honest_eval": honest_json["honest_eval"],
            "raw_eval": report["raw_uncalibrated_on_eval"],
            "shipped_style_in_sample": report["shipped_style_in_sample_on_full_tail"],
            "n_steps": report["n_steps_coarsened"],
        }
        print(
            f"[{key}] honest map: {report['n_steps_coarsened']} steps, "
            f"honest logloss={honest_json['honest_eval']['logloss']:.4f} "
            f"ece={honest_json['honest_eval']['ece']:.4f} n={honest_json['honest_eval']['n']} | "
            f"raw logloss={report['raw_uncalibrated_on_eval']['logloss']:.4f}"
        )
    out = os.path.join(APP_REPO, "src", "data", "honest_calibration.json")
    with open(out, "w") as f:
        json.dump(honest, f, indent=2)
    print(f"wrote {out}")

    # ---- player gaps (diagnostic flag) ----
    with open(os.path.join(MODEL_REPO, "model", "player_ratings.json")) as f:
        ratings = json.load(f)
    gaps = {team: v["gap"] for team, v in ratings["teams"].items() if "gap" in v}
    out = os.path.join(APP_REPO, "src", "data", "player_gaps.json")
    with open(out, "w") as f:
        json.dump(gaps, f, indent=2, sort_keys=True)
    flagged = sum(1 for g in gaps.values() if abs(g) > 100)
    print(f"wrote {out} ({len(gaps)} teams, {flagged} with |gap| > 100)")

    # ---- live variant A coefficients ----
    with open(os.path.join(MODEL_REPO, "model", "live_models_role_gold.json")) as f:
        rg = json.load(f)
    variant_a = {}
    for bucket, b in rg.items():
        a = b["variants"]["A_roles"]
        variant_a[bucket] = {
            "features": a["features"],
            "coef": a["coef"],
            "intercept": a["intercept"],
        }
    out = os.path.join(APP_REPO, "src", "data", "live_models_role_gold.json")
    with open(out, "w") as f:
        json.dump(variant_a, f, indent=2)
    print(f"wrote {out} (buckets {sorted(variant_a)})")


if __name__ == "__main__":
    main()
