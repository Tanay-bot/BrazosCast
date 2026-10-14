# BrazosCast — build plan (v0, 2026-10-14)

Synthesis of the three source docs (strategy brief, product spec, HTML prototype) after verifying
every data dependency live. Read alongside [DATA-SOURCES.md](./DATA-SOURCES.md).

---

## 1. What the three documents agree on (and it's the right core)

Both long docs converge, and the convergence is the strongest signal in the pack:

- **The answer is hours, not feet.** "Water reaches your street at 3:10 AM Thursday — you have 31 hours" is the product. Gauge readings are inputs.
- **Precompute at build time, serve static.** Each road segment carries one number (`floodAt`, the stage at which its lowest point submerges), so runtime flooding is a float comparison and routing is client-side. No model inference in the request path.
- **Replay mode is mandatory**, not a nicety — the live gauge was at **9.21 ft vs a 45 ft flood stage** the day this was written. A live demo shows a dry river.
- **Lead with the travel-time matrix** as the genuinely novel artifact: no published table says how long a Brazos crest takes to reach Richmond from Hempstead.
- **Be honest about novelty.** Inundation mapping (NOAA FIM), HAND, and CoFIS-style damage modeling already exist. The open seam is *translation to a specific address and a clock*.

I agree with all five. They are consistent, and they match the competition's actual judging shape.

## 2. Where the docs are wrong or thin (verified)

| Claim in docs | Reality (2026-10-13/14) | Action |
|---|---|---|
| OpenFEMA v3 at `FimaNfipClaims` | 404. Real path is **`/api/open/v3/NfipClaims`** | Fixed in fetcher; cached 7,389 claims. |
| v3 keeps `censusTract`/`censusBlockGroupFips` | Renamed to **`censusGeoid`** | Fixed. |
| `gisweb.fortbendcountytx.gov` FEMA zones | **522, down** | Use **FEMA NFHL** (already the fallback). |
| "cache claims today" | v2 still 200 *now*, removed **tomorrow** | **Done** — cached 7,389 claims already. |
| Pipeline assumes fimserve/GDAL/aws | None installed; Python 3.9.6 | Must build an environment before the geo rungs. |
| `window.print()` for household card | Blocked in the artifact viewer | Ship a **copyable** card (spec already notes this). |
| Address geocoding | **Not specified anywhere** | Gap — must choose a geocoder (§5). |
| "Your street's low point" | Needs DEM sampling over a street segment | This *is* the geospatial pipeline; no shortcut named. |

## 3. The one finding worth leading with

From the now-cached OpenFEMA data (7,389 Fort Bend claims):

- **66.2% of claims** were rated in an **X zone** (outside the mapped 100-yr SFHA).
- **67.3% of building dollars** paid went to X-zone claims.
- **Harvey (Aug–Sep 2017): 73.8%** of claims were X-zone.

> The county's floodplain map did not warn the majority of residents who actually got flooded.

This is the empirical spine of the whole pitch and it is now a *measured local number*, not a citation.

## 4. Proposed critical path (honoring the spec's "ship Friday" rule)

The spec's organizing principle — **a deployed, demoable artifact by Fri Oct 17** — is correct and
should not be traded away for model depth. My sequencing:

**Phase 0 — foundation (now → Oct 15).** ✅ repo, fetch script, cached sources, verified endpoints, this plan.
- Also: real **replay dataset** for the Harvey / 2016 events (USGS IV historical for the 7 gauges).
- Also: **travel-time matrix** v0 (cross-correlation by discharge regime) — cheap, no ML, most original.

**Phase 1 — the demo milestone (→ Oct 17).** Deployable static app on **real** data:
address → street threshold → lead-time answer → gauge-chain timeline → stage slider → map + exits →
forecast chart vs NWS → FEMA NFHL zone → tract NFIP context. Public URL + public repo.

**Phase 2 — model depth (Oct 18–21).** Street-level thresholds from DEM + OSM graph; XGBoost
baseline vs NWS vs NWM-retrospective; LSTM; head-to-head table. Report a loss honestly if it loses.

**Phase 3 — human layer (Oct 22–23).** Multilingual templates, three-tier alerts (simulated send),
household card, error states, freeze.

**Phase 4 — submission (Oct 24–25).** Video, six written responses, AI disclosure, open-source
attribution, submit a day early.

Cut lines at every phase; the fallback ladder for inundation is
**fimserve → pysheds(1 m) → pysheds(1/3 arc-sec) → FEMA NFHL only**, and the app works at every rung.

## 5. Open decisions (need you)

1. **Stack:** spec prefers **vanilla TS + Vite** (small bundle) but allows React. Recommendation: vanilla TS.
2. **First milestone:** ship the static app on real data first, or build the ML/geo pipeline first? Recommendation: static first (it's the spec's own gate).
3. **Hosting:** Freebuff **Sites** (managed here) vs **Cloudflare Pages** vs **Netlify**. Needs the app to be a prebuilt static bundle eventually.
4. **Geocoder (unspecified in docs):** US **Census Geocoder** (free, no key, good for US addresses) vs Nominatim vs Mapbox. Recommendation: Census first, Mapbox only if it fails.
5. **Geo/ML environment:** install a modern Python (conda or `uv`) + GDAL + `aws` CLI now, or defer the heavy rungs and start from the NFHL floor? Recommendation: defer; start with what's installable today.

## 6. Updated risk register

| Risk | Status | Mitigation |
|---|---|---|
| OpenFEMA v2 removal | **Resolved** | v3 (`NfipClaims`) verified + cached. |
| FBC county GIS outage | **Active** | FEMA NFHL fallback verified working. |
| GDAL / fimserve install | **Active (likely sink)** | One 3-hour timebox, then pysheds; NFHL floor. |
| No `aws` CLI / old Python | **Active** | Install a purpose-built env before Phase 2. |
| Geocoder unspecified | **Open** | Decide at §5; Census Geocoder is the zero-key default. |
| "Beat NWM" is a hypothesis | **Open** | Present as a measurement; pivot claim to lead-time if it loses. |
| Dry-river live demo | **Resolved by design** | Replay mode, built first. |
| Scope sprawl | Watch | Single purpose; no heat/air/grid. |
| Real user data in demo | Watch | Seed crowd reports synthetically. |

## 7. Compliance checklist (non-negotiable)

- [ ] Register on the CAC portal **first** (personal email, 9-digit ZIPs, parent contact, quiz).
- [ ] Confirm the address is **TX-22** (Richmond splits with TX-7) via ZIP+4 / TLC viewer.
- [ ] Video **1–3 min**, public on YouTube/Vimeo; six mandatory elements.
- [ ] Full **AI-use disclosure**; must be able to explain every line.
- [ ] **Open-source attribution** with licenses in the README.
- [ ] Code written **after 2025-10-30** (build fresh).
- [ ] Submit **Sat Oct 25** (deadline Mon Oct 26, 11:00 AM CT; no edits after).
