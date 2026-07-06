#!/bin/bash
# Lanzador manual para Linux/macOS. En produccion usar systemd (ver deploy/).
cd "$(dirname "$0")"

# Si node no esta en PATH, intentar cargar nvm
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi

exec node server.js
