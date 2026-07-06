#!/bin/bash
# Runner E2E: arranca un servidor de test en el puerto 4021 y ejecuta los tests.
# Requiere: npx playwright install chromium (una vez).
set -u
cd "$(dirname "$0")/../.."

PORT="${WIBE_TEST_PORT:-4021}"
TOKEN="${WIBE_TEST_TOKEN:-smoketest-token}"

WIBE_PORT="$PORT" WIBE_TOKEN="$TOKEN" WIBE_SHELL=/bin/bash WIBE_CWD="$HOME" \
  WIBE_BP_HIGH=8000 WIBE_BP_LOW=2000 WIBE_LOG_LEVEL=debug \
  node server.js > /tmp/wibetunnel-e2e-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 2

FAIL=0
for t in smoke stress webgl-check remember; do
  echo "=== tests/e2e/$t.js ==="
  WIBE_TEST_URL="http://localhost:$PORT/" WIBE_TEST_TOKEN="$TOKEN" node "tests/e2e/$t.js" || FAIL=1
done

echo "=== Logs [BP] del servidor de test ==="
grep '\[BP\]' /tmp/wibetunnel-e2e-server.log | head -5 || true

if [ "$FAIL" -eq 0 ]; then echo "E2E: TODO PASS"; else echo "E2E: HAY FALLOS"; fi
exit $FAIL
