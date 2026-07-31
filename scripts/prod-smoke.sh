#!/bin/bash
# Runner del smoke de produccion. Registra el resultado en reports/smoke.log y
# aplica la politica de alerta: 3 fallos consecutivos → linea ALERT + journald
# (logger -t wibetunnel-smoke) + flag reports/ALERT. NUNCA reinicia nada.
# Uso: scripts/prod-smoke.sh          (Tier A: smoke API, siempre seguro)
#      scripts/prod-smoke.sh --ui     (+ Tier B: smoke full-UI, solo sin sesiones vivas)
set -u
cd "$(dirname "$0")/.."
mkdir -p reports
LOG=reports/smoke.log
FAILS=reports/smoke.failcount
TS=$(date -Is)
T0=$SECONDS

run_tier_a() {
  timeout 90 node tests/e2e/prod-smoke.js
}

run_tier_b() {
  # Gate: solo con 0 sesiones vivas (el smoke UI abre el frontend real)
  local sessions
  sessions=$(node -e '
    require("dotenv").config();
    const port = process.env.WIBE_PORT || 4020;
    fetch(`http://localhost:${port}/health`, { headers: { Authorization: `Bearer ${process.env.WIBE_TOKEN}` } })
      .then(r => r.json()).then(j => console.log((j.sessions || []).length))
      .catch(() => console.log("err"));
  ')
  if [ "$sessions" != "0" ]; then
    echo "$TS SKIP tier-b (sesiones vivas: $sessions)" >> "$LOG"
    return 0
  fi
  WIBE_TEST_URL="http://localhost:${WIBE_PORT:-4020}/" \
  WIBE_TEST_TOKEN="$(node -e 'require("dotenv").config(); console.log(process.env.WIBE_TOKEN)')" \
    timeout 120 node tests/e2e/smoke.js
}

OK=0
run_tier_a || OK=1
if [ "${1:-}" = "--ui" ] && [ "$OK" -eq 0 ]; then
  run_tier_b || OK=1
fi

DUR=$((SECONDS - T0))
if [ "$OK" -eq 0 ]; then
  echo "$TS PASS ${DUR}s" >> "$LOG"
  echo 0 > "$FAILS"
  rm -f reports/ALERT
else
  echo "$TS FAIL ${DUR}s" >> "$LOG"
  N=$(( $(cat "$FAILS" 2>/dev/null || echo 0) + 1 ))
  echo "$N" > "$FAILS"
  if [ "$N" -ge 3 ]; then
    echo "$TS ALERT ($N fallos consecutivos)" >> "$LOG"
    logger -t wibetunnel-smoke "ALERT: $N consecutive smoke failures against localhost"
    touch reports/ALERT
  fi
fi
exit $OK
