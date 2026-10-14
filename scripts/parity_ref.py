"""Reference implementation of the phone app's inference, in Python.

Mirrors src/model/predict.ts exactly (same JSON inputs, same math), so the
Node parity check can diff TS vs Python. Uses elo_raw by default so results
also match src/predict.py::predict_game (the CLI), which uses snapshot Elo;
the app itself defaults to roster-adjusted 'elo'.
"""
import json
import math
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(BASE, "src", "data", "phone_artifacts.json")


def load():
    with open(ART) as f:
        return json.load(f)


def power_tables(d):
    bpp = d.get("champion_power_by_patch")
    if bpp:
        cur = d.get("current_patch") or sorted(bpp)[-1]
        return bpp, cur
    cp = d["champion_power"]
    return {"all": cp}, "all"


def sigmoid(z):
    return 1.0 / (1.0 + math.exp(-z))


def calibrate(p_raw, cal):
    import bisect
    p = min(max(p_raw, cal["x_min"]), cal["x_max"])
    xs, ys = cal["xs"], cal["ys"]
    if p <= xs[0]:
        y = ys[0]
    elif p >= xs[-1]:
        y = ys[-1]
    else:
        i = bisect.bisect_right(xs, p) - 1
        x0, x1 = xs[i], xs[i + 1]
        y0, y1 = ys[i], ys[i + 1]
        y = y0 + (p - x0) * (y1 - y0) / (x1 - x0) if x1 > x0 else y0
    return min(max(y, 1e-6), 1 - 1e-6)


def predict(d, blue, red, draft, patch, elo_field="elo_raw"):
    tables, _ = power_tables(d)
    table = tables[patch] if patch in tables else tables[next(iter(tables))]
    tb, tr = d["teams"][blue], d["teams"][red]
    feats = {
        "elo_diff": tb[elo_field] - tr[elo_field],
        "eg_gold_diff": tb["eg_gold"] - tr["eg_gold"],
        "blue_edge": d["blue_edge"],
    }
    if draft:
        def power(names):
            return sum(table.get(n.lower(), 0.5) for n in names)

        def comfort(team, names, f):
            tc = d["team_champion_comfort"].get(team, {})
            return sum(tc.get(n.lower(), f) for n in names)

        feats["d_power"] = power(draft["bluePicks"]) - power(draft["redPicks"])
        feats["d_comfort"] = (comfort(blue, draft["bluePicks"], tb["form"])
                              - comfort(red, draft["redPicks"], tr["form"]))
        feats["ban_edge"] = power(draft["blueBans"]) - power(draft["redBans"])
        m = d["models"]["full"]
    else:
        m = d["models"]["nodraft"]
    z = m["intercept"]
    for i, name in enumerate(m["features"]):
        z += (feats[name] - m["scaler_mean"][i]) / m["scaler_scale"][i] * m["coef"][i]
    p_raw = sigmoid(z)
    return {"p_raw": p_raw, "p_cal": calibrate(p_raw, m["calibration"]), "features": feats}


CASES = [
    {"id": "t1-blg-predraft", "blue": "T1", "red": "Bilibili Gaming", "draft": None},
    {"id": "t1-blg-draft", "blue": "T1", "red": "Bilibili Gaming", "draft": {
        "bluePicks": ["Aatrox", "Vi", "Ahri", "Kai'Sa", "Renata Glasc"],
        "redPicks": ["Gwen", "Xin Zhao", "Taliyah", "Senna", "Nautilus"],
        "blueBans": ["Azir", "Kalista", "Neeko", "Rumble", "Sejuani"],
        "redBans": ["Yone", "Wukong", "Orianna", "Varus", "Rell"]}},
    {"id": "gen-g2-predraft", "blue": "Gen.G", "red": "G2 Esports", "draft": None},
    {"id": "c9-kc-draft", "blue": "Cloud9", "red": "Karmine Corp", "draft": {
        "bluePicks": ["Jax", "Skarner", "Hwei", "Caitlyn", "Milio"],
        "redPicks": ["K'Sante", "Nocturne", "Sylas", "Jinx", "Lulu"],
        "blueBans": ["Aurora", "Ambessa", "Corki", "Ziggs", "Leona"],
        "redBans": ["Smolder", "Ezreal", "Rakan", "Braum", "Alistar"]}},
    {"id": "fur-los-predraft", "blue": "FURIA", "red": "LØS", "draft": None},
]


def main():
    d = load()
    tables, _ = power_tables(d)
    patch = d.get("current_patch") if d.get("current_patch") in tables else next(iter(tables))
    # CLI code path (src/predict.py) for direct comparison — uses raw snapshot Elo.
    cli = None
    try:
        sys.path.insert(0, "/home/hatch/workspace/lol-worlds-model/src")
        import predict as cli_mod
        bundle, snaps, champ_power = cli_mod.load_bundle()
        cli = (cli_mod, bundle, snaps, champ_power)
    except Exception as e:  # joblib/numpy may be unavailable outside the venv
        print(f"note: CLI comparison skipped ({e})", file=sys.stderr)
    out = {"patch": patch, "model_version": d["model_version"], "cases": []}
    for c in CASES:
        r = predict(d, c["blue"], c["red"], c["draft"], patch)
        row = {"id": c["id"], "p_raw": r["p_raw"], "p_cal": r["p_cal"],
               "features": r["features"]}
        if cli:
            cli_mod, bundle, snaps, champ_power = cli
            dr = None
            if c["draft"]:
                dd = c["draft"]
                dr = cli_mod.draft_features(
                    c["blue"], c["red"],
                    cli_mod.parse_champs(",".join(dd["bluePicks"]), champ_power, "bp"),
                    cli_mod.parse_champs(",".join(dd["redPicks"]), champ_power, "rp"),
                    cli_mod.parse_champs(",".join(dd["blueBans"]), champ_power, "bb"),
                    cli_mod.parse_champs(",".join(dd["redBans"]), champ_power, "rb"),
                    snaps, champ_power)
            p_cli, feats_cli = cli_mod.predict_game(c["blue"], c["red"], dr, bundle, snaps, champ_power)
            row["p_cli"] = p_cli
            row["features_cli"] = feats_cli
        out["cases"].append(row)
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
