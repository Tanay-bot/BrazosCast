#!/usr/bin/env node
/* Is the site actually open?
 *
 * The app has no login and never had one — a grep of app/src, both documents and
 * sites/ finds no auth code at all. What gated the preview host was Vercel's
 * Deployment Protection, which answers every request with a 302 to
 * `vercel.com/sso-api` unless the visitor has a Vercel session. That is a project
 * setting, not a file in this repo, so it can come back without a commit, a diff,
 * or any test noticing.
 *
 * A wall that returns a redirect is also the failure mode a monitor is worst at:
 * `curl` without -L reports a redirect as "some response", and a browser shows a
 * login page that looks like a site under maintenance. So this asks for the shapes
 * that must be open, refuses to follow a redirect, and names Deployment Protection
 * when it sees one.
 *
 * Usage:
 *   node scripts/check-public-access.mjs                      # the public alias
 *   node scripts/check-public-access.mjs <origin> [origin…]    # e.g. a preview URL
 *   PUBLIC_ORIGIN=… PREVIEW_ORIGIN=… node scripts/check-public-access.mjs
 *
 * Not part of scripts/check.sh's fast path: it needs the network, and a check that
 * fails when the wifi drops is a check people learn to ignore. `--public` runs it.
 */
const PUBLIC_DEFAULT = "https://brazos-cast.vercel.app";

/** What every open deployment must answer, and what proves it answered rather than
 *  served an interstitial. A status alone is not enough: Vercel's wall can 200 with
 *  an HTML login page, and a 200 on `/` that says "Log in" is exactly the state this
 *  exists to catch. */
const CASES = [
  { path: "/", kind: "html", marker: "BrazosCast", why: "the landing page is the front door" },
  { path: "/app", kind: "html", marker: 'id="map"', why: "/app is where \"Open map\" lands" },
  { path: "/data/ensemble.json", kind: "json", why: "the payload the app boots on" },
  { path: "/sw.js", kind: "js", marker: "addEventListener", why: "the offline worker" },
];

const SSO_HINTS = [/vercel\.com\/sso-api/i, /_vercel_sso/i, /Vercel Authentication/i, /Log in to Vercel/i];

/** A fetch-shaped answer — `{ status, headers, body }` — so the fixtures below run the
 *  same code as the network. `body` is text, never a stream: nothing here should be able to
 *  pass on a status alone. */
function inspect(origin, path, res) {
  const problems = [];
  const location = res.headers.get("location") ?? "";
  const blocked = res.status >= 300 && res.status < 400 && SSO_HINTS.some((re) => re.test(location));

  if (blocked) {
    problems.push(
      `${origin}${path} redirects to ${location} — that is Vercel Deployment Protection, ` +
      `not the app. Set Project → Settings → Deployment Protection → Vercel Authentication ` +
      `to Disabled (or Only Production), then re-run.`,
    );
    return problems;
  }
  if (res.status >= 300 && res.status < 400) {
    problems.push(`${origin}${path} answers ${res.status} → ${location || "(no location)"} instead of serving the file`);
    return problems;
  }
  if (res.status !== 200) {
    problems.push(`${origin}${path} answers ${res.status}, not 200`);
    return problems;
  }

  const body = res.body;
  const c = CASES.find((x) => x.path === path);
  if (c?.kind === "json") {
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length === 0) {
        problems.push(`${origin}${path} parses but is an empty object — a payload that lost its contents`);
      }
    } catch {
      problems.push(`${origin}${path} is not JSON (got ${body.slice(0, 60).replace(/\s+/g, " ")}…) — ` +
        `an SPA fallback answering 200 text/html for a JSON fetch looks exactly like this`);
    }
  }
  if (c?.marker && !body.includes(c.marker)) {
    problems.push(`${origin}${path} does not contain ${JSON.stringify(c.marker)}; it is not the ${c.why}`);
  }
  if (SSO_HINTS.some((re) => re.test(body))) {
    problems.push(`${origin}${path} contains a Vercel sign-in reference — the wall may be rendering with a 200`);
  }
  if (c?.marker && body.length < 200) {
    problems.push(`${origin}${path} is ${body.length} bytes — too small to be the file`);
  }
  return problems;
}

/* The validator's own test. A gate that has only ever seen a healthy deployment is a
 * gate nobody knows the shape of, so both fixtures are asserted on every run — cheap,
 * and it means a refactor that silently accepts a redirect fails immediately. */
async function selfTest() {
  const ok = {
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    body: "<!doctype html><title>BrazosCast — how many hours…</title>" + "x".repeat(220),
  };
  const gated = {
    status: 307,
    headers: new Headers({ location: "https://vercel.com/sso-api?url=x" }),
    body: "",
  };
  const health = await inspect("https://healthy.test", "/", ok);
  const wall = await inspect("https://gated.test", "/", gated);
  if (health.length !== 0) throw new Error(`self-test: a healthy response was rejected: ${health[0]}`);
  if (!wall.some((p) => /Deployment Protection/.test(p))) {
    throw new Error("self-test: the Vercel SSO redirect was NOT reported as Deployment Protection");
  }
  return "gated fixture rejected, healthy fixture accepted";
}

function originList(argv) {
  const fromArgv = argv.filter((a) => !a.startsWith("-"));
  const listed = fromArgv.length
    ? fromArgv
    : [process.env.PUBLIC_ORIGIN ?? PUBLIC_DEFAULT, process.env.PREVIEW_ORIGIN].filter(Boolean);
  return [...new Set(listed.map((o) => o.replace(/\/+$/, "")))];
}

async function checkOrigin(origin) {
  const problems = [];
  for (const c of CASES) {
    let res;
    try {
      res = await fetch(origin + c.path, {
        redirect: "manual",          // following the redirect would hide the wall
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      problems.push(`${origin}${c.path} could not be fetched: ${e.message}`);
      continue;
    }
    const body = await res.text();
    problems.push(...inspect(origin, c.path, {
      status: res.status, headers: res.headers, body,
    }));
  }
  return problems;
}

const origins = originList(process.argv.slice(2));
if (origins.length === 0) {
  console.error("no origin to check");
  process.exit(2);
}

console.log(`   validator: ${await selfTest()}`);

const failures = [];
for (const origin of origins) {
  const problems = await checkOrigin(origin);
  if (problems.length === 0) {
    console.log(`   open: ${origin} — ${CASES.length}/${CASES.length} paths answer 200 with the expected content`);
  } else {
    failures.push(...problems);
  }
}

if (failures.length) {
  console.error("\nPublic access:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
