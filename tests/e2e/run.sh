#!/bin/bash
# Runner E2E: arranca un servidor de test en el puerto 4021 y ejecuta los tests.
# Requiere: npx playwright install chromium (una vez).
set -u
cd "$(dirname "$0")/../.."

PORT="${WIBE_TEST_PORT:-4021}"
TOKEN="${WIBE_TEST_TOKEN:-smoketest-token}"
TEST_CWD="$(mktemp -d /tmp/wibetunnel-e2e-cwd.XXXXXX)"
REC_DIR="/tmp/wibetunnel-e2e-rec"
# CLAUDE_HOME aislado: el test de /claude planta ahi un transcript de mentira.
# Nunca debe tocar el ~/.claude real de quien ejecuta los tests.
CLAUDE_HOME="$(mktemp -d /tmp/wibetunnel-e2e-claude.XXXXXX)"

# RECONNECT_GRACE corto: con el modelo de propiedad las huerfanas de un test
# ya no se re-adoptan en el siguiente y acumularian hacia MAX_PTYS
#
# HISTFILE aislado: los PTYs heredan el env del servidor (pty-store solo filtra
# WIBE_*), asi que sin esto los `echo MARCA_...` de los tests acaban escritos en
# el ~/.bash_history real de quien ejecuta la suite.
HISTFILE=/dev/null \
  WIBE_PORT="$PORT" WIBE_TOKEN="$TOKEN" WIBE_SHELL=/bin/bash WIBE_CWD="$TEST_CWD" \
  WIBE_BP_HIGH=8000 WIBE_BP_LOW=2000 WIBE_LOG_LEVEL=debug \
  WIBE_RECONNECT_GRACE=60 \
  WIBE_PROFILES="Bash=/bin/bash,Sh=/bin/sh" WIBE_REC_DIR="$REC_DIR" \
  WIBE_CLAUDE_HOME="$CLAUDE_HOME" \
  node server.js > /tmp/wibetunnel-e2e-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$CLAUDE_HOME"' EXIT
sleep 2

FAIL=0
for t in smoke stress webgl-check remember features claude-view claude-files; do
  echo "=== tests/e2e/$t.js ==="
  WIBE_TEST_URL="http://localhost:$PORT/" WIBE_TEST_TOKEN="$TOKEN" \
    WIBE_TEST_REC_DIR="$REC_DIR" WIBE_TEST_CWD="$TEST_CWD" \
    WIBE_TEST_CLAUDE_HOME="$CLAUDE_HOME" node "tests/e2e/$t.js" || FAIL=1
done

echo "=== Logs [BP] del servidor de test ==="
grep '\[BP\]' /tmp/wibetunnel-e2e-server.log | head -5 || true

if [ "$FAIL" -eq 0 ]; then echo "E2E: TODO PASS"; else echo "E2E: HAY FALLOS"; fi
exit $FAIL
