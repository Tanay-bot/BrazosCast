#!/usr/bin/env bash
# Deploy the built app to Vercel, then hold the deployed origin to the headers the app needs.
#
# Replaces the Freebuff Sites upload (sites/worker.js). The Worker existed to add three things a
# plain static host may not send — sw.js uncached, /data/* revalidated, hashed assets immutable —
# and app/vercel.json carries the same three as host config. This script is the part that makes
# "carried" checkable: after the upload it curls the new origin and fails on a wrong header, a
# wrong content type, or a missing payload that answers 200 with the HTML shell.
#
# Auth, and what is deliberately not here: no token is written by this script and none is printed.
# It reads one from $VERCEL_TOKEN, or from .vercel-token if you prefer a file (gitignored) — or
# falls back to a `vercel login` you performed yourself. Without one it stops and says so rather
# than starting an interactive flow in an agent's shell.
#
#   scripts/deploy-vercel.sh              rebuild, upload, verify
#   BRAZOSCAST_SKIP_BUILD=1 scripts/deploy-vercel.sh   reuse app/dist exactly as it is
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/app/dist"
PROJECT="${BRAZOSCAST_VERCEL_PROJECT:-brazoscast}"
CLI_VERSION="${BRAZOSCAST_VERCEL_CLI:-vercel@latest}"

step() { printf '\n== %s\n' "$1"; }
fail() { printf '\nFAILED: %s\n' "$1" >&2; exit 1; }

vc() { npx --yes "$CLI_VERSION" "$@"; }

step "build"
if [ "${BRAZOSCAST_SKIP_BUILD:-0}" = 1 ]; then
  [ -f "$DIST/index.html" ] || fail "BRAZOSCAST_SKIP_BUILD=1 but app/dist/index.html is missing"
  echo "   reusing app/dist as it is"
else
  [ -d "$ROOT/app/node_modules" ] || ( cd "$ROOT/app" && npm ci )
  ( cd "$ROOT/app" && npm run build ) || fail "vite build"
fi

step "host config"
# The config must travel with the deployed bytes, so a deploy cannot pair today's files with
# last week's headers. check-vercel-config.mjs then reads the copy the upload will actually use.
cp "$ROOT/app/vercel.json" "$DIST/vercel.json"
node "$ROOT/scripts/check-vercel-config.mjs" || fail "app/vercel.json does not match the shipped tree"

step "auth"
TOKEN="${VERCEL_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$ROOT/.vercel-token" ]; then
  TOKEN="$(head -n1 "$ROOT/.vercel-token" | tr -d '[:space:]')"
fi
TOKEN_ARG=()
if [ -n "$TOKEN" ]; then
  TOKEN_ARG=(--token "$TOKEN")
  echo "   using a token from ${VERCEL_TOKEN:+the environment}${VERCEL_TOKEN:-.vercel-token}"
elif vc whoami ${TOKEN_ARG[@]+"${TOKEN_ARG[@]}"} >/dev/null 2>&1; then
  echo "   using the Vercel CLI's stored login ($(vc whoami 2>/dev/null))"
else
  cat >&2 <<'EOF'
   not authenticated. Either:
     npx vercel login                       # browser flow, once
     or put a token in .vercel-token        # gitignored, one line
     or export VERCEL_TOKEN=...             # for CI
EOF
  exit 2
fi

step "deploy"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
vc deploy "$DIST" --prod --yes --project "$PROJECT" --json ${TOKEN_ARG[@]+"${TOKEN_ARG[@]}"} >"$OUT" || {
  cat "$OUT" >&2
  fail "vercel deploy"
}
URL="$(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const u = j.url || (j.deployment && j.deployment.url) || (j.deployments && j.deployments[0] && j.deployments[0].url);
  if (!u) { console.error(JSON.stringify(j, null, 2)); process.exit(1); }
  console.log(u.startsWith("http") ? u : "https://" + u);
' "$OUT")" || fail "could not read the deployment URL"
echo "   $URL"

# A production deployment answers on the project's own domain once it is ready; the deployment
# URL itself is what was just built, so verify that and report both.
step "verify the deployed origin"
status() { curl -sS -o /dev/null -w '%{http_code}' "$1"; }
header() { curl -sS -o /dev/null -D - "$1" | tr -d '\r' | grep -i "^$2:" | head -1 | cut -d' ' -f2- || true; }

problems=0
expect() { # path header regex what
  local got; got="$(header "$URL$1" "$2")"
  if printf '%s' "$got" | grep -Eq "$3"; then
    printf '   ✓ %-34s %s: %s\n' "$1" "$2" "$got"
  else
    printf '   ✗ %-34s %s: %s (wanted %s)\n' "$1" "$2" "${got:-<absent>}" "$3"
    problems=$((problems + 1))
  fi
}
expect_status() {
  local got; got="$(status "$URL$1")"
  if [ "$got" = "$2" ]; then printf '   ✓ %-34s %s\n' "$1" "$got"
  else printf '   ✗ %-34s %s (wanted %s)\n' "$1" "$got" "$2"; problems=$((problems + 1)); fi
}

expect_status "/" 200
expect "/" "content-type" "^text/html"
expect "/" "cache-control" "no-cache"
expect_status "/sw.js" 200
expect "/sw.js" "cache-control" "no-store"
expect "/sw.js" "service-worker-allowed" "^/$"
expect_status "/index.html" 200
expect "/index.html" "cache-control" "no-cache"
expect_status "/data/ensemble.json" 200
expect "/data/ensemble.json" "content-type" "^application/json"
expect "/data/ensemble.json" "cache-control" "no-cache"
expect_status "/data/road_thresholds.geojson" 200
expect "/data/road_thresholds.geojson" "content-type" "^application/geo\+json"
ASSET="$(cd "$DIST/assets" && ls -1 *.js | head -1)"
expect "/assets/$ASSET" "cache-control" "immutable"
# The reason there is no SPA rewrite: a payload typo must not look like success.
expect_status "/data/does-not-exist.json" 404
expect_status "/?text=1&stage=35&addr=Skinner+Lane" 200

if [ "$problems" -ne 0 ]; then
  fail "$problems deployed-header check(s) failed on $URL"
fi

printf '\nLive: %s\n' "$URL"
printf 'If you own a domain, point it at project %s in the Vercel dashboard.\n' "$PROJECT"
