#!/usr/bin/env bash
# Boots the RIOS stack (Postgres assumed running & seeded), starts the API and
# web dev server, waits for BOTH to be reachable, then runs the Playwright e2e
# suite against them and tears down.
#
# Note: deliberately NOT using `set -e` — we wait in loops and report explicitly,
# so a transient non-zero (e.g. an empty grep before Vite has logged its port)
# must not abort the script.
set -uo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="${DATABASE_URL:-postgres://rios:rios@localhost:5432/rios}"
export DATABASE_APP_URL="${DATABASE_APP_URL:-postgres://rios_app:rios_app@localhost:5432/rios}"
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

# 1) Wait for the API to answer /health (up to 60s).
api_up=0
for _ in $(seq 1 60); do
  if curl -sf http://localhost:4000/health >/dev/null 2>&1; then api_up=1; break; fi
  sleep 1
done
if [ "$api_up" != "1" ]; then
  echo "::error::API did not become ready"; echo "--- server log ---"; cat /tmp/e2e-server.log; exit 1
fi

# 2) Wait for the web dev server, discovering the port it actually bound to.
WEB_PORT=""
for _ in $(seq 1 60); do
  WEB_PORT=$(grep -oE 'localhost:[0-9]+' /tmp/e2e-web.log 2>/dev/null | head -1 | cut -d: -f2 || true)
  if [ -n "$WEB_PORT" ] && curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then break; fi
  sleep 1
done
if [ -z "$WEB_PORT" ]; then
  echo "::error::Web dev server did not become ready"; echo "--- web log ---"; cat /tmp/e2e-web.log; exit 1
fi

export PLAYWRIGHT_BASE_URL="http://localhost:${WEB_PORT}"
echo "e2e against ${PLAYWRIGHT_BASE_URL}"

npm --prefix e2e test
