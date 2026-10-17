"""F7 — the alert: three tiers, two languages, one set of numbers.

The feature is a message that tells someone to leave. Its failures are not crashes:

  * a Spanish alert that says 48 where the English says 45 — the reader gets a different
    fact from the same product, and nothing on screen looks wrong;
  * a message that arrives after the water it is about;
  * a tier that is "sent" twice, or a template that drifted from its placeholders and
    renders `{stage}` on a phone;
  * a card whose Spanish chrome is still English, which is the half-translation that makes
    a bilingual surface worse than a monolingual one.

Every test below names the artifact field it read. The rendering itself is duplicated on
purpose (Python here, TypeScript in app/src/lib/notify.ts) and the strings are compared
character for character, because "the translations agree" is a claim about two
implementations and cannot be checked from one.
"""
import json
import re
from collections import Counter
from datetime import datetime, timezone

import pytest

import notifications
from conftest import DERIVED, PUBLIC, ROOT, get

ARTIFACT = "notifications.json"
SOURCE = "pipeline/notify/templates.json"
CATEGORIES = ["No flooding", "Action stage", "Minor flooding", "Moderate flooding",
              "Major flooding"]


@pytest.fixture
def a(public_json):
    """The alert artifact as the app is served it, named `a` because every assertion in
    this file is about a field of it."""
    return public_json(ARTIFACT)


def digits(text: str) -> Counter:
    return Counter(re.findall(r"\d", text))


# ---- the ladder --------------------------------------------------------------

def test_three_tiers_are_a_countdown(a):
    tiers = a["tiers"]
    assert [t["id"] for t in tiers] == ["early", "soon", "now"], (
        "the tier ids are the app's rendering keys; renaming one blanks a message")
    assert [t["hours_before"] for t in tiers] == [72, 24, 6]
    assert [t["hours_before"] for t in tiers] == sorted(
        (t["hours_before"] for t in tiers), reverse=True), "the ladder is out of order"


def test_the_stage_anchored_alternative_is_rejected_by_the_record(a, derived_json):
    """The plan said 'tie it to the tiers in TH'. Measured, that would be three texts in
    one night, so the policy says why — and the backcast's onsets are the evidence."""
    why = a["policy"]["why_not_stage_anchored"]
    assert "7 h and 4 h apart" in why, "the policy no longer states the measured gaps"
    backcast = derived_json("harvey_backcast.json")
    onsets = {t["tier"]: t["onset_h"] for t in backcast["tiers"]}
    assert onsets["moderate"] - onsets["minor"] == 7
    assert onsets["major"] - onsets["moderate"] == 4
    # And the category is still carried, as context, in every template.
    for lang in ("en", "es"):
        for tier in a["templates"][lang].values():
            assert "{category}" in tier


def test_the_category_stages_are_the_apps(a, root):
    """A category name computed from different stages would put a confidently wrong word
    in a message with no room to explain itself."""
    src = (root / "app" / "src" / "main.ts").read_text()
    m = re.search(r"const TH = \{ action: (\d+), minor: (\d+), moderate: (\d+), major: (\d+) \}",
                  src)
    assert m, "app/src/main.ts no longer declares TH in the parsed shape"
    assert tuple(int(x) for x in m.groups()) == (
        notifications.TH["action"], notifications.TH["minor"],
        notifications.TH["moderate"], notifications.TH["major"])
    # Every category the function can return has a Spanish name.
    for text in CATEGORIES:
        assert text in a["category_es"], f"{text!r} has no Spanish rendering"
    assert notifications.category(19.9) == "No flooding"
    assert notifications.category(20) == "Action stage"


# ---- the templates -----------------------------------------------------------

def test_the_source_templates_are_the_shipped_ones(a, root):
    """The artifact carries the text; `pipeline/notify/templates.json` is where it is written.

    If the two diverge, the tests render one and a phone shows the other — which is exactly how
    an edit that was never rebuilt would ship. Only the renderers read the source, so without
    this a drifted template file is caught (at best) as a puzzling string mismatch somewhere
    else.
    """
    src = json.loads((root / SOURCE).read_text())
    for key in ("templates", "category_es", "fallback_street", "ui"):
        assert src[key] == a[key], f"{SOURCE} and the artifact disagree on {key}"
    assert [t["hours_before"] for t in src["tiers"]] == \
        [t["hours_before"] for t in a["tiers"]], "the tier ladder drifted from the source"


def test_every_template_takes_exactly_the_declared_placeholders(root):
    """Read from the SOURCE, not the artifact: this is the test that has to fail when someone
    edits a template, whatever else does or does not get rebuilt."""
    src = json.loads((root / SOURCE).read_text())
    declared = set(src["placeholders"])
    for lang in ("en", "es"):
        for tier, tpl in src["templates"][lang].items():
            assert set(notifications.placeholders(tpl)) == declared, (
                f"{lang}/{tier} wants {notifications.placeholders(tpl)}, "
                f"the file declares {sorted(declared)}")


def test_the_spanish_template_is_not_the_english_one(a):
    for tier, en in a["templates"]["en"].items():
        assert a["templates"]["es"][tier] != en, f"{tier} Spanish is still English"
        assert "{street}" in a["templates"]["es"][tier]


def test_the_ui_is_translated_key_for_key(a):
    en, es = a["ui"]["en"], a["ui"]["es"]
    assert set(en) == set(es), f"ui keys differ: {sorted(set(en) ^ set(es))}"
    for k in en:
        assert en[k] and es[k], f"ui.{k} is empty"
        assert en[k] != es[k], f"ui.{k} is the English string in both languages"


# ---- the numbers -------------------------------------------------------------

def test_the_verification_messages_are_their_templates_filled(a):
    """The artifact is not allowed to carry a rendered string the template no longer
    produces — that is how a doc and an artifact drift apart."""
    for row in a["verification"]:
        for s in row["sends"]:
            for lang in ("en", "es"):
                got = notifications.render(s["tier"], lang, s["values"][lang])
                assert got == s[lang], f"{row['street']} {s['tier']} {lang} drifted"


def test_english_and_spanish_carry_the_same_digits(a):
    """The stored strings AND the two renderers.

    The stored pair is what shipped; the rendered pair is what the templates produce now, which
    is the half that catches a drifted source file rather than a stale artifact.
    """
    for row in a["verification"]:
        for s in row["sends"]:
            assert digits(s["en"]) == digits(s["es"]), (
                f"{row['street']} {s['tier']}: EN has {dict(digits(s['en']))}, "
                f"ES has {dict(digits(s['es']))}")
            en = notifications.render(s["tier"], "en", s["values"]["en"])
            es = notifications.render(s["tier"], "es", s["values"]["es"])
            assert digits(en) == digits(es), (
                f"{row['street']} {s['tier']} rendered from the templates: "
                f"EN has {dict(digits(en))}, ES has {dict(digits(es))}")
            assert s["values"]["en"]["stage"] == s["values"]["es"]["stage"]
            assert s["values"]["en"]["river"] == s["values"]["es"]["river"]
            # `when` is localised ("Aug 26, 2 PM" / "26 ago, 2 pm"), so the two are
            # not equal by design — what must match is every digit in them.
            assert digits(s["values"]["en"]["when"]) == digits(s["values"]["es"]["when"])


def test_extremes_still_render_with_equal_digits(a):
    """The verification streets sit in the afternoon, at ordinary stages. A 12 AM crossing,
    a 12 PM crossing and the corridor's highest threshold are where a formatter breaks."""
    when = {
        "en": notifications.format_when(
            datetime(2017, 12, 31, 23, 30, tzinfo=timezone.utc), "en"),
        "es": notifications.format_when(
            datetime(2017, 12, 31, 23, 30, tzinfo=timezone.utc), "es"),
    }
    # 17:30 local: both say 5, and the short month is December.
    assert when["en"] == "Dec 31, 5 PM" and when["es"] == "31 dic, 5 pm"
    # UTC 05:00 is 12 AM local, 17:00 is 12 PM local — the two places a 12-hour clock
    # prints 0. Both languages must print 12 and agree on the digits.
    for hour, want in ((5, "12 AM"), (17, "12 PM"), (1, "8 PM"), (13, "8 AM")):
        ts = datetime(2017, 8, 26, hour, 0, tzinfo=timezone.utc)
        ew, sw = notifications.format_when(ts, "en"), notifications.format_when(ts, "es")
        assert ew.endswith(want), f"{hour}:00Z rendered as {ew!r}, wanted {want!r}"
        assert "0 AM" not in ew and "0 PM" not in ew and "0 am" not in sw and "0 pm" not in sw
        assert digits(ew) == digits(sw), f"{ew!r} and {sw!r} do not carry the same digits"
    for lang in ("en", "es"):
        vals = {
            "street": a["fallback_street"][lang], "stage": "81.9", "river": "9.2",
            "category": "No flooding", "hours": "6", "when": when[lang],
        }
        msg = notifications.render("now", lang, vals)
        assert len(msg) <= a["policy"]["max_chars"]
    en = notifications.render("now", "en", {
        "street": a["fallback_street"]["en"], "stage": "81.9", "river": "9.2",
        "category": "No flooding", "hours": "6", "when": when["en"]})
    es = notifications.render("now", "es", {
        "street": a["fallback_street"]["es"], "stage": "81.9", "river": "9.2",
        "category": "No flooding", "hours": "6", "when": when["es"]})
    assert digits(en) == digits(es)
    assert "your street" in en and "su calle" in es


def test_every_message_fits_two_sms_segments(a):
    assert a["policy"]["max_chars"] == 320
    assert 0 < a["policy"]["measured_longest_message"] <= 320
    for row in a["verification"]:
        for s in row["sends"]:
            for lang in ("en", "es"):
                assert len(s[lang]) <= 320, f"{row['street']} {s['tier']} {lang} is {len(s[lang])} chars"


# ---- the send ----------------------------------------------------------------

def test_every_verification_send_lands_before_the_water(a):
    for row in a["verification"]:
        cross = datetime.fromisoformat(row["crossing_at"])
        for s in row["sends"]:
            at = datetime.fromisoformat(s["send_at"])
            assert at < cross, f"{row['street']} {s['tier']} arrives at/after the crossing"
            lag = (cross - at).total_seconds() / 3600
            assert lag >= s["hours_to_crossing"] - 1e-9, (
                "a send is closer to the water than its own tier claims")


def test_quiet_hours_hold_the_first_two_tiers_only(a):
    for row in a["verification"]:
        for s in row["sends"]:
            if s["deferred_from"] is None:
                continue
            assert s["tier"] != "now", "the 6-hour alert was held for quiet hours"
            at = datetime.fromisoformat(s["send_at"])
            local = at.astimezone(notifications.TZ)
            assert local.hour == a["policy"]["quiet_hours"]["to_local_hour"]
            assert datetime.fromisoformat(s["deferred_from"]) < at


def test_no_send_is_duplicated_or_late(a):
    sim = a["simulation"]
    assert sim["duplicates"] == 0
    assert sim["sent_after_the_water"] == 0
    assert sum(t["sent"] for t in sim["per_tier"]) == sim["sends"]
    assert sim["sends"] == sim["streets_warned"] * len(a["tiers"]), (
        "every warned street should get every tier inside this record")


def test_the_alert_population_is_the_backcasts(a, derived_json):
    """Same rule, same population, same number: if these diverge, the alert is measuring
    something other than the lead time the app reports."""
    bc = derived_json("harvey_backcast.json")
    assert a["simulation"]["streets"] == bc["street_lead_time"]["segments"]
    assert a["simulation"]["streets_warned"] == \
        bc["street_lead_time"]["segments_reaching_threshold"]


def test_the_quiet_hours_hold_cannot_swallow_a_tier(a):
    """Why `held_past_crossing` is zero by construction rather than by luck: the longest
    hold (22:00 to 07:00) is 9 h, and the shortest held tier is 24 h out."""
    q = a["policy"]["quiet_hours"]
    longest_hold = (24 - q["from_local_hour"]) + q["to_local_hour"]
    assert longest_hold == 9
    assert longest_hold < min(a["tiers"][0]["hours_before"], a["tiers"][1]["hours_before"])
    assert all(t["held_past_crossing"] == 0 for t in a["simulation"]["per_tier"])


# ---- the shipped copy --------------------------------------------------------

def test_the_artifact_is_exported_verbatim(root):
    src = (DERIVED / ARTIFACT).read_bytes()
    dst = (PUBLIC / ARTIFACT).read_bytes()
    assert src == dst, "app/public/data/notifications.json is not the derived artifact"


def test_the_app_fetches_the_artifact(a, root):
    src = (root / "app" / "src" / "main.ts").read_text()
    assert f'DATA + "{ARTIFACT}"' in src, (
        "the payload ships notifications.json but the app never fetches it")
