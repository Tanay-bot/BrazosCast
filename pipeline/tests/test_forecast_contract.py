"""T3 — the XGBoost baseline's contract.

NEXT-PLAN.md § 4 asked for three things of this model: that its published numbers are
GATED, that its metrics are the ones the product speaks in, and that it reaches the app
as a cross-check rather than as the answer. This file is the first two.

Two layers, deliberately:

  * the fast layer reads the committed artifacts and asserts the shape of the story —
    every window scored, both models at every stage, rates inside [0, 1] or explicitly
    absent, events found and scored, and the losses to persistence still reported. It
    also re-derives the feature matrix on a TRUNCATED series, which is the one property
    a metric can never show: a column that reads tomorrow.
  * the slow layer (`-m slow`, in scripts/check.sh --all and the golden regression)
    re-trains and compares. That is what makes "this reproduces" a fact rather than a
    memory of the last time someone ran it by hand.

The feature-causality check needs the module, not the artifact, because the claim is
about code. The re-train needs the module's DERIVED redirected to a temp directory, so
the check cannot overwrite the artifacts it is checking.
"""
import json
import pathlib
import sys

import pandas as pd
import pytest

from conftest import DERIVED, ROOT

MODELS = ROOT / "pipeline" / "models"
if str(MODELS) not in sys.path:
    sys.path.insert(0, str(MODELS))

import forecast  # noqa: E402  (path set above)

BENCH = DERIVED / "model_forecast_benchmark.csv"
ARTIFACT = DERIVED / "model_forecast.json"


def bench() -> pd.DataFrame:
    assert BENCH.exists(), f"{BENCH} missing — run pipeline/models/forecast.py"
    return pd.read_csv(BENCH)


def artifact() -> dict:
    assert ARTIFACT.exists(), f"{ARTIFACT} missing — run pipeline/models/forecast.py"
    text = ARTIFACT.read_text()
    assert "NaN" not in text and "Infinity" not in text, (
        "model_forecast.json carries a bare NaN/Infinity, which JSON.parse in the browser "
        "rejects — undefined statistics must be null (this file was shipped that way once)")
    return json.loads(text)


def test_every_window_and_horizon_is_scored_by_both_baselines():
    df = bench()
    want = {(w["id"], h) for w in artifact()["windows"] for h in forecast.HORIZONS}
    got = set(zip(df.window, df.horizon_days))
    assert got == want, f"unscored window/horizon pairs: {sorted(want - got)}"
    for (w, h), g in df.groupby(["window", "horizon_days"]):
        assert set(g.model) == {"xgboost", "persistence", "climatology"}, (
            f"{w} +{h} d is missing a baseline: {sorted(set(g.model))} — a win against "
            f"nothing is not a win, and climatology is the floor the model must clear")
        assert g.rmse.notna().all() and (g.rmse > 0).all(), f"{w} +{h} d has a bad RMSE"


def test_the_headline_holdout_is_the_one_with_the_largest_error():
    """If a later window ever becomes harder than 2016-17, the story in the app ('the
    holdout is the worst case we report') needs rewriting rather than quietly drifting."""
    df = bench()
    ho = df[(df.window == "holdout_2016_17") & (df.model == "xgboost")].set_index("horizon_days")
    for w in ("later_2018_21", "recent_2022_26"):
        other = df[(df.window == w) & (df.model == "xgboost")].set_index("horizon_days")
        assert (ho.rmse >= other.rmse).all(), (
            f"{w} is harder than the published holdout at some horizon "
            f"({other.rmse.to_dict()} vs {ho.rmse.to_dict()}) — the app says the holdout is "
            f"the worst case, so that sentence is now wrong")


def test_the_losses_to_persistence_are_still_reported():
    """The finding that matters most: beyond +3 days the model is not better than
    assuming today's stage. It is asserted in both directions — the rows that lose must
    be present, and every loss in the benchmark must appear in the comparison — because
    a summary that can drop its own counter-evidence is a summary nobody should trust."""
    a = artifact()
    df = bench()
    losses = {(r["window"], r["horizon_days"]) for r in a["comparison"]["loses_to_persistence"]}
    beats = {(r["window"], r["horizon_days"]) for r in a["comparison"]["beats_persistence"]}
    assert losses, "no window loses to persistence — recheck this before the app keeps saying so"

    computed = set()
    for (w, h), g in df[df.window != "train_2013_15"].groupby(["window", "horizon_days"]):
        x = float(g[g.model == "xgboost"].rmse.iloc[0])
        p = float(g[g.model == "persistence"].rmse.iloc[0])
        if x >= p:
            computed.add((w, h))
    assert computed == losses, (
        f"the comparison disagrees with the benchmark: computed losses {sorted(computed)}, "
        f"reported {sorted(losses)}")
    assert not (losses & beats), "a window/horizon is reported as both a win and a loss"
    assert "loses" in a["comparison"]["summary"], "the summary no longer states the losses"


def test_exceedance_is_reported_at_the_stages_the_app_speaks_in():
    a = artifact()
    stages = [s["stage_ft"] for s in a["stages"]]
    assert stages == [20.0, 33.4, 45.0, 50.0], (
        f"the app's four stages are 20/33.4/45/50 ft; the artifact reports {stages}")
    rows = a["exceedance"]
    assert rows, "no exceedance rows at all"
    for w in {r["window"] for r in rows}:
        for h in forecast.HORIZONS:
            for thr in stages:
                got = {r["model"] for r in rows
                       if r["window"] == w and r["horizon_days"] == h and r["threshold_ft"] == thr}
                assert got == {"xgboost", "persistence"}, (
                    f"{w} +{h} d at {thr} ft is scored for {sorted(got)} only")
    for r in rows:
        for key in ("pod", "far", "csi"):
            v = r[key]
            assert v is None or 0.0 <= v <= 1.0, f"{key}={v} is not a rate"
        # The rates must be absent exactly when their denominator is empty, rather than
        # being reported as 0.0 — "no false alarms" and "nothing happened" differ.
        assert (r["pod"] is None) == (r["observed_exceedances"] == 0), (
            f"POD at {r['threshold_ft']} ft is {r['pod']} with "
            f"{r['observed_exceedances']} observed exceedances")
        assert (r["far"] is None) == (r["predicted_exceedances"] == 0), (
            f"FAR at {r['threshold_ft']} ft is {r['far']} with "
            f"{r['predicted_exceedances']} predicted exceedances")


def test_each_flood_event_is_scored_on_its_own():
    """A pooled score over 2016-17 is Harvey plus a quiet year; the per-event rows are
    what stop the flood being averaged away. Harvey is asserted by name because it is the
    one event the app also replays."""
    a = artifact()
    events = a["events"]
    assert len(events) >= 4, f"only {len(events)} events found; the record has more floods"
    for e in events:
        assert e["days_at_or_above_action"] >= 5, (
            f"{e['label']} is in the table with {e['days_at_or_above_action']} days above "
            f"action stage — the threshold that keeps rises out of the flood table moved")
        assert e["rows"], f"{e['label']} has no scored rows"
        for r in e["rows"]:
            assert r["persistence_rmse_ft"] > 0 and r["rmse_ft"] > 0
            assert len(r["csi"]) == len(a["stages"]), "a CSI is missing a stage"
    harvey = [e for e in events if e["peak_at"].startswith("2017-08")]
    assert harvey, "Harvey is not in the per-event table any more"
    assert harvey[0]["peak_ft"] > 50, (
        f"Harvey's peak reads {harvey[0]['peak_ft']} ft; it crested above 50 ft on "
        f"08114000, so this is the wrong window or the wrong gauge")


def test_the_feature_matrix_never_reads_the_future():
    """The claim a metric cannot make. Every column is recomputed on a series that stops
    mid-record; a column that shifted negatively, or centred its window, or used a
    forward fill would change, and its live value would be a value the model could not
    have had at issue time."""
    df = forecast.load()
    full = forecast.features(df).astype("float64")
    y = df[f"stage_{forecast.TARGET}"]
    usable = full.join(y.rename("y")).dropna()
    cut = usable.index[len(usable) // 2]
    trunc = forecast.features(df.loc[:cut]).loc[usable.index[0]:cut].astype("float64")
    past = full.loc[usable.index[0]:cut]
    assert list(trunc.columns) == list(past.columns)
    bad = [c for c in trunc.columns
           if not trunc[c].fillna(-999.0).equals(past[c].fillna(-999.0))]
    assert not bad, (
        f"feature column(s) {bad[:5]} change when the series is truncated at {cut.date()} — "
        f"they use data from after the day they describe, so the model is not usable live")


@pytest.mark.slow
def test_the_benchmark_reproduces_from_the_committed_inputs(tmp_path, monkeypatch):
    """Re-train into a temp directory and compare. Tolerance, not equality, because the
    point is that the published numbers are reproducible, not that two float prints match
    byte for byte across library versions."""
    monkeypatch.setattr(forecast, "DERIVED", tmp_path)
    forecast.main()

    fresh = pd.read_csv(tmp_path / "model_forecast_benchmark.csv")
    committed = bench()
    key = ["horizon_days", "window", "model"]
    a = committed.set_index(key).sort_index()
    b = fresh.set_index(key).sort_index()
    assert list(a.index) == list(b.index), (
        f"the re-run has a different set of rows: only committed "
        f"{sorted(set(a.index) - set(b.index))}, only fresh {sorted(set(b.index) - set(a.index))}")
    for col in ("rmse", "mae", "nse", "kge"):
        delta = (a[col] - b[col]).abs().max()
        assert (delta < 1e-6) or (pd.isna(delta)), (
            f"{col} moved by {delta} on a re-run of the same inputs — the benchmark in "
            f"data/derived is no longer what this code produces ({BENCH})")

    fresh_json = json.loads((tmp_path / "model_forecast.json").read_text())
    old = artifact()
    for key_ in ("benchmark", "comparison", "exceedance", "events"):
        assert fresh_json[key_] == old[key_], (
            f"model_forecast.json.{key_} differs from the committed artifact on a re-run")


def test_the_ensemble_propagates_the_curves_the_benchmark_states():
    """The coupling that was by hand. ensemble.py needs the model's RMSE by horizon, and
    it once held its own typed copy — so re-training would have changed the benchmark and
    left the ensemble quoting the old curve. The app's uncertainty would then be measured
    against a model that no longer exists, which is invisible on screen."""
    import ensemble

    df = bench()
    ho = df[(df.window == ensemble.HOLDOUT_WINDOW) & (df.model == "xgboost")]
    want = [(float(d), float(v)) for d, v in
            zip(ho.sort_values("horizon_days").horizon_days, ho.sort_values("horizon_days").rmse)]
    assert ensemble.RMSE_KNOTS == want, (
        f"ensemble.py propagates {ensemble.RMSE_KNOTS} but the benchmark says {want}")
    assert ensemble.FORECAST_FLOOR_FT == want[-1][1], (
        "the ensemble's floor is no longer the measured +7 d RMSE, so it is holding an "
        "error beyond the data at a value nobody measured")

    # And the app's own copy of that curve, which the browser recomputes the grid with.
    spec = json.loads((DERIVED / "ensemble.json").read_text())["parameters"]
    assert spec["forecast_rmse_knots_ft"] == [[d, v] for d, v in want], (
        "ensemble.json ships a forecast-error curve the benchmark does not state, so the "
        "app and the pipeline disagree about the model's error")
