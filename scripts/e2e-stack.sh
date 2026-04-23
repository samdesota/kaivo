#!/usr/bin/env bash
# Single-command e2e: build sandbox image, boot a hermetic Postgres+app
# stack on isolated ports, run the live e2e suite against it, tear down.
#
# Usage:
#   ANTHROPIC_API_KEY=sk-…              \
#   [ANTHROPIC_BASE_URL=http://…]       \
#   [E2E_KEEP=1]                        \
#   [E2E_ONLY=bash,task]                \
#   ./scripts/e2e-stack.sh
#
# Required:
#   ANTHROPIC_API_KEY     bootstrapped into the app on first start
# Optional:
#   ANTHROPIC_BASE_URL    point at a proxy (e.g. local cli-proxy-api)
#   E2E_KEEP=1            skip teardown so you can poke at the stack
#   E2E_ONLY=…            forwarded to the test runner (substring filter)

set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="cc-e2e"
APP_PORT="${APP_PORT:-13000}"
APP_URL="http://127.0.0.1:${APP_PORT}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-e2e-$(openssl rand -hex 8)}"
DATA_DIR="$(mktemp -d -t cc-e2e-data-XXXXXX)"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "fatal: ANTHROPIC_API_KEY is required (Haiku call costs pennies)" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "fatal: docker not on PATH" >&2
  exit 2
fi

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.e2e.yml -p "$PROJECT")

cleanup() {
  local code=$?
  if [[ "${E2E_KEEP:-}" == "1" ]]; then
    echo
    echo "E2E_KEEP=1 — leaving stack up:"
    echo "  app:        $APP_URL"
    echo "  admin pw:   $ADMIN_PASSWORD"
    echo "  data dir:   $DATA_DIR"
    echo "  teardown:   ${COMPOSE[*]} down -v && rm -rf $DATA_DIR"
    exit "$code"
  fi
  echo
  echo "tearing down…"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR" || true
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "==> build sandbox image (cloud-code-sandbox:dev)"
npm run docker:sandbox >/dev/null

echo "==> build app image"
"${COMPOSE[@]}" build app >/dev/null

echo "==> compose up"
HOST_DATA_DIR="$DATA_DIR" \
ADMIN_PASSWORD_BOOTSTRAP="$ADMIN_PASSWORD" \
ANTHROPIC_API_KEY_BOOTSTRAP="$ANTHROPIC_API_KEY" \
ANTHROPIC_BASE_URL_BOOTSTRAP="${ANTHROPIC_BASE_URL:-}" \
PUBLIC_URL="$APP_URL" \
  "${COMPOSE[@]}" up -d --wait

echo "==> wait for /healthz"
for i in {1..60}; do
  if curl -fsS "$APP_URL/healthz" >/dev/null 2>&1; then
    echo "    ready after ${i}s"
    break
  fi
  if [[ "$i" == "60" ]]; then
    echo "fatal: app did not become healthy in 60s" >&2
    "${COMPOSE[@]}" logs app | tail -50
    exit 1
  fi
  sleep 1
done

echo "==> run live e2e suite"
ADMIN_PASSWORD="$ADMIN_PASSWORD" \
APP_URL="$APP_URL" \
E2E_ONLY="${E2E_ONLY:-}" \
  npm run --silent test:e2e:live
