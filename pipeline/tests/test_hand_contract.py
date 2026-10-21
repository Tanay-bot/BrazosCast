"""
I8 — the HAND extent: the unit that was settled, and the error it admits.

NEXT-PLAN.md § 5's gate has three parts, and each is a number that could quietly vanish
rather than a picture that could look wrong:

  1. the unit is confirmed by TWO independent counts (the hydrotable's own per-reach cell
     counts, and the 2016 Sentinel-1 water edge), and neither one alone would do;
  2. the extent is scored against that observation, with the score stated;
  3. the overlay fits the payload budget the app's whole text-mode claim is measured on.

The two scripts that produce these are NOT in the golden chain. They need the 66 MB HAND
archive, which is untracked by decision (docs/DATA-SOURCES.md), and together they take
~4 minutes; pinning them there would make the one regression test that a clone can run
depend on an archive a clone does not have. Their determinism is instead pinned by the
numbers below, which are the artifacts' whole content.
"""
import gzip

from conftest import get

BANDS_FT = [45.0, 48.0, 50.0, 54.74]
BUDGET_BYTES = 300_000


def test_the_unit_was_settled_by_two_independent_checks(derived_json):
    r = derived_json("hand_unit_resolution.json")
    assert r["chosen"] == "millimetres", (
        "the unit is no longer millimetres; every staged extent downstream is in the "
        "wrong scale until hand_unit_resolution.py is read again")
    assert r["units_per_metre"] == 1000.0

    # Check A — the hydrotable's per-reach cell counts. Millimetres must reproduce them
    # at every stage tested; centimetres must not reproduce them at any.
    a = get(r, "hydrotable_cell_counts")
    assert len(a["stages"]) >= 2, "fewer than two stages, so a single stage's luck decides"
    for row in a["stages"]:
        mm = get(row, "readings.millimetres")
        cm = get(row, "readings.centimetres")
        assert mm["reproduces"], f"millimetres stopped reproducing the counts at {row['stage_ft']} ft"
        assert not cm["reproduces"], "centimetres now reproduces the counts — re-open the unit"
        assert 0.98 <= mm["median_ratio"] <= 1.02, (
            f"the median reach's count ratio moved to {mm['median_ratio']} at "
            f"{row['stage_ft']} ft; the raster or the table changed")

    # Check B — the 2016 water edge. The reading must both overlap better AND need a stage
    # near the gauge's; either alone is passable by a wrong scale.
    b = get(r, "usfimr_overlap.readings")
    mm, cm = b["millimetres"], b["centimetres"]
    assert mm["best_stage_is_plausible"], "millimetres no longer explains the observation's stage"
    assert not cm["best_stage_is_plausible"], "centimetres now explains it — the unit is open again"
    assert mm["best"]["iou"] >= 2 * cm["best"]["iou"], (
        f"the overlap margin collapsed: {mm['best']['iou']} vs {cm['best']['iou']}")


def test_the_extent_is_shipped_whole_and_on_the_stages_the_app_uses(derived_json, public_json):
    d = derived_json("flood_extent.json")
    p = public_json("flood_extent.json")
    assert d == p, "app/public/data/flood_extent.json is not the artifact the pipeline wrote"
    assert p["type"] == "FeatureCollection"
    meta = get(p, "meta")
    assert meta["unit"] == "millimetres"
    assert meta["provisional"] is True, (
        "the extent is no longer marked provisional; it over-draws and that label is the "
        "only thing standing between the map and a footprint claim")
    assert meta["bands_ft"] == BANDS_FT, (
        f"the app filters these bands numerically: {meta['bands_ft']} vs {BANDS_FT}")

    # The file says EPSG:4326 and the app hands it to MapLibre unread. Metre coordinates in
    # a degrees document are accepted silently and drawn 43,000 km away — measured, not
    # hypothetical: that is what the first version of inundation.py shipped.
    xs, ys = [], []

    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for part in c:
                walk(part)

    by_band = {}
    for f in p["features"]:
        props = f["properties"]
        assert f["geometry"]["type"] in ("Polygon", "MultiPolygon")
        assert props["stage_ft"] in BANDS_FT
        walk(f["geometry"]["coordinates"])
        by_band.setdefault(props["stage_ft"], 0)
        by_band[props["stage_ft"]] += 1
    assert sorted(by_band) == BANDS_FT, (
        f"bands {sorted(by_band)} leave a stage the app can display with no polygons")
    assert xs and ys
    assert -96.2 < min(xs) and max(xs) < -95.4, (
        f"longitudes run {min(xs):.0f}..{max(xs):.0f} — the extent is not in degrees")
    assert 29.3 < min(ys) and max(ys) < 29.9, (
        f"latitudes run {min(ys):.0f}..{max(ys):.0f} — the extent is not in degrees")

    # Nested by construction: a higher stage cannot map less water, and the card reads the
    # per-band area from the same document it draws from.
    areas = meta["band_areas_km2"]
    # The keys are the app's own `String(number)` form, so the card's lookup is exact
    # rather than relying on 45.0 and "45" being interchangeable.
    assert sorted(areas, key=float) == [f"{b:g}" for b in BANDS_FT]
    vals = [areas[f"{b:g}"] for b in BANDS_FT]
    assert vals == sorted(vals), f"a higher band maps less water: {vals}"
    assert 200 < vals[0] < 320 and 300 < vals[-1] < 380, (
        f"band areas moved outside the corridor's plausible range: {vals}")


def test_the_score_is_stated_and_does_not_flatter_itself(derived_json):
    v = get(derived_json("flood_extent.json"), "meta.validation")
    assert v["area_ratio"] > 1.5, (
        "the map no longer admits that it draws more water than the one observation shows")
    assert 0.2 < v["iou_at_that_stage"] < 0.6
    assert v["observed_km2"] > 100, "the observation was clipped away to nothing"
    assert v["recall"] > 0.6, "the extent stops containing the water the radar saw"
    assert v["iou_at_harvey_peak"] > 0, "the peak score was dropped rather than reported"
    assert v["observed_stage_ft"] < v["harvey_peak_ft"]
    # The caveat must explain the comparison, not merely exist: it has to say the image
    # predates the crest, which is why the peak score is not the headline.
    note = v["peak_is_not_like_for_like"]
    assert "three days later" in note and "could never have shown" in note


def test_the_overlay_fits_the_payload_budget(root):
    """Gzipped, like every other byte in this app's budget (scripts/check-text-mode.mjs).

    The extent is fetched by the map route only, so it is not in the text-only total — but
    it travels with the map on a phone alongside the roads, and a 1 MB outline would be the
    largest thing on the page.
    """
    raw = (root / "app" / "public" / "data" / "flood_extent.json").read_bytes()
    gz = gzip.compress(raw, 9)
    assert len(gz) <= BUDGET_BYTES, (
        f"flood_extent.json is {len(gz) / 1000:.0f} KB gzipped, over the "
        f"{BUDGET_BYTES / 1000:.0f} KB budget; raise SIMPLIFY_M or drop a band")
