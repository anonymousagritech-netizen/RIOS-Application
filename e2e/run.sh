#!/usr/bin/env bash
# Boots the RIOS stack (Postgres assumed running & seeded), starts the API and
# web dev server, waits for BOTH to be reachable, then runs the Playwright e2e
# suite against them and tears down.
#
# Not using `set -e`: this is a wait-and-poll script, so transient non-zeros
# (an empty grep before Vite has logged, a refused curl before a server is up)
# are expected and must not abort it.
set -uo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="${DATABASE_URL:-postgres://rios:rios@127.0.0.1:5432/rios}"
export DATABASE_APP_URL="${DATABASE_APP_URL:-postgres://rios_app:rios_app@127.0.0.1:5432/rios}"
export JWT_SECRET="${JWT_SECRET:-e2e-secret-at-least-32-characters-long-xx}"

SERVER_PID=""
WEB_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT

npm run dev:server >/tmp/e2e-server.log 2>&1 &
SERVER_PID=$!
npm run dev:web >/tmp/e2e-web.log 2>&1 &
WEB_PID=$!

# Poll a URL until it answers (or timeout). $1=url $2=label $3=logfile
wait_for() {
  local url="$1" label="$2" log="$3"
  for _ in $(seq 1 60); do
    if curl -sf "$url" >/dev/null 2>&1; then echo "$label ready: $url"; return 0; fi
    sleep 1
  done
  echo "::error::$label did not become ready ($url)"; echo "--- $label log ---"; cat "$log" 2>/dev/null
  return 1
}

# 1) API (Fastify binds 0.0.0.0).
wait_for "http://127.0.0.1:4000/health" "API" /tmp/e2e-server.log || exit 1

# 2) Web dev server. Vite is pinned to port 5173 (host:true binds all interfaces),
#    but if it ever bumps the port, discover it from the log as a fallback.
WEB_PORT="$(grep -oE 'localhost:[0-9]+' /tmp/e2e-web.log 2>/dev/null | head -1 | cut -d: -f2 || true)"
WEB_PORT="${WEB_PORT:-5173}"
wait_for "http://127.0.0.1:${WEB_PORT}/" "Web" /tmp/e2e-web.log || exit 1

export PLAYWRIGHT_BASE_URL="http://127.0.0.1:${WEB_PORT}"
echo "e2e against ${PLAYWRIGHT_BASE_URL}"

npm --prefix e2e test
