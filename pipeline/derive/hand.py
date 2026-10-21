#!/usr/bin/env python3
"""
BrazosCast — shared HAND plumbing.

Three things are shared between `hand_unit_resolution.py` (the measurement that
settles the raster's unit) and `inundation.py` (the product that builds on it),
and each of them is a place where a second copy would be a second answer:

  * the branch's file layout            — `paths()`
  * the unit, READ from the measurement — `units_per_metre()`
  * the per-reach stage curve (SRC)     — `reach_stages()`

Nothing here decides what a band is or what gets shipped; that is inundation.py.
"""
import json
import pathlib
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
DERIVED = ROOT / "data" / "derived"
HAND_DIR = ROOT / "data" / "raw" / "hand" / "12070104"
BRANCH = HAND_DIR / "branches" / "3125000011"
USFIMR_ZIP = ROOT / "data" / "raw" / "usfimr" / "05302016_Brazos_River_at_Richmond_TX.zip"
RESOLUTION = DERIVED / "hand_unit_resolution.json"

FT_M = 0.3048
CELL_KM2 = 100.0 / 1e6          # a 10 m cell, in km^2

# The corridor the product covers, and the stages its bands are cut at. 45/48/50 are the
# NWS categories the app already shows; 54.74 is Harvey's observed peak at Richmond, which
# is the stage the one extent observation in the repo can be compared against, and the top
# of the replay's hydrograph. A band below flood stage is not cut: the app shows the
# nearest band at or below the current stage, and the map has nothing to add to "passable"
# below 45 ft.
BBOX = (-96.10, 29.44, -95.55, 29.76)
BAND_STAGES_FT = [45.0, 48.0, 50.0, 54.74]

# The candidate readings of `rem_zeroed_masked`. Only these two have ever been proposed,
# and the measurement script must rank the same set the product can read.
CANDIDATES = {
    "millimetres": 1000.0,
    "centimetres": 100.0,
}


def paths() -> dict:
    return {
        "rem": BRANCH / "rem_zeroed_masked_3125000011.tif",
        "catchments": BRANCH / "gw_catchments_reaches_filtered_addedAttributes_3125000011.tif",
        "hydrotable": BRANCH / "hydroTable_3125000011.csv",
        "levee": HAND_DIR / "LeveeProtectedAreas_subset.gpkg",
    }


def require_raw() -> dict:
    """Fail with the fetch instruction rather than a rasterio stack trace."""
    p = paths()
    missing = [str(v) for v in p.values() if not v.exists()]
    if missing:
        sys.exit("HAND archive missing:\n  " + "\n  ".join(missing) +
                 "\nthe 66 MB HUC 12070104 archive is not tracked — see docs/DATA-SOURCES.md"
                 " § HAND")
    return p


def units_per_metre() -> float:
    """Raster units per metre, READ from the measurement rather than restated here.

    The scale used to be a constant in inundation.py with a comment saying it was a
    guess. It is a measured choice now, so the product reads it: if the resolution
    artifact is absent, or names a reading this module does not know, the product stops
    instead of quietly falling back to the old guess.
    """
    if not RESOLUTION.exists():
        sys.exit(f"{RESOLUTION} missing — run pipeline/derive/hand_unit_resolution.py first: "
                 "the raster's unit is a measurement, not a constant")
    r = json.loads(RESOLUTION.read_text())
    unit = r["chosen"]
    if unit not in CANDIDATES:
        sys.exit(f"{RESOLUTION} chose {unit!r}, which this module cannot read "
                 f"(known: {sorted(CANDIDATES)})")
    if abs(CANDIDATES[unit] - float(r["units_per_metre"])) > 1e-9:
        sys.exit(f"{RESOLUTION} says {r['units_per_metre']} units/m but the reader has "
                 f"{CANDIDATES[unit]} — the artifact and the code disagree")
    return CANDIDATES[unit]


def hydrotable() -> pd.DataFrame:
    """The branch's SRC table, with the raster's own index column as an int."""
    h = pd.read_csv(require_raw()["hydrotable"], low_memory=False)
    h["idx"] = h["HydroID Int16"].astype(int)
    return h


def stage_at_q(sub: pd.DataFrame, q_cms: float) -> tuple[float, bool]:
    """Stage (m) that conveys `q_cms` on one reach's synthetic rating curve.

    The table is sampled in 0.3048 m steps, so this interpolates between rows; above the
    top row it extrapolates on the last segment's slope and says so, because a discharge
    past the table is a number the product should be able to count rather than hide.
    """
    s = sub.groupby("stage")["discharge_cms"].max().sort_index()
    x = s.to_numpy(float)          # discharge, m3/s
    y = s.index.to_numpy(float)    # stage, m
    if q_cms <= 0:
        return 0.0, False
    if q_cms <= x.max():
        return float(np.interp(q_cms, x, y)), False
    dq = x[-1] - x[-2]
    if dq <= 0:
        return float(y[-1]), True
    return float(y[-1] + (q_cms - x[-1]) * (y[-1] - y[-2]) / dq), True


def reach_stages(q_cms: float) -> tuple[dict[int, float], list[int]]:
    """Per-reach stage (m) at a steady discharge, keyed by the raster's index column.

    HAND's own inundation rule is a stage per reach — the `stage` column of the
    hydrotable is measured above that reach's bed — so applying one gauge reading to
    every reach (what this module replaces) is only correct where the bed elevations
    happen to match. A steady discharge on the mainstem is the standard way to get the
    per-reach stage without a DEM: each reach's own SRC says how deep it runs to pass
    the flood.
    """
    out: dict[int, float] = {}
    extrapolated: list[int] = []
    for _hid, sub in hydrotable().groupby("HydroID"):
        stage, extra = stage_at_q(sub, q_cms)
        idx = int(sub["idx"].iloc[0])
        out[idx] = stage
        if extra:
            extrapolated.append(idx)
    return out, sorted(extrapolated)


def q_at_stage(stage_ft: float) -> float:
    """Mainstem discharge (m3/s) at a gauge stage, from the observed rating.

    Inverted by bisection on `gauge_rating.stage_from_flow`, which is monotone by
    construction and gated on being so — so this cannot depend on a second curve.
    """
    sys.path.insert(0, str(ROOT / "pipeline" / "derive"))
    from gauge_rating import stage_from_flow

    lo, hi = 1.0, 2_000_000.0
    for _ in range(200):
        mid = (lo + hi) / 2
        s, _extra = stage_from_flow(mid)
        if s < stage_ft:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2 * 0.0283168      # cfs -> m3/s
