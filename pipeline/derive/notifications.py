#!/usr/bin/env python3
"""F7 — three-tier alerts, compiled from build-time templates, EN and ES.

The app asserts a per-street flood threshold and a lead time. An alert is the part of
that answer that reaches someone who is not looking at the page, so two things about it
have to be true rather than plausible:

  * it is timed from THIS STREET's own crossing, not from the river's category. The
    alternative was measured and rejected: in the 2017 record the official flood stages
    (minor 45, moderate 48, major 50) arrived 7 h and 4 h apart, so a stage-anchored
    ladder would put three texts in one night and none of them would name the reader's
    street. The three tiers here are a countdown — T-72 h, T-24 h, T-6 h — and every
    message states the official category at the hour it is sent as context.

  * the Spanish message carries the same numbers as the English one. A translated alert
    that says 48 where the English says 45 is worse than no alert, so the templates are
    rendered by two independent implementations (this file and app/src/lib/notify.ts)
    and pipeline/tests/test_notifications.py requires the digit multisets to match.

The send is SIMULATED. Nothing is transmitted, there is no provider, and no phone number
exists in this repo. What is real is the schedule: the artifact below runs every modelled
street through the same policy, including the quiet-hours hold, and reports how many
messages would have gone out and whether any would have arrived after the water.

Usage: <env>/bin/python pipeline/derive/notifications.py
"""
import json
import pathlib
import statistics
import string
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[2]
DERIVED = ROOT / "data" / "derived"
PUBLIC = ROOT / "app" / "public" / "data"
TEMPLATES = ROOT / "pipeline" / "notify" / "templates.json"
REPLAY = PUBLIC / "replay-harvey.json"
ROADS = DERIVED / "road_thresholds.json"

# The same four numbers the app carries (app/src/main.ts, TH). A test asserts the two
# agree, because a category name computed from a different set of stages would put a
# confidently wrong word in a message that has no room to explain itself.
TH = {"action": 20, "minor": 45, "moderate": 48, "major": 50}
TZ = ZoneInfo("America/Chicago")
QUIET_FROM, QUIET_TO = 22, 7
MONTH = {"en": ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
         "es": ["ene", "feb", "mar", "abr", "may", "jun",
                "jul", "ago", "sep", "oct", "nov", "dic"]}
# Spanish uses the unpunctuated SMS form: a trailing period after "p.m." collided
# with the sentence period and produced "2 p.m..". The digits are unaffected.
AMPM = {"en": ("AM", "PM"), "es": ("am", "pm")}


def category(stage: float) -> str:
    if stage >= TH["major"]:
        return "Major flooding"
    if stage >= TH["moderate"]:
        return "Moderate flooding"
    if stage >= TH["minor"]:
        return "Minor flooding"
    if stage >= TH["action"]:
        return "Action stage"
    return "No flooding"


def format_when(ts: datetime, lang: str) -> str:
    """The crossing time, in the message's language.

    Twelve-hour in both languages and a short month name with no digits in it, so the
    English and Spanish messages carry the same numerals. A 24-hour Spanish time would
    be better Spanish and would make the digit-parity gate compare two different clocks.
    """
    local = ts.astimezone(TZ)
    hour = local.hour % 12 or 12
    ampm = AMPM[lang][0 if local.hour < 12 else 1]
    if lang == "es":
        return f"{local.day} {MONTH['es'][local.month - 1]}, {hour} {ampm}"
    return f"{MONTH['en'][local.month - 1]} {local.day}, {hour} {ampm}"


def placeholders(text: str) -> list[str]:
    return sorted({f for _, f, _, _ in string.Formatter().parse(text) if f})


def render(tier: str, lang: str, values: dict) -> str:
    """Fill one template. The browser does the same with the same strings (lib/notify.ts).

    Unknown or missing keys are an error rather than a KeyError at send time: a template
    that drifted from its placeholder list would otherwise render as `{stage}` on a phone.
    """
    tpl = TEMPLATES_DATA["templates"][lang][tier]
    want = set(placeholders(tpl))
    if want != set(values):
        raise ValueError(f"{lang}/{tier} wants {sorted(want)}, got {sorted(values)}")
    v = dict(values)
    if lang == "es":
        v["category"] = TEMPLATES_DATA["category_es"][values["category"]]
    return tpl.format_map(v)


def values_for(street: str | None, threshold: float, river: float,
               category_name: str, hours: int, when: datetime, lang: str) -> dict:
    return {
        "street": street or TEMPLATES_DATA["fallback_street"][lang],
        "stage": f"{threshold:.1f}",
        "river": f"{river:.1f}",
        "category": category_name,
        "hours": str(hours),
        "when": format_when(when, lang),
    }


def next_local_seven(ts: datetime) -> datetime:
    local = ts.astimezone(TZ)
    held = local.replace(hour=QUIET_TO, minute=0, second=0, microsecond=0)
    if local.hour >= QUIET_FROM:
        held += timedelta(days=1)
    return held.astimezone(timezone.utc)


def load_templates() -> dict:
    return json.loads(TEMPLATES.read_text())


def main() -> None:
    tpl = load_templates()
    replay = json.loads(REPLAY.read_text())
    roads = json.loads(ROADS.read_text())
    pts = replay["points"]
    stages = [p["v"] for p in pts]
    t0 = datetime.fromisoformat(pts[0]["t"]).astimezone(timezone.utc)
    window_h = len(pts) - 1

    tiers = tpl["tiers"]
    assert [t["hours_before"] for t in tiers] == [72, 24, 6], (
        "the ladder moved; every figure in the README and the app's card is about 72/24/6")

    # ---- every street's own crossing, by the same rule the backcast uses -------------
    crossings = []
    for i, r in enumerate(roads):
        at = r["at"]
        idx = next((k for k, v in enumerate(stages) if v >= at), None)
        if idx is not None:
            crossings.append({"i": i, "seg": r["id"], "name": r["name"], "at": at, "h": idx})
    assert len(crossings) > 1000, f"only {len(crossings)} streets cross in the window"

    sends = []
    # `outside_window` is a send the record cannot cover (before hour 0); the quiet-hours
    # "held past the crossing" branch is unreachable at 72/24 h — the longest hold is 9 h —
    # and is counted separately rather than folded into a number that is always zero.
    per_tier = {t["id"]: {"tier": t["id"], "hours_before": t["hours_before"], "sent": 0,
                          "deferred": 0, "outside_window": 0, "held_past_crossing": 0,
                          "first_at": None, "last_at": None}
                for t in tiers}
    duplicates = 0
    after_water = 0
    seen = set()
    longest = 0
    for c in crossings:
        cross_at = t0 + timedelta(hours=c["h"])
        for t in tiers:
            send_h = c["h"] - t["hours_before"]
            # Before the record starts there is no river to read; the send is not
            # observed and is counted as outside the window rather than invented.
            if send_h < 0 or send_h > window_h:
                per_tier[t["id"]]["outside_window"] += 1
                continue
            send_at = t0 + timedelta(hours=send_h)
            deferred_from = None
            local_h = send_at.astimezone(TZ).hour
            if t["id"] != "now" and (local_h >= QUIET_FROM or local_h < QUIET_TO):
                held = next_local_seven(send_at)
                if held >= cross_at:
                    per_tier[t["id"]]["held_past_crossing"] += 1
                    continue
                deferred_from = send_at
                send_at = held
                send_h = round((send_at - t0).total_seconds() / 3600)
            # Segment POSITION, not osmid: one way can contribute several segments, and
            # the app addresses a road by its index in the layer. Keying on osmid here
            # counted 1,086 duplicates that were distinct streets.
            key = (c["i"], t["id"])
            if key in seen:
                duplicates += 1
            seen.add(key)
            if send_at >= cross_at:
                after_water += 1
            river = stages[min(send_h, len(stages) - 1)]
            cat = category(river)
            vals = {lang: values_for(c["name"], c["at"], river, cat,
                                     t["hours_before"], cross_at, lang)
                    for lang in ("en", "es")}
            msg = {lang: render(t["id"], lang, vals[lang]) for lang in ("en", "es")}
            longest = max(longest, max(len(x) for x in msg.values()))
            rec = per_tier[t["id"]]
            rec["sent"] += 1
            if deferred_from is not None:
                rec["deferred"] += 1
            iso = send_at.isoformat()
            rec["first_at"] = min(rec["first_at"] or iso, iso)
            rec["last_at"] = max(rec["last_at"] or iso, iso)
            sends.append({
                "pos": c["i"], "seg": c["seg"], "street": c["name"], "threshold_ft": c["at"],
                "tier": t["id"], "send_at": iso,
                "deferred_from": deferred_from.isoformat() if deferred_from else None,
                "river_ft": river, "category": cat,
                "hours_to_crossing": t["hours_before"],
                "crossing_at": cross_at.isoformat(),
                "values": vals,
                "en": msg["en"], "es": msg["es"],
            })

    streets_warned = len({s["pos"] for s in sends})
    assert duplicates == 0, f"{duplicates} duplicate sends"
    assert after_water == 0, f"{after_water} messages would have arrived after the water"
    assert all(v["sent"] > 0 for v in per_tier.values()), "a tier never fires"
    assert max(len(x) for x in (s["en"] for s in sends)) <= 320
    assert max(len(x) for x in (s["es"] for s in sends)) <= 320

    # ---- three streets, rendered and kept, so the app's renderer can be held to them --
    named = [c for c in crossings if c["name"]]
    named.sort(key=lambda c: (c["at"], c["seg"]))
    picks = [named[0], named[len(named) // 2], named[-1]]
    verification = []
    for c in picks:
        cross_at = t0 + timedelta(hours=c["h"])
        rows = [s for s in sends if s["pos"] == c["i"]]
        rows.sort(key=lambda s: s["send_at"])
        verification.append({
            "pos": c["i"], "seg": c["seg"], "street": c["name"], "threshold_ft": c["at"],
            "crossing_at": cross_at.isoformat(), "crossing_h": c["h"],
            "sends": [{k: r[k] for k in ("tier", "send_at", "deferred_from", "river_ft",
                                         "category", "hours_to_crossing", "values",
                                         "en", "es")}
                      for r in rows],
        })

    spans = [t["hours_before"] for t in tiers]
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "step": "F7 — three-tier alerts, build-time templates, EN and ES (simulated send)",
        "question": ("what would BrazosCast actually send, when, and would the Spanish "
                     "message carry the same numbers as the English one?"),
        "answer": (
            f"{streets_warned:,} of {len(roads):,} modelled streets get three alerts — at "
            f"{spans[0]}, {spans[1]} and {spans[2]} hours before their own modelled crossing — "
            f"for {len(sends):,} messages in all, none duplicated and none arriving after the "
            f"water. The text is compiled once, in English and Spanish, and the app fills the "
            f"same templates with its own numbers: the two renderers agree string for string "
            f"on {len(verification)} streets, digits included."),
        "tiers": tiers,
        "templates": tpl["templates"],
        "placeholders": tpl["placeholders"],
        "fallback_street": tpl["fallback_street"],
        "category_es": tpl["category_es"],
        "ui": tpl["ui"],
        "policy": {
            "channel": "SMS, simulated — nothing is transmitted and no number is stored",
            "trigger": ("the street's own modelled flood threshold, reached on the replayed "
                        "observed hydrograph; in live mode the same rule runs over the NWPS "
                        "forecast, whose error is measured in harvey_validation.json"),
            "tiers": [{"id": t["id"], "hours_before": t["hours_before"],
                       "label": t["label"], "purpose": t["purpose"]} for t in tiers],
            "why_not_stage_anchored": (
                "the alternative was an alert at each official category. On the 2017 record "
                "minor, moderate and major arrived 7 h and 4 h apart (80, 73 and 69 h before "
                "the crest), i.e. three texts in one night — and not one of them would say "
                "when the reader's own street floods. The category is therefore carried as "
                "context inside every message instead of being the trigger."),
            "quiet_hours": {
                "from_local_hour": QUIET_FROM, "to_local_hour": QUIET_TO,
                "timezone": "America/Chicago",
                "exempt": ["now"],
                "on_suppress": ("held to 07:00 local; dropped rather than sent late if the "
                                "street floods before then"),
            },
            "dedupe": "one message per street per tier, keyed by segment id",
            "max_chars": 320,
            "measured_longest_message": longest,
        },
        "simulation": {
            "event": replay["event"],
            "window": {"from": pts[0]["t"], "to": pts[-1]["t"], "hours": window_h,
                       "n_points": len(pts)},
            "streets": len(roads),
            "streets_warned": streets_warned,
            "sends": len(sends),
            "per_tier": [per_tier[t["id"]] for t in tiers],
            "duplicates": duplicates,
            "sent_after_the_water": after_water,
            "observed_onsets_ft": {t["tier"]: t["onset_h"] for t in
                                   json.loads((DERIVED / "harvey_backcast.json").read_text())["tiers"]},
            "reading": (
                "the count is the corridor, not a subscriber list: it is what the policy does "
                "if every modelled street had someone behind it. What is simulated is the "
                "send, not the schedule."),
        },
        "verification": verification,
        "limits": [
            "the schedule is run over the OBSERVED Harvey hydrograph, so every send is in "
            "hindsight; in live mode the same rule reads the NWPS forecast, which has its "
            "own measured error and is not re-scored here",
            "the street's crossing is the model's, and the second event shows the model's "
            "ordering is weak at a lower stage (AUC 0.566): the alert inherits that, and "
            "the message says 'modelled' rather than 'will flood'",
            "the alert uses the street's own threshold, not the earlier cut-off of its last "
            "dry route out (isolation_ft); for a street whose way out closes first, the "
            "actionable warning is the isolation number, and that is on screen, not in the SMS",
            "quiet hours are a policy choice, not a measurement: 22:00–07:00 local, with the "
            "6-hour tier exempt. The record happens to put most crossings in the evening, so "
            "the hold is exercised but not stressed",
            "no delivery, no carrier, no opt-in, no phone number: this is the text and the "
            "schedule, which is the part that can be checked in a repository",
        ],
    }
    (DERIVED / "notifications.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"wrote data/derived/notifications.json — {streets_warned:,} streets, "
          f"{len(sends):,} messages, longest {longest} chars")
    for t in out["simulation"]["per_tier"]:
        print(f"  {t['tier']:<6} at T-{t['hours_before']:>2} h: {t['sent']:>5} sent, "
              f"{t['deferred']:>3} held to 07:00, {t['outside_window']:>3} outside the "
              f"record, {t['held_past_crossing']} held past the water, "
              f"{t['first_at']} .. {t['last_at']}")
    print("  verification streets: " + ", ".join(
        f"{v['street']} ({v['threshold_ft']} ft)" for v in verification))


TEMPLATES_DATA = load_templates()

if __name__ == "__main__":
    main()
