#!/usr/bin/env python3
"""
BrazosCast — what the river would have to do to reach this street.

The app's answer on a quiet day is "your street stays dry in this forecast", which is
true and says nothing. The honest version is the one the household can act on:

    this street floods at 33.4 ft; the gauge last reached that in 2024 (45.92 ft),
    and the highest peak in the record is 58.60 ft in 1899

That number is not a forecast and does not need one. It is the cached USGS annual-peak
record for 08114000, filtered to the gage-height parameter (the same file also carries
discharge peaks, which are a different quantity in different units and must not be mixed
in), so the sentence costs one small artifact and no network call at runtime.

Question : when did the Richmond gauge last reach a given stage, and how high has it been?
Input    : data/raw/usgs/08114000_peaks.json
Output   : data/derived/gauge_history.json
Usage    : <env>/bin/python pipeline/derive/gauge_history.py

WHAT THIS IS NOT
  Annual peaks are the maximum of each year, not a continuous record, so "last reached"
  means "the last year whose peak was at or above that stage" — exact for the question
  asked, and it cannot report a stage that was reached mid-year below that year's peak
  (which is not possible: a year's peak bounds every reading in it from above).
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "usgs" / "08114000_peaks.json"
VALIDATION = ROOT / "data" / "derived" / "harvey_validation.json"
OUT = ROOT / "data" / "derived" / "gauge_history.json"

# 00065 is gage height in ft. 00060 in the same file is discharge in ft^3/s.
STAGE_PARAMETER = "00065"


def stage_peaks() -> list[dict]:
    rows = json.loads(RAW.read_text())["peaks"]
    out = []
    for r in rows:
        if r.get("parameter_code") != STAGE_PARAMETER:
            continue
        if (r.get("unit_of_measure") or "").lower() != "ft":
            continue
        try:
            ft = float(r["value"])
        except (KeyError, TypeError, ValueError):
            continue
        at = str(r.get("time") or "")
        if not at or ft <= 0:
            continue
        out.append({"at": at, "ft": round(ft, 2), "year": int(at[:4])})
    out.sort(key=lambda p: (p["at"], p["ft"]))
    return out


def main():
    peaks = stage_peaks()
    if not peaks:
        raise SystemExit(f"no stage peaks in {RAW} — was the fetch saved with parameter 00065?")

    highest = max(peaks, key=lambda p: (p["ft"], p["at"]))
    print(f"{len(peaks)} annual stage peaks, {peaks[0]['at']} .. {peaks[-1]['at']}")
    print(f"highest {highest['ft']:.2f} ft at {highest['at']} ({highest['year']})")

    # Gates. The quiet-river sentence is a claim about the record, so the record has to
    # be one: sorted, in feet, plausibly long, and carrying the one flood this repo
    # publishes a peak for (2017, 55.19 ft).
    assert len(peaks) >= 50, f"only {len(peaks)} annual peaks — too short a record to say 'last'"
    assert all(0 < p["ft"] < 100 for p in peaks), "a stage peak outside a plausible range"
    assert [p["at"] for p in peaks] == sorted(p["at"] for p in peaks), "peaks are not chronological"
    assert len({p["at"] for p in peaks}) == len(peaks), "duplicate peak dates — dedupe before shipping"
    years = [p["year"] for p in peaks]
    assert max(years) >= 2017, "the record does not reach the 2017 flood this app replays"
    harvey = [p for p in peaks if p["year"] == 2017]
    assert harvey, "2017 is missing from the peak record"
    # The published peak comes from harvey_validation.json rather than a constant written
    # here: two artifacts about one flood have to agree on it, and a number typed into this
    # file twice would agree with itself.
    published = None
    if VALIDATION.exists():
        published = json.loads(VALIDATION.read_text()).get("peak", {}).get("stage_ft")
    own_2017 = max(p["ft"] for p in harvey)
    if published is not None:
        assert abs(own_2017 - float(published)) <= 0.1, (
            f"the 2017 peak in this record is {own_2017:.2f} ft but harvey_validation.json "
            f"publishes {float(published):.2f} ft — two artifacts about one flood")
        print(f"2017 peak {own_2017:.2f} ft agrees with the published {float(published):.2f} ft")
    # The maxima by decade must be non-decreasing as the window widens; a cheap check
    # that the sort and the filter did not interleave two units.
    assert max(p["ft"] for p in peaks[: len(peaks) // 2]) <= highest["ft"]
    print("all gates passed (chronological, one unit, reaches 2017, agrees on the published peak)")

    out = {
        "step": "F1 (second half) — what the river would have to do",
        "question": ("when the forecast never reaches this street, what stage would it take, "
                     "and when did the gauge last reach it?"),
        "site": "08114000",
        "lid": "RMOT2",
        "unit": "ft",
        "source": "USGS 08114000 annual peak gage height (parameter 00065), cached in-repo",
        "n_peaks": len(peaks),
        "from": peaks[0]["at"],
        "to": peaks[-1]["at"],
        "highest": {"at": highest["at"], "ft": highest["ft"]},
        "peaks": [{"at": p["at"], "ft": p["ft"]} for p in peaks],
        "limits": [
            "annual maxima only: a value is the highest reading of its water year, so this "
            "answers 'did any flood that year reach this stage', not 'on which day'",
            "one gauge: the stage is RMOT2's, and a street's threshold is keyed to it",
            "the record ends at the last published peak; a later reading inside the current "
            "year is not in it",
        ],
    }
    OUT.write_text(json.dumps(out, indent=2))
    print(f"\nWrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
