#!/usr/bin/env python3
"""
BrazosCast — Step 5: gauge-failure redundancy

What happens to the product if RMOT2 stops reporting? UPGRADE-PLAN.md step 5 asks
for the upstream gauges to become an operational redundancy path: estimate the
Richmond stage from HPDT2/BAWT2 shifted by the derived median lag, label it as
estimated, and widen it to the measured IQR.

That method is implemented here and then *measured* — and the measurement
corrects the plan's trigger, which is the useful part of this stage:

    plan:   estimate whenever RMOT2 is stale by more than 2 hours
    data:   below ~a day of staleness the last Richmond observation is a far
            better estimate of the current stage than any upstream transfer.
            The upstream estimate only wins once the last observation is itself
            too old to be useful, and the crossover is measured, not chosen.

So three estimators are built and compared out-of-sample, 5-fold by flood event
(leave whole events out, never hours):

    persistence  the last observed Richmond stage — what you already have
    shift        Richmond ≈ T(upstream(t − lag)) — the plan's method
    anchor       Richmond ≈ last observation + [T(upstream(t − lag))
                                                 − T(upstream(t − lag − gap))]
                 the plan's method used as a *change*, anchored on what was
                 really measured at Richmond

T is a monotone piecewise-linear transfer from upstream stage to Richmond stage,
fitted as the median Richmond stage of 12 quantile bins of upstream stage, with
the knots clamped outside the fitted range. Piecewise-linear — not PCHIP as in
gauge_rating.py — deliberately: the identical interpolation is re-implemented in
the browser, and linear interpolation through binned medians is trivially
reproducible in both languages.

Gates (all recomputed at run time, none asserted from memory)
  1. NWPS and USGS must agree on the upstream gauges' datum. This is not
     ceremony: docs/DATA-SOURCES.md documents a live "San Felipe trap" where the
     same gauge appears in different vertical datums, and the transfer is fitted
     on USGS data while the app feeds it NWPS data. A silent offset here would
     become a wrong flood stage.
  2. enough paired out-of-fold hours to mean anything
  3. the transfer is monotone in both columns
  4. the regime boundaries are DERIVED from the errors, and must be ordered
  5. where the upstream estimate is shipped, it must beat persistence there
  6. the quoted uncertainty band must actually cover about what it claims,
     measured out-of-sample — otherwise the band is decoration
  7. the lag + gap actually used must fit inside the observed window that the
     live API serves, or the estimate cannot be computed in production

Output: data/derived/gauge_redundancy.json

Usage: <env>/bin/python pipeline/derive/gauge_redundancy.py
"""
import json
import pathlib

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
IV = RAW / "usgs" / "iv"
DERIVED = ROOT / "data" / "derived"
OUT = DERIVED / "gauge_redundancy.json"

TARGET = ("08114000", "RMOT2", "Richmond")
UPSTREAM = {"HPDT2": ("08111500", "Hempstead"), "BAWT2": ("08111850", "San Felipe")}
GAP_GRID = [2, 6, 12, 18, 24, 30, 36, 42, 48, 60, 72]
N_FOLDS = 5
NBINS = 12
MIN_ROWS = 2000
DATUM_TOL_FT = 0.5
COVERAGE_BAND = (0.30, 0.70)     # nominal 50% band must land near 50%


def load_iv(site: str, tag: str):
    p = IV / f"{site}_{tag}.json"
    if not p.exists():
        return None
    rows = json.loads(p.read_text())
    if not rows:
        return None
    df = pd.DataFrame([r["properties"] for r in rows])
    df["t"] = pd.to_datetime(df["time"], errors="coerce", utc=True)
    df["v"] = pd.to_numeric(df["value"], errors="coerce")
    return (df.dropna(subset=["t", "v"]).drop_duplicates("t")
              .set_index("t")["v"].sort_index())


def event_tags() -> list:
    return sorted({p.name.split("_")[1][:-5] for p in IV.glob(f"{TARGET[0]}_*.json")})


def build_frame() -> pd.DataFrame:
    """Hourly, one row per timestamp, one block per cached flood event. Blocks are
    kept separate (tag) so a lag never reaches across the gap between events."""
    frames = []
    for tag in event_tags():
        rt = load_iv(TARGET[0], tag)
        if rt is None:
            continue
        d = {"rt": rt.resample("1h").mean()}
        for lid, (site, _) in UPSTREAM.items():
            u = load_iv(site, tag)
            if u is not None:
                d[lid] = u.resample("1h").mean()
        f = pd.DataFrame(d)
        f["tag"] = tag
        frames.append(f)
    return pd.concat(frames)


def transfer(sub: pd.DataFrame, lid: str, lag: int, nbins: int = NBINS):
    """Knots of upstream stage -> Richmond stage, at the given lag, as bin medians."""
    s = sub.dropna(subset=["rt", lid]).copy()
    s["ush"] = s.groupby("tag")[lid].shift(lag)
    s = s.dropna(subset=["ush"])
    if len(s) < 50:
        return None
    q = pd.qcut(s["ush"], nbins, duplicates="drop")
    kn = (s.groupby(q, observed=True)
            .agg(uk=("ush", "median"), rk=("rt", "median"))
            .sort_values("uk"))
    return kn["uk"].values, kn["rk"].values


def apply_transfer(u: np.ndarray, r: np.ndarray, x: np.ndarray) -> np.ndarray:
    """Same interpolation the app performs: clamp outside the fitted range."""
    return np.interp(x, u, r, left=r[0], right=r[-1])


def datum_check() -> dict:
    """NWPS vs USGS on the cached upstream observed series. The transfer is fitted on
    USGS gage height and applied to NWPS values in production, so this is a
    prerequisite, not a formality."""
    out = {}
    for lid, (site, _) in UPSTREAM.items():
        nw_path = RAW / "nwps" / f"{lid}_stageflow.json"
        us_path = RAW / "usgs" / f"{site}_daily.json"
        if not nw_path.exists() or not us_path.exists():
            out[lid] = {"checked": False,
                        "reason": f"missing {nw_path.name if not nw_path.exists() else us_path.name}"}
            continue
        nw = json.loads(nw_path.read_text())
        obs = pd.Series({pd.Timestamp(p["validTime"]): p["primary"]
                         for p in nw.get("observed", {}).get("data", [])}).dropna()
        if obs.empty:
            out[lid] = {"checked": False, "reason": "no NWPS observed points"}
            continue
        obs.index = obs.index.tz_convert("UTC").tz_localize(None)
        nw_daily = obs.resample("1D").mean().dropna()
        d = pd.DataFrame(json.loads(us_path.read_text())["stage_daily"])[["time", "value"]]
        d["time"] = pd.to_datetime(d["time"])
        d["value"] = pd.to_numeric(d["value"], errors="coerce")
        us = d.dropna().drop_duplicates("time").set_index("time")["value"].sort_index()
        common = nw_daily.index.intersection(us.index)
        diff = (nw_daily[common] - us[common]).dropna()
        out[lid] = {"checked": True, "days": int(len(diff)),
                    "mean_ft": float(diff.mean()) if len(diff) else None,
                    "max_abs_ft": float(np.abs(diff).max()) if len(diff) else None,
                    "window": [str(nw_daily.index.min().date()), str(nw_daily.index.max().date())]}
    return out


def main():
    tt = json.loads((DERIVED / "travel_time_subdaily.json").read_text())["gauges"]
    lag = {lid: float(tt[lid]["median_h"]) for lid in UPSTREAM if lid in tt}
    print("derived lag to Richmond:", {k: f"{v} h" for k, v in lag.items()})

    frame = build_frame()
    tags = sorted(frame["tag"].unique())
    print(f"paired hourly rows: {len(frame)} across {len(tags)} flood events; "
          f"Richmond stage {frame['rt'].min():.1f}–{frame['rt'].max():.1f} ft")

    # --- the plan's method, measured out-of-sample -----------------------------
    lags = {lid: int(round(lag[lid])) for lid in lag}
    acc = {g: {k: [] for k in ("persistence", "shift", "anchor")} for g in GAP_GRID}
    signed_shift = {g: [] for g in GAP_GRID}
    bands = []
    for k in range(N_FOLDS):
        test = set(tags[k::N_FOLDS])
        tr, te = frame[~frame["tag"].isin(test)], frame[frame["tag"].isin(test)].copy()
        knots = {lid: transfer(tr, lid, lags[lid]) for lid in lags}
        for lid in lags:
            u, r = knots[lid]
            te[lid + "_g"] = apply_transfer(u, r, te.groupby("tag")[lid].shift(lags[lid]).values)
        # training-fold error quantiles -> the band the app would quote
        tr_err = []
        for lid in lags:
            u, r = knots[lid]
            g = apply_transfer(u, r, tr.groupby("tag")[lid].shift(lags[lid]).values)
            rtv = tr["rt"].values
            # mask BOTH sides: an unmasked NaN here poisons the percentile and the
            # quoted band silently becomes NaN rather than failing loudly
            m = ~np.isnan(g) & ~np.isnan(rtv)
            tr_err.append((g - rtv)[m])
        e = np.concatenate(tr_err)
        bands.append((float(np.percentile(e, 25)), float(np.percentile(e, 75))))
        shift_now = te[[lid + "_g" for lid in lags]].mean(axis=1)
        for g in GAP_GRID:
            rt_obs = te.groupby("tag")["rt"].shift(g)
            for lid in lags:
                u, r = knots[lid]
                te[lid + "_gobs"] = apply_transfer(
                    u, r, te.groupby("tag")[lid].shift(lags[lid] + g).values)
            anchor = rt_obs + (shift_now - te[[lid + "_gobs" for lid in lags]].mean(axis=1))
            for name, est in (("persistence", rt_obs), ("shift", shift_now), ("anchor", anchor)):
                m = est.notna().values & te["rt"].notna().values
                acc[g][name].extend(np.abs((est - te["rt"]).values[m]).tolist())
                if name == "shift":
                    signed_shift[g].extend((est - te["rt"]).values[m].tolist())

    mae = {g: {k: float(np.mean(v)) if v else None for k, v in d.items()} for g, d in acc.items()}
    print(f"\nMAE by staleness gap ({N_FOLDS}-fold leave-events-out, both gauges combined):")
    print(f"{'gap_h':>6} {'n':>6} {'persistence':>12} {'shift':>8} {'anchor':>8}")
    for g in GAP_GRID:
        n = len(acc[g]["shift"])
        print(f"{g:>6} {n:>6} {mae[g]['persistence']:>12.2f} "
              f"{mae[g]['shift']:>8.2f} {mae[g]['anchor']:>8.2f}")

    # --- derive the regime boundaries rather than hardcoding the plan's 2 h ----
    anchor_beats_persist = [g for g in GAP_GRID if mae[g]["anchor"] < mae[g]["persistence"] - 0.05]
    c1 = anchor_beats_persist[0] if anchor_beats_persist else GAP_GRID[0]
    shift_beats_anchor = [g for g in GAP_GRID if mae[g]["shift"] < mae[g]["anchor"]]
    c2 = shift_beats_anchor[0] if shift_beats_anchor else GAP_GRID[-1]
    print(f"\nplan says: use upstream beyond 2 h of staleness.")
    print(f"measured:  persistence is better until ~{c1} h "
          f"({mae[GAP_GRID[0]]['persistence']:.2f} ft at {GAP_GRID[0]} h vs "
          f"{mae[GAP_GRID[0]]['shift']:.2f} ft for the upstream estimate)")
    print(f"           anchored estimate is best from {c1} h to {c2} h")
    print(f"           unanchored upstream estimate is best beyond {c2} h")

    # --- the shipped band, measured out-of-sample -----------------------------
    pad, pdp = float(np.mean([b[0] for b in bands])), float(np.mean([b[1] for b in bands]))
    covered = []
    for g in (c2, GAP_GRID[-1]):
        # coverage of the SIGNED error interval the app prints, not of |error|
        err = np.array(signed_shift[g])
        covered.append(float(np.mean((err >= pad) & (err <= pdp))))
    print(f"\nuncertainty band: -{abs(pad):.2f} / +{pdp:.2f} ft; "
          f"out-of-sample coverage {', '.join(f'{c:.0%}' for c in covered)} at {c2}–{GAP_GRID[-1]} h")

    # --- gates -----------------------------------------------------------------
    datum = datum_check()
    for lid, d in datum.items():
        if d.get("checked"):
            assert d["max_abs_ft"] < DATUM_TOL_FT, (
                f"{lid}: NWPS and USGS disagree by {d['max_abs_ft']:.2f} ft over "
                f"{d['days']} days — the transfer was fitted on USGS and is applied to "
                f"NWPS, so a datum offset here would silently corrupt the estimate")
    checked = [l for l, d in datum.items() if d.get("checked")]
    assert checked, "no upstream gauge could be datum-checked against its cached NWPS series"
    for lid in lags:
        u, r = transfer(frame, lid, lags[lid])
        assert np.all(np.diff(u) > 0), f"{lid}: transfer knots are not increasing in upstream stage"
        assert np.all(np.diff(r) >= -1e-9), f"{lid}: transfer knots are not monotone in Richmond stage"
        assert len(u) >= 6, f"{lid}: too few knots to be a transfer"
    n_eval = len(acc[GAP_GRID[-1]]["shift"])
    assert n_eval >= MIN_ROWS, f"only {n_eval} out-of-fold paired hours — too few to conclude"
    assert c2 > c1, f"regime boundaries not ordered ({c1} >= {c2})"
    worst = GAP_GRID[-1]
    assert mae[worst]["shift"] < mae[worst]["persistence"], (
        f"at {worst} h staleness the upstream estimate ({mae[worst]['shift']:.2f} ft) does "
        f"not beat persistence ({mae[worst]['persistence']:.2f} ft) — the redundancy path "
        f"adds nothing and should not ship")
    assert pdp > 0, "the quoted uncertainty band has zero width"
    for g, cov in zip((c2, GAP_GRID[-1]), covered):
        assert COVERAGE_BAND[0] <= cov <= COVERAGE_BAND[1], (
            f"the quoted band claims ~50% coverage but covers {cov:.0%} out-of-sample at "
            f"{g} h — the band would be decoration")
    # the lag+gap actually used must fit inside the live observed window
    win_h = 0
    for lid in lags:
        p = RAW / "nwps" / f"{lid}_stageflow.json"
        if p.exists():
            pts = json.loads(p.read_text())["observed"]["data"]
            if pts:
                a = pd.Timestamp(pts[0]["validTime"]); b = pd.Timestamp(pts[-1]["validTime"])
                win_h = max(win_h, (b - a).total_seconds() / 3600.0)
    assert win_h >= max(lags.values()) + max(GAP_GRID), (
        f"NWPS observed window ({win_h:.0f} h) is shorter than the largest lag+gap "
        f"({max(lags.values()) + max(GAP_GRID)} h) — the estimate would not be computable")
    print(f"all gates passed (datum agreement on {len(checked)} gauges, "
          f"{n_eval} out-of-fold hours, observed window {win_h:.0f} h)")

    knots_out = {}
    for lid in lags:
        u, r = transfer(frame, lid, lags[lid])
        knots_out[lid] = {"name": UPSTREAM[lid][1], "usgs": UPSTREAM[lid][0],
                          "lag_h": lag[lid], "lag_h_used": lags[lid],
                          "u_ft": [round(float(v), 2) for v in u],
                          "r_ft": [round(float(v), 2) for v in r]}

    summary = {
        "step": "Step 5 — gauge-failure redundancy",
        "question": ("If RMOT2 stops reporting, what is the Richmond stage? Answered from "
                     "HPDT2/BAWT2, and only where the measurement says that beats what you "
                     "already have."),
        "method": ("estimate Richmond(t) as T(upstream(t - lag)) where T is a monotone "
                   "piecewise-linear transfer fitted as bin medians of upstream stage, and "
                   "lag is the derived median crest lead time. Below the measured crossover "
                   "the last Richmond observation is used instead, because it is closer to "
                   "the truth than the transfer is."),
        "interpolation": ("piecewise-linear through binned medians, clamped outside the "
                          "fitted range — chosen because the identical interpolation is "
                          "re-implemented in the browser; PCHIP would not be reproducible "
                          "there without a second implementation to keep in step"),
        "transfer": knots_out,
        "validation": {
            "protocol": f"{N_FOLDS}-fold leave-events-out (whole flood events held out, never hours)",
            "events": len(tags), "hourly_rows": int(len(frame)),
            "evaluated_rows": n_eval,
            "mae_ft_by_gap_h": {str(g): {k: (round(v, 2) if v is not None else None)
                                         for k, v in mae[g].items()} for g in GAP_GRID},
            "regimes": {"persistence_until_h": c1, "anchor_until_h": c2,
                        "shift_beyond_h": c2},
            "plan_trigger_h": 2,
            "correction": ("the plan's 2 h trigger is wrong by measurement: at 2 h staleness "
                           "persistence errs {:.2f} ft and the upstream transfer {:.2f} ft"
                           ).format(mae[GAP_GRID[0]]["persistence"], mae[GAP_GRID[0]]["shift"]),
        },
        "uncertainty": {"band_ft": [round(pad, 2), round(pdp, 2)],
                        "out_of_sample_coverage": [round(c, 3) for c in covered],
                        "note": "coverage measured on held-out events; the band is the "
                                "training-fold error IQR, not an assumption"},
        "datum_check": datum,
        "shipped_rule": ("gap <= {}: last Richmond observation. gap <= {}: anchored estimate "
                         "(last observation plus the transfer's change). beyond: unanchored "
                         "upstream estimate with the measured band.").format(c1, c2),
        "checks": {"datum_agree_within_ft": DATUM_TOL_FT,
                   "regimes_derived_not_assumed": True,
                   "beats_persistence_where_shipped": True,
                   "band_coverage_measured": True,
                   "window_fits_live_api": True},
        "caveats": ("The transfer is fitted from 20 flood events on the Brazos — it describes "
                    "those events, and the largest gap between them and the live river is the "
                    "reason the band is quoted rather than a point. It estimates a stage, not "
                    "a forecast, and it inherits the USGS gage-height datums, so a datum change "
                    "at any of the three gauges invalidates it silently — which is why the datum "
                    "gate runs every time this builds. Upstream data can fail independently of "
                    "RMOT2, so a stale upstream gauge means no estimate at all, not a "
                    "worse one."),
    }
    OUT.write_text(json.dumps(summary, indent=2))
    print(f"\nWrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
