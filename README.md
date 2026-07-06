# Wibetunnel

Terminal web minimalista y portable. Accede a tu terminal desde cualquier navegador, optimizado para movil, con sesiones persistentes que sobreviven a reconexiones.

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20Windows%20%7C%20macOS-blue) ![License](https://img.shields.io/badge/License-MIT-yellow)

## Features

- **Sesiones persistentes** - Sobreviven a cortes de red y cambios de dispositivo (replay del buffer al reconectar)
- **Multi-sesion** - Varias tabs simultaneas con renombrado (long press) y perfiles de shell
- **PWA instalable** - Icono en el movil, pantalla completa, arranque instantaneo
- **Mobile-first** - Botones tactiles, teclado virtual, touch targets WCAG
- **Bajo consumo** - Backpressure real (pausa el proceso si el cliente no drena), un solo contexto WebGL, batching de I/O
- **Subida/descarga de archivos** - Desde el file browser, con limite de tamaño y jail de directorio
- **Grabacion de sesiones** - Graba la salida de una sesion a fichero bajo demanda
- **Panel de estado** - Uptime, memoria, sesiones y conexiones del servidor en vivo
- **Temas** - Dark, light y auto (sigue el sistema)
- **Command palette** - Acceso rapido a acciones (Ctrl+Shift+P)
- **File browser** - Navega archivos, inserta rutas o haz cd
- **Busqueda** - Buscar texto en el buffer del terminal (Ctrl+F)
- **Enlaces clicables** - Las URLs en la salida se abren con un click
- **Remember-me** - Recuerda el token en el dispositivo (opt-in) con autoconexion
- **Atajos rapidos** - Shortcuts configurables para comandos frecuentes
- **Clipboard** - Copy/paste adaptado a movil
- **Notificaciones** - Aviso cuando un comando largo termina (tab en background)
- **Seguridad** - Auth por token (timing-safe), rate limiting, jail con realpath, session timeout, HTTPS opcional

## Stack

- **Backend**: Node.js + Express + Socket.IO + node-pty (modular, `lib/`)
- **Frontend**: xterm.js 6 + ES modules vanilla (sin bundler)
- **Shell**: configurable por `.env` (bash, zsh, PowerShell...)

## Requisitos

- Linux, macOS o Windows 10/11
- Node.js 18+

## Instalacion

```bash
git clone https://github.com/javiereaw/Wibetunnel.git
cd Wibetunnel
npm install
```

## Configuracion

Copia el archivo de ejemplo y edita tu token:

```bash
cp .env.example .env
```

Edita `.env`:

```env
WIBE_TOKEN=tu_token_secreto        # Obligatorio: token de acceso
WIBE_PORT=4020                     # Puerto del servidor
WIBE_SHELL=/bin/bash               # Shell a usar (powershell.exe en Windows)
WIBE_CWD=/home/usuario             # Directorio inicial (jail del file browser)
WIBE_MAX_SESSIONS=5                # Max tabs simultaneas por dispositivo
WIBE_SHORTCUTS=Home=cd ~,Status=git status,Clear=clear
WIBE_PROFILES=Bash=/bin/bash,Proyectos=/bin/bash|/home/usuario/proyectos
```

### Seguridad (opcional)

```env
WIBE_RATE_MAX=5          # Intentos de login antes de bloqueo
WIBE_RATE_WINDOW=15      # Minutos de bloqueo tras exceder intentos
WIBE_TIMEOUT=30          # Minutos de inactividad para desconexion (0=desactivado)
WIBE_MAX_PTYS=15         # Techo global de procesos de terminal
WIBE_UPLOAD_MAX=104857600 # Limite de subida en bytes (100 MB)
```

### Recursos y reconexion (opcional)

```env
WIBE_RECONNECT_GRACE=1800 # Segundos que una sesion sobrevive sin cliente
WIBE_BUFFER_SIZE=51200    # Bytes de scrollback replayado al reconectar
WIBE_BP_HIGH=262144       # Backpressure: pausa el proceso sobre este umbral
WIBE_BP_LOW=65536         # ... y reanuda por debajo de este
WIBE_LOG_LEVEL=info       # debug | info | warn | error
WIBE_REC_DIR=             # Directorio de grabaciones (default ~/.wibetunnel/recordings)
```

### HTTPS (opcional)

```env
WIBE_SSL_CERT=/ruta/cert.pem
WIBE_SSL_KEY=/ruta/key.pem
```

## Uso

```bash
npm start          # o ./start.sh
```

Abre `http://localhost:4020` en tu navegador e introduce tu token.

### Como servicio (Linux, recomendado)

Units de systemd en `deploy/` (servidor + Cloudflare Tunnel, con reinicio automatico ante crashes):

```bash
sudo cp deploy/wibetunnel.service /etc/systemd/system/   # ajusta User y rutas
sudo systemctl daemon-reload
sudo systemctl enable --now wibetunnel
```

## Acceso remoto

### Cloudflare Tunnel (recomendado)

```bash
cloudflared tunnel --url http://localhost:4020
```

Con dominio propio, añade el origen al `.env`:

```env
WIBE_ALLOWED_ORIGINS=https://tu-dominio.com
WIBE_TRUST_PROXY=true
```

### ngrok / Tailscale

```bash
ngrok http 4020
```

O instala Tailscale y accede via su IP privada.

## Atajos de teclado

| Atajo | Accion |
|-------|--------|
| Ctrl+Shift+P | Command palette |
| Ctrl+F | Buscar en terminal |

## Controles tactiles

La barra inferior tiene botones para: Ctrl+C, Tab, Flechas, Enter, Copy y Paste.

- **Long press en tab** = renombrar sesion
- **Boton Sel en file browser** = cd a carpeta
- **⤓ en file browser** = descargar archivo; **⤒ Subir archivo** para subir

## Desarrollo

```bash
npm run lint       # ESLint
npm test           # Unit tests (node:test)
npm run test:e2e   # Suite E2E con Playwright (requiere chromium instalado)
npm run vendor     # Re-copia los bundles de xterm tras actualizar @xterm/*
```

CI en GitHub Actions ejecuta lint + unit + E2E en cada push.

## Consideraciones de seguridad

- Usa un token largo y aleatorio (`openssl rand -hex 32`)
- En produccion, habilita HTTPS o usa un tunnel con TLS
- El servidor esta disenado para uso personal — no lo expongas sin autenticacion
- Las variables `WIBE_` no se heredan a los procesos de shell
- El file browser y la subida/descarga estan enjaulados en `WIBE_CWD` (symlinks resueltos con realpath)
- "Recordar token" guarda el token en localStorage del navegador: usalo solo en dispositivos propios

## Licencia

MIT
