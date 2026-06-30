#!/usr/bin/env bash
# Boots the RIOS stack (Postgres assumed running & seeded), starts the API and
# web dev server, runs the Playwright e2e suite against them, then tears down.
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="${DATABASE_URL:-postgres://rios:rios@localhost:5432/rios}"
export DATABASE_APP_URL="${DATABASE_APP_URL:-postgres://rios_app:rios_app@localhost:5432/rios}"
export JWT_SECRET="${JWT_SECRET:-e2e-secret-at-least-32-characters-long-xx}"

cleanup() { kill $SERVER_PID $WEB_PID 2>/dev/null || true; }
trap cleanup EXIT

npm run dev:server >/tmp/e2e-server.log 2>&1 & SERVER_PID=$!
npm run dev:web    >/tmp/e2e-web.log    2>&1 & WEB_PID=$!

# Wait for the API and discover the web port (vite may pick the next free one).
for i in $(seq 1 30); do curl -sf http://localhost:4000/health >/dev/null 2>&1 && break; sleep 1; done
WEB_PORT=$(grep -oE 'localhost:[0-9]+' /tmp/e2e-web.log | head -1 | cut -d: -f2)
export PLAYWRIGHT_BASE_URL="http://localhost:${WEB_PORT:-5173}"
echo "e2e against $PLAYWRIGHT_BASE_URL"

npm --prefix e2e test
