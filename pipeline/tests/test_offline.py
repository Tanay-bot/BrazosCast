"""F6 — the offline contract, at the source.

The service worker's behaviour is checked by running the built file
(`scripts/check-offline.mjs`). What belongs here is the half a source test can hold
better than an execution can: the rules that are one edit away from being violated in a
way that still works in a browser with a network. In particular

  - the registration must not exist in a dev server, where caching modules is the one
    bug worse than being offline;
  - the eager set must stay the shell, or the offline mode quietly takes back the
    bytes `?text=1` (F5) was built to save — 1.6 MB of payload on every first visit;
  - nothing may be stored with the encoding headers a compressing host sent, or the
    cached copy is a page the browser refuses to parse;
  - the live gauge must never be answered from the cache while the network is there.

Each test names what breaks in production when it goes.
"""
import re

SW = "app/public/sw.js"
MAIN = "app/src/main.ts"
SHELL = "app/app.html"


def worker(root) -> str:
    path = root / SW
    assert path.exists(), (
        f"{SW} is missing. Vite copies app/public/ to the dist root, so without the file at "
        "that exact path the build ships no worker and nothing is offline-capable."
    )
    return path.read_text()


def main_ts(root) -> str:
    return (root / MAIN).read_text()


def code_of(src: str) -> str:
    """The worker with its comments removed.

    These assertions are about what the code does, and sw.js explains itself at length —
    including naming the tile host it deliberately does NOT cache. Matching against the
    prose would test the comment instead of the behaviour. Line comments are stripped only
    where the line IS a comment, because "https://..." inside a string is not one.
    """
    without_blocks = re.sub(r"/\*[\s\S]*?\*/", "", src)
    return "\n".join(
        line for line in without_blocks.splitlines() if not line.strip().startswith("//")
    )


def body_of(src: str, signature: str, where: str) -> str:
    """The `{...}` body of the first function whose header contains `signature`."""
    start = src.find(signature)
    assert start != -1, f"no function containing {signature!r} in {where}"
    open_brace = src.index("{", start)
    depth = 0
    for i in range(open_brace, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[open_brace : i + 1]
    raise AssertionError(f"unbalanced braces after {signature!r} in {where}")


def test_the_worker_is_registered_only_for_a_real_build(root):
    """A service worker in front of the dev server serves yesterday's modules from URLs
    that still look current, and the failure looks like the code not being applied."""
    body = body_of(main_ts(root), "function registerOffline()", MAIN)
    guard = body.find("import.meta.env.PROD")
    register = body.find('serviceWorker.register("./sw.js")')
    assert guard != -1, (
        "registerOffline() no longer checks import.meta.env.PROD. In a dev server that means "
        "the worker caches unhashed modules, so an edited file has no effect until the cache "
        "is cleared by hand — the one failure a service worker can add to a working setup."
    )
    assert register != -1, "registerOffline() no longer registers ./sw.js"
    assert guard < register, (
        "the production guard must come before the registration call, or a dev server has "
        "already registered by the time the guard is consulted"
    )
    assert not re.search(r'register\(\s*["\']/', body), (
        'the worker is registered from an absolute path. vite.config.ts sets base "./" so the '
        "app is deployable under a subpath, where that URL is a 404 and the app silently has "
        "no worker at all."
    )


def test_registration_cannot_hold_up_the_answer(root):
    src = main_ts(root)
    assert re.search(r"^registerOffline\(\);", src, re.M), (
        "registerOffline() is no longer called at module scope next to boot(), so it either "
        "runs after the first render or not at all"
    )
    assert not re.search(r"await\s+navigator\.serviceWorker", src), (
        "the registration is awaited, so every page load waits on it — an offline capability "
        "must not become a startup cost"
    )
    assert "serviceWorker.register(\"./sw.js\").catch(" in src, (
        "nothing handles a rejected registration. It rejects routinely (no HTTPS on some "
        "hosts, a browser that refuses the script) and must never surface as an error over "
        "the answer the page is already showing."
    )


def test_the_eager_set_is_the_shell_and_nothing_else(root):
    """The whole point of F5 is that a phone on a bad connection gets an answer. Precaching
    the 1.6 MB payload at install would spend exactly what F5 measured and saved."""
    src = code_of(worker(root))
    # Any quoted path, not just a bare filename: the eager-set bug looks like
    # `new URL("data/ensemble.json", ROOT)`, and a pattern anchored on the filename alone
    # would have watched that go past.
    payload = re.findall(r'["\']([^"\']*\.(?:json|geojson))["\']', src)
    assert not payload, (
        f"{SW} names payload file(s) {sorted(set(payload))}. The eager set must be the shell: "
        "the eight data files are 1.6 MB and are fetched by the app on every boot anyway, so "
        "caching them when the app asks costs nothing, and caching them at install costs "
        "every first visit."
    )
    assert "shellAssets(" in src, (
        "the worker no longer derives the shell's files from the built HTML. The entry chunk "
        "and its stylesheet carry content hashes that change every build, so a hand-written "
        "list breaks silently on the next one."
    )
    assert not re.search(r'["\'][^"\']*assets/[^"\']+["\']', src), (
        "a hashed asset filename is hard-coded in the worker; it will stop existing on the "
        "next build and the shell would then be cached without its entry chunk"
    )
    assert "pruneShell(" in src, (
        "the shell cache is never pruned, so every previous build's chunks stay in it for "
        "ever — the same ADD-only bug T4 found in the payload export"
    )


def test_nothing_is_stored_with_the_hosts_encoding_headers(root):
    """A body read in a worker is decoded, while the headers can still say gzip. Storing
    that pair is a cached page the browser tries to gunzip out of plain text."""
    src = worker(root)
    writes = [m.end() for m in re.finditer(r"\.put\(", src)]
    assert writes, "no cache writes found in the worker at all — has caching been removed?"
    allowed = ("plain(", "shellResponse(", "new Response(entry.body")
    for start in writes:
        rest = src[start:]
        args = rest[: rest.index(";")]
        second = args[args.index(",") + 1 :].strip()
        assert second.startswith(allowed), (
            f"a response reaches the cache through {second[:40]!r}, which is not plain(), not "
            "shellResponse() and not the bytes the page handed over. Those two strip "
            "content-encoding and content-length because the stored body is decoded: keeping "
            "the headers makes the cached copy unparseable offline. (`new Response(entry.body` "
            "is the exception and is safe by construction — those bytes came from the page in "
            "a message, so there is no host response whose headers could leak into them.)"
        )
    # The stripping lives in `cacheable()`, and the pair of wrappers has to go through it.
    # Asserted this way round on purpose: one place that can be wrong is a stronger contract
    # than two copies of the same two lines, which is what this used to check.
    stripper = body_of(src, "function cacheable(", SW)
    for header in ("content-encoding", "content-length", "vary"):
        assert f'headers.delete("{header}")' in stripper, (
            f"cacheable() no longer drops {header} from a stored response"
        )
    for fn in ("plain", "shellResponse"):
        body = body_of(src, f"function {fn}(", SW)
        assert "cacheable(res)" in body, (
            f"{fn}() stopped building its headers through cacheable(), so a stored body can "
            "keep the host's encoding and content-length again"
        )


def test_the_live_gauge_is_never_answered_from_the_cache_first(root):
    """An old reading presented as the current one is the failure mode this product exists
    to avoid; the app's own staleness labels only work if it is given the truth."""
    src = worker(root)
    body = body_of(src, "async function gauge(", SW)
    fetch_at = body.find("await fetch(req)")
    # Any cache lookup, whichever receiver it is written on. Matching the literal
    # "cache.match(req" is what let a cache-first rewrite of this function pass: a lookup
    # written as `caches.match(req, MATCH)` — the same call under the other spelling — did
    # not match, so the assertion compared the fetch against the fallback further down and
    # reported the wrong order as the right one.
    match_at = re.search(r"\.match\(req", body)
    assert fetch_at != -1, "gauge() no longer fetches the live reading at all"
    assert match_at, (
        "gauge() no longer falls back to the cached reading, so an outage leaves the app with "
        "nothing but its own upstream estimate"
    )
    assert fetch_at < match_at.start(), (
        "gauge() consults the cache before the network. The network-first order is what keeps a "
        "cached reading from beating a fresh one; the fallback belongs in the failure path."
    )


def test_data_is_answered_from_the_cache_before_it_is_refreshed(root):
    """Stale-while-revalidate is the promise that a slider drag does not wait on the
    network for a threshold the device already has."""
    src = worker(root)
    body = body_of(src, "function staleWhileRevalidate(", SW)
    answer = body.find("const answer = (async () => {")
    assert answer != -1, "staleWhileRevalidate() no longer separates the answer from the refresh"
    tail = body[answer:]
    hit_at = tail.find("caches.match(req")
    fresh_at = tail.find("await fresh")
    assert hit_at != -1, "the answer path no longer looks in the cache"
    assert hit_at < fresh_at, (
        "the cached copy is checked only after the network has been awaited, which is "
        "cache-first-with-a-slow-first-paint: the data request blocks the render it was "
        "supposed to unblock."
    )
    assert "waitUntil" not in body and "event" not in body, (
        "staleWhileRevalidate() started taking the event itself; it must RETURN its two "
        "promises so the fetch handler can hand the refresh to waitUntil — a background "
        "refresh nobody waits for can be killed before it writes."
    )


def test_tiles_and_fonts_are_left_to_the_browser(root):
    src = code_of(worker(root))
    for pattern, why in (
        (r"tile\.openstreetmap\.org", "the base-map tile host is named in the worker"),
        (r"fonts\.(googleapis|gstatic)\.com", "a webfont host is named in the worker"),
    ):
        assert not re.search(pattern, src), (
            f"{why}. Tiles are unbounded in number and the OSM tile service is explicitly not "
            "for offline collection; the fonts are the 85 KB `?text=1` exists to avoid "
            "downloading. Caching either would take back F5 and grow without limit."
        )
    for cross_origin_host in re.findall(r'const ([A-Z_]+_HOST) = "([^"]+)"', src):
        assert cross_origin_host[1] == "api.water.noaa.gov", (
            f"the worker now intercepts {cross_origin_host[1]} as well; every cross-origin "
            "request it handles is a request whose cost and lifetime somebody has to bound"
        )


def test_the_first_visit_hands_over_what_it_already_paid_for(root):
    """The page fetches its payload before the worker controls it, so without this the
    offline copy only starts existing on the SECOND visit — and the storm would have to
    arrive after a page load it politely waited through.

    The list it hands over is the RESOURCE TIMELINE, not a list of filenames, and that is
    the contract now: MapLibre's chunk and stylesheet carry content hashes no source file can
    name, and a hand-written list is a list that silently stops matching. What this holds is
    that the hand-over still exists, still reports what the page loaded, still happens after
    the loads it reports, and still reaches the files the app ships.
    """
    src = main_ts(root)
    loader = body_of(src, "function loadedHere(", MAIN)
    assert 'getEntriesByType("resource")' in loader, (
        "loadedHere() no longer reads the resource timeline. That was the fix for a first "
        "visit whose map chunk — a content-hashed file the bundler emits — was never cached, "
        "so an offline reload rendered the answer with no map at all."
    )
    assert "location.origin" in loader, (
        "loadedHere() stopped filtering to this origin, so the worker is offered the tile "
        "hosts and the gauge to fetch"
    )

    load_static = body_of(src, "async function loadStatic()", MAIN)
    fetches = load_static.find("await Promise.all([")
    hand_over = load_static.find("keepOfflineCopy(loadedHere())")
    assert fetches != -1 and hand_over != -1, (
        "loadStatic() no longer hands over what it loaded. A first visit would then cache "
        "nothing but the shell, and the worker would only see this payload on a second load."
    )
    assert fetches < hand_over, (
        "the hand-over runs before the payload is fetched. It reports what the browser already "
        "holds, so run early it reports nothing and caches nothing."
    )
    # The payload the app ships is what the timeline will contain, so every shipped file has
    # to be one the app asks for somewhere. `replay-harvey.json` is fetched by loadReplay(),
    # which is not part of boot — and it is fetched exactly when it will be needed.
    payload = sorted(p.name for p in (root / "app" / "public" / "data").iterdir())
    landing = (root / "app" / "src" / "landing.ts").read_text()
    named_by = src + landing   # the landing serves a street from street_thresholds.json
    unnamed = [name for name in payload if name not in named_by]
    assert not unnamed, (
        f"{unnamed} ship(s) in app/public/data but is never named in the app or landing sources, so no load of "
        "the app can put it in the timeline and the offline copy can never include it"
    )
    assert "keepOfflineCopy(loadedHere())" in load_static, (
        "the payload is no longer handed to the worker after loading, so a first visit has no "
        "offline copy of it"
    )
    assert "keepOfflineCopy([{ url: DATA + \"replay-harvey.json\" }])" in src, (
        "replay-harvey.json is no longer cached. Replay is the app's fallback when the gauge "
        "cannot be read, which is precisely when the connection is likely to be the problem."
    )


def test_the_gauge_is_handed_over_rather_than_fetched_twice(root):
    """468 KB with no validator, measured: a conditional request returns the whole body, so
    the only cheap copy of the last reading is the one the page already holds."""
    src = main_ts(root)
    body = body_of(src, "async function fetchLive()", MAIN)
    read_text = body.find("await r.text()")
    hand_over = body.find("keepOfflineCopy([{ url, body: raw")
    assert read_text != -1, (
        "fetchLive() parses the gauge response with .json(), so the raw bytes are gone by the "
        "time the cache could be given them"
    )
    assert hand_over != -1, (
        "the gauge body is no longer handed to the worker. A first visit would then have no "
        "reading offline, and `only-if-cached` cannot supply one: only-if-cached is same-origin "
        "only, and the gauge is a cross-origin request."
    )
    assert read_text < hand_over, "the body must be read before it can be handed over"
    poster = body_of(src, "function keepOfflineCopy(", MAIN)
    assert "fetch(" not in poster, (
        "keepOfflineCopy() fetches. It exists to avoid re-downloading what the page already has; "
        "a fetch here would be the payload paid for twice."
    )
    assert "serviceWorker.ready" in poster and "postMessage" in poster, (
        "the hand-over no longer waits for an active worker and posts to it, so on the first "
        "visit — the only visit it matters for — the message goes nowhere"
    )


def test_the_warm_up_asks_for_what_the_browser_already_has(root):
    """The worker side of the same promise.

    The mechanism here was wrong once and the shape of the mistake is worth keeping in the
    test: the warm-up copied the files out of the browser's HTTP cache with `only-if-cached`,
    which reads like the cheapest possible way to do it and is in fact a no-op. That cache
    mode can only be satisfied by a response the browser can produce without the network, and
    `Cache-Control: no-cache` — what the preview server and every static host send for HTML
    and JSON — requires a revalidation, which the mode forbids. Measured in a real browser,
    every copy rejected; the payload was arriving in the cache by the ordinary path (the
    page's own fetches, once the worker controls it) and the map's chunks, which are fetched
    before that, were not arriving at all, so a first visit then an outage had no map.

    What works is asking for the URL the way the page asked for it: the browser answers out
    of what it holds — a conditional request at worst, never the body again.
    """
    src = worker(root)
    body = body_of(src, "async function warm(", SW)
    assert not re.search(r'cache: "only-if-cached"', body), (
        "the warm-up is back to `only-if-cached`. It cannot be satisfied by a response that "
        "has to be revalidated, which is every response these hosts serve, so it silently "
        "copies nothing: the check that would catch it is the browser one, and this is the "
        "cheaper place to catch it."
    )
    assert re.search(r"await fetch\(url\.href\)", body), (
        "the warm-up no longer fetches a URL at all, so nothing is copied out of what the "
        "browser already has and a first visit stays shell-only"
    )
    assert re.search(r'typeof entry\.body === "string"', body), (
        "the warm-up no longer accepts a body from the page, which is the only way the gauge "
        "can be cached without a second 468 KB download"
    )
    cached_first = body.find("caches.match(url.href")
    fetched = body.find("await fetch(url.href)")
    assert cached_first != -1 and cached_first < fetched, (
        "the warm-up fetches before checking whether the entry is already there, so every "
        "visit asks the origin for files the worker is already holding"
    )
    assert body.find("if (url.origin !== self.location.origin) return;") != -1, (
        "the warm-up stopped restricting itself to this origin. The app reports every URL it "
        "loaded, which includes the tile host: fetching those is exactly the unbounded, "
        "not-for-offline collection the worker refuses to do anywhere else."
    )
    handler = body_of(src, 'self.addEventListener("message"', SW).replace("\n", " ")
    assert 'msg.type !== "offline-copy"' in handler, (
        "the worker no longer checks the message type before acting on it"
    )


def test_the_offline_tag_reports_the_browser_rather_than_guessing(root):
    """The app already labels a stale reading. What it could not say was that the machine is
    offline — which is the difference between 'no news' and 'nothing is being fetched'."""
    html = (root / SHELL).read_text()
    assert re.search(r'id="offlineTag"[^>]*hidden', html), (
        "the offline tag is not in app.html hidden by default, so it either cannot be shown "
        "before the first paint or it is shown to everyone"
    )
    body = body_of(main_ts(root), "function wireOfflineTag()", MAIN)
    assert "navigator.onLine" in body, (
        "the tag is no longer driven by navigator.onLine, so it claims something the browser "
        "did not say"
    )
    assert 'addEventListener("offline"' in body and 'addEventListener("online"' in body, (
        "the tag no longer listens for the connection changing, so it is right only at load"
    )
    boot = body_of(main_ts(root), "async function boot()", MAIN)
    assert "wireOfflineTag()" in boot, (
        "boot() no longer wires the offline tag; a reload during an outage would show the "
        "cached answer with nothing saying it is cached"
    )
    offline_pos = boot.find("wireOfflineTag()")
    first_await = boot.find("await loadStatic()")
    assert -1 < offline_pos < first_await, (
        "the offline tag is wired after the first await, so a reload with no connection shows "
        "a page with no explanation for however long the data takes to fail"
    )
