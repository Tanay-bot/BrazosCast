"""T2b — the app's state contract.

The shareable state is the one feature that carries a household's address OUT of the
app: into a URL, a clipboard, a group chat. Three properties make that safe and
useful, and none of them is visible to `tsc` or to the payload contract test:

1. **Nothing is stored on the device.** "1234 Collins Rd" in a link is fine because
   the user chose to send it; the same string in `localStorage` is an address kept
   on the machine after they have gone. There is no cache, no cookie, no store —
   deliberately, and this test keeps it that way.
2. **One history entry per view.** The URL is written with `replaceState`, never
   pushed. `render()` is on every state change, so a push there would leave two
   identical entries per keystroke and back would not go back.
3. **Unknown parameters survive.** `syncUrl` re-seeds from `location.search` rather
   than building a query from scratch, which is why `?text=1` (F5, not built yet)
   round-trips today instead of being stripped by a link that claims to preserve it.

These are asserted against the source rather than a browser because the repo has no
browser runner yet (T7). That is a weakness: a rewrite could keep the behaviour and
fail here, or drop it and pass a looser reading. The assertions are written against
the specific mechanism each property depends on, and each failure message says which
property was lost, so the cost of a false failure is one comment.
"""
import re

APP = "app/src/main.ts"
SHELL = "app/index.html"


def source(root) -> str:
    return (root / APP).read_text()


def shell(root) -> str:
    return (root / SHELL).read_text()


def body_of(src: str, signature: str) -> str:
    """The `{...}` body of the first function whose header contains `signature`.

    Scoped rather than whole-file, so an unrelated `p.set` elsewhere cannot satisfy
    an assertion about `syncUrl`.
    """
    start = src.find(signature)
    assert start != -1, f"no function containing {signature!r} in {APP}"
    open_brace = src.index("{", start)
    depth = 0
    for i in range(open_brace, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[open_brace : i + 1]
    raise AssertionError(f"unbalanced braces after {signature!r} in {APP}")


def test_the_address_is_never_stored_on_the_device(root):
    """A link the user sends is a choice; a cached address is not."""
    for path in (root / APP, root / SHELL):
        text = path.read_text()
        for api in ("localStorage", "sessionStorage", "indexedDB", "document.cookie"):
            # Reading would still be a stored address somewhere; both are refused.
            hits = [ln.strip() for ln in text.splitlines() if api in ln]
            assert not hits, (
                f"{api} appears in {path.name}, so a household's address can outlive the "
                f"visit. The app's state is the URL on purpose — remove the storage, not "
                f"this test. Offending line(s): {hits}")


def test_the_url_is_replaced_and_never_pushed(root):
    src = source(root)
    assert "history.replaceState" in src, (
        "the app no longer writes the URL at all, so a shared link describes nothing")
    pushed = [ln.strip() for ln in src.splitlines()
              if re.search(r"history\.pushState", ln) and not ln.startswith("*")]
    assert not pushed, (
        "history.pushState appeared: render() runs on every state change, so pushing "
        "leaves duplicate entries and back becomes a no-op. The URL is the way an answer "
        f"travels, not the back button — use replaceState. Offending line(s): {pushed}")

    sync = body_of(src, "function syncUrl")
    assert "replaceState" in sync, (
        "syncUrl no longer replaces the URL, so the address bar can disagree with the screen")


def test_unknown_url_parameters_survive_a_state_change(root):
    """`?text=1` is planned, not built. A link must not eat a flag it does not know."""
    sync = body_of(source(root), "function syncUrl")
    assert "new URLSearchParams(location.search)" in sync, (
        "syncUrl builds its query from scratch instead of re-seeding from the incoming "
        "URL, so any parameter this version does not know about is stripped by a link — "
        "including ?text=1 when it lands")

    for key in ("addr", "stage", "mode"):
        assert re.search(rf'p\.(set|delete)\("{key}"', sync), (
            f"syncUrl no longer writes {key!r}, so the link cannot restore that part of "
            f"the view")


def test_the_share_control_is_present_and_wired(root):
    html = shell(root)
    assert 'id="share"' in html and "Copy link" in html, (
        "the share control is gone from the answer card, so an answer cannot be carried out")
    assert "shareNote" in html, "the share row has no place to report success or refusal"

    src = source(root)
    assert re.search(r'\$\("share"\)\.addEventListener\("click"', src), (
        "the share button is no longer wired to a handler")
    assert re.search(r"navigator\.share", src), (
        "the native share sheet is gone; on a phone that is how the link actually travels")
    assert re.search(r"navigator\.clipboard\.writeText", src), (
        "the clipboard fallback is gone, so the button does nothing on desktop")
    # The refusal path is the difference between a button that reports a failure and
    # one that appears to work and silently drops the link.
    assert "Copy this link:" in src, (
        "the clipboard-refusal fallback is gone; a refused write must show the link "
        "rather than look like it succeeded")


def test_the_share_note_is_cleared_when_the_view_moves(root):
    """A stale 'Copy this link: <url>' points at the PREVIOUS answer.

    Found by reasoning rather than by a failing test: the refusal path prints the URL,
    and nothing reset it when the stage or the street changed, so the user was told to
    copy a link to the view they had just left.
    """
    src = source(root)
    assert re.search(r'shareNote"\)\.textContent = SHARE_NOTE_AT_REST', src), (
        "the share note is never reset when the URL changes, so a refusal message can "
        "survive into a different view and point at the wrong answer")
    sync = body_of(src, "function syncUrl")
    assert "SHARE_NOTE_AT_REST" in sync, (
        "the reset moved out of syncUrl, which is the only place that knows the URL moved")
    default = re.search(r'SHARE_NOTE_AT_REST = "([^"]+)"', src)
    assert default and default.group(1) in shell(root), (
        "the note's at-rest text and the markup's initial text disagree, so the row "
        "starts with one sentence and returns to a different one")
