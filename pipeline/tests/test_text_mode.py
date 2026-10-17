"""T2c — the `?text=1` contract.

The text-only route is the only part of the app whose correctness is a number of bytes,
and it is built out of ABSENCES: the map is not built, MapLibre is not imported, the
canvas is not drawn, the webfonts are not attached. An absence is exactly the kind of
thing a later refactor restores without noticing, because restoring it breaks nothing —
the page still works, it is just no longer light.

So each absence is pinned to the mechanism it depends on, and each test says what is
lost when it goes. The build-level half of the same claim — that MapLibre really is a
separate chunk, and the guard really survives minification — is
scripts/check-text-mode.mjs, because that is a question about dist/ rather than source.

Two things here are deliberately NOT asserted:
  - that text mode "looks right" (that is a browser question, T7);
  - the byte totals, which belong to the build check and the README's measurement.
"""
import re

MAIN = "app/src/main.ts"
SHELL = "app/app.html"
CSS = "app/src/style.css"


def source(root) -> str:
    return (root / MAIN).read_text()


def shell(root) -> str:
    return (root / SHELL).read_text()


def body_of(src: str, signature: str) -> str:
    """The `{...}` body of the first function whose header contains `signature`."""
    start = src.find(signature)
    assert start != -1, f"no function containing {signature!r} in {MAIN}"
    open_brace = src.index("{", start)
    depth = 0
    for i in range(open_brace, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[open_brace : i + 1]
    raise AssertionError(f"unbalanced braces after {signature!r} in {MAIN}")


def test_maplibre_is_not_a_static_import(root):
    """A static import puts 218 KB in the entry chunk for EVERY visitor.

    Any static form counts, whatever the local name: a build-level check
    (scripts/check-text-mode.mjs) catches it in dist/ too, but this one says so at the
    point of the edit, and it caught the version that renamed the binding to `gl`.
    """
    src = source(root)
    offenders = [
        ln.strip() for ln in src.splitlines()
        if re.match(r"import\s+(?!type\b)[^;]*from\s*[\"']maplibre-gl[\"']", ln.strip())
        or re.match(r"import\s+[\"']maplibre-gl/", ln.strip())
    ]
    assert not offenders, (
        "MapLibre is imported statically again, so the text-only route downloads the map "
        "it promises to skip (MapLibre's JS+CSS is 226 KB gzipped, 44% of the route's own "
        f"same-origin bytes). It must be imported inside buildMap() only. Offending: {offenders}"
    )
    # The type import is erased at build time and is what keeps the annotations honest.
    assert re.search(r"import type maplibregl from [\"']maplibre-gl[\"']", src), (
        "the type-only import is gone; MapLibre's types are needed for the map annotations "
        "without being emitted, and losing it usually precedes re-adding the static import"
    )


def test_buildmap_defers_the_library_until_after_the_guard(root):
    build = body_of(source(root), "async function buildMap")
    guard = build.find("if (textOnly) return;")
    dynamic = build.find('import("maplibre-gl")')
    construct = build.find("new maplibregl.Map(")
    assert guard != -1, (
        "buildMap() no longer refuses to run in text mode, so every text-only visitor "
        "downloads MapLibre")
    assert dynamic != -1, (
        "the dynamic import of maplibre-gl is gone, so the library cannot be code-split "
        "out of the entry chunk")
    assert guard < dynamic < construct, (
        "the textOnly guard must come BEFORE the dynamic import and the Map construction, "
        "or the download has already started by the time the flag is consulted")


def test_the_map_and_the_chart_are_skipped_not_merely_hidden(root):
    src = source(root)
    render = body_of(src, "function render()")
    assert re.search(r"if \(!textOnly\) drawChart\(\);", render), (
        "drawChart() is no longer skipped in text mode — a canvas is drawn and thrown away, "
        "which is the battery cost the route exists to avoid")
    assert "syncMap()" in render, (
        "syncMap() should still be called in render(); it no-ops without a map, and guarding "
        "it here as well would let the full-view path rot silently")
    assert "mapNote" in render, (
        "render() no longer writes the flood count, which is the sentence the map was only "
        "illustrating — text mode must keep it")
    assert "renderChartText()" in render, (
        "render() no longer fills the chart's text equivalent, so text mode has an empty "
        "chart card")


def test_the_chart_text_is_the_same_series_as_the_canvas(root):
    """A second, independently computed summary would be a second thing to drift."""
    src = source(root)
    fn = body_of(src, "function renderChartText()")
    assert "seriesWindow()" in fn, (
        "the text summary stopped reading the series the canvas draws, so the two can now "
        "disagree about the same flood")
    assert "crossingHours(" in fn, (
        "the text summary no longer says when the selected street is reached, which is the "
        "one thing a reader would have taken from the curve")


def test_the_flag_is_read_before_anything_is_fetched(root):
    boot = body_of(source(root), "async function boot()")
    assert "textOnly = pendingUrl.text" in boot, (
        "boot() no longer takes text mode from the URL, so the flag is decided somewhere "
        "later — and 'later' means after MapLibre has started downloading")
    order = [
        boot.find("pendingUrl = readUrl()"),
        boot.find("textOnly = pendingUrl.text"),
        boot.find("applyTextMode()"),
        boot.find("buildMap()"),
        boot.find("await loadStatic()"),
    ]
    assert all(i != -1 for i in order), "a boot step is missing: one of readUrl/applyTextMode/buildMap/loadStatic"
    assert order == sorted(order), (
        f"boot() runs its steps out of order ({order}): the URL must be read before the map "
        "is built, or the route cannot know the visitor asked not to have it")


def test_the_flag_travels_in_the_url(root):
    src = source(root)
    assert re.search(r'const TEXT_PARAM = "text"', src), (
        "the parameter name is no longer a single named constant; it is then free to drift "
        "from the inline font guard in app.html, which tests the same token")
    assert re.search(r"text: p\.get\(TEXT_PARAM\) === \"1\"", src), (
        "readUrl() no longer recognises ?text=1")
    sync = body_of(src, "function syncUrl")
    assert re.search(r"if \(textOnly\) p\.set\(TEXT_PARAM, \"1\"\); else p\.delete\(TEXT_PARAM\)", sync), (
        "syncUrl() no longer carries the view flag, so a copied link from text mode arrives "
        "heavy — and a copied link from the full view drags text mode along")
    assert "viewHref(p, !textOnly)" in sync, (
        "the view toggle's href is no longer rebuilt from the current parameters, so "
        "switching views would drop the street, the stage and the data mode")


def test_the_inline_font_guard_tests_the_same_token(root):
    """The flag is stated twice on purpose; the two statements must not diverge."""
    src = source(root)
    name = re.search(r'const TEXT_PARAM = "([^"]+)"', src)
    assert name, "TEXT_PARAM is gone from main.ts"
    guard = re.search(r"if \(!/\[\?&\](\w+)=1\(&\|\$\)/\.test\(location\.search\)\)", shell(root))
    assert guard, (
        "the inline font guard in app.html no longer tests a URL parameter, so the "
        "webfonts (84.6 KB measured) load in text mode")
    assert guard.group(1) == name.group(1), (
        f"the font guard tests ?{guard.group(1)}=1 and main.ts reads ?{name.group(1)}=1 — one "
        "of them has been renamed, and a text-only visitor would now get the fonts and the "
        "map, or neither, depending on which half ran")
    assert "location.search" in shell(root), (
        "the guard must run against the URL, not against a flag the module sets later — "
        "by then the browser has already requested the stylesheet")


def test_text_mode_hides_the_map_and_the_chart_only(root):
    css = (root / CSS).read_text()
    for selector in ("#map", ".legend", ".hgwrap"):
        assert re.search(rf"body\.text-only[^{{]*{re.escape(selector)}", css), (
            f"text mode no longer hides {selector}, so the route still reserves the pixels it "
            "was supposed to drop")
    assert re.search(r"body\.text-only \.chart-text\{display:block\}", css), (
        "the chart's text equivalent is not shown in text mode, so the card is empty")
    assert ".chart-text{display:none" in css.replace(" ", ""), (
        "the chart summary is not hidden by default, so the full view shows it twice")
    # The map card itself stays: it holds the flood count, which is content, not decoration.
    assert not re.search(r"body\.text-only \.map-card\s*\{[^}]*display\s*:\s*none", css), (
        "text mode hides the whole map card, which also hides the 'N of 1614 segments under "
        "water' line — that sentence is the reason the map was on the page")
