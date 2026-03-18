# Wibetunnel

Terminal web minimalista para Windows. Accede a tu terminal desde cualquier navegador, optimizado para movil.

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![Platform](https://img.shields.io/badge/Platform-Windows-blue) ![License](https://img.shields.io/badge/License-MIT-yellow)

## Features

- **Multi-sesion** - Varias tabs de terminal simultaneas con renombrado (long press)
- **Mobile-first** - Botones tactiles, teclado virtual, touch targets WCAG
- **Temas** - Dark, light y auto (sigue el sistema)
- **Command palette** - Acceso rapido a acciones (Ctrl+Shift+P)
- **File browser** - Navega archivos y carpetas, inserta rutas o haz cd
- **Busqueda** - Buscar texto en el buffer del terminal (Ctrl+F)
- **Font size** - Ajusta el tamano de letra desde el toolbar
- **Atajos rapidos** - Shortcuts configurables para comandos frecuentes
- **Clipboard** - Copy/paste adaptado a movil
- **Notificaciones** - Aviso cuando un comando largo termina (tab en background)
- **Seguridad** - Auth por token, rate limiting, session timeout, HTTPS opcional

## Stack

- **Backend**: Node.js + Express + Socket.IO + node-pty
- **Frontend**: xterm.js + CSS vanilla (single HTML file)
- **Shell**: PowerShell (configurable)

## Requisitos

- Windows 10/11
- Node.js 18+
- npm

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
WIBE_TOKEN=tu_token_secreto       # Obligatorio: token de acceso
WIBE_PORT=4020                     # Puerto del servidor
WIBE_SHELL=powershell.exe          # Shell a usar
WIBE_CWD=C:\www                    # Directorio inicial
WIBE_MAX_SESSIONS=5                # Max tabs simultaneas
WIBE_SHORTCUTS=Projects=cd C:\www,Home=cd ~,Status=git status,Clear=cls
```

### Seguridad (opcional)

```env
WIBE_RATE_MAX=5          # Intentos de login antes de bloqueo
WIBE_RATE_WINDOW=15      # Minutos de bloqueo tras exceder intentos
WIBE_TIMEOUT=30          # Minutos de inactividad para desconexion (0=desactivado)
```

### HTTPS (opcional)

```env
WIBE_SSL_CERT=C:\certs\cert.pem
WIBE_SSL_KEY=C:\certs\key.pem
```

## Uso

```bash
node server.js
```

Abre `http://localhost:4020` en tu navegador e introduce tu token.

## Acceso remoto

Para acceder desde fuera de tu red local:

### Cloudflare Tunnel (recomendado)

```bash
# Instalar cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:4020
```

### ngrok

```bash
ngrok http 4020
```

### Tailscale

Instala Tailscale en tu PC y dispositivos. Accede via la IP de Tailscale.

## Atajos de teclado

| Atajo | Accion |
|-------|--------|
| Ctrl+Shift+P | Command palette |
| Ctrl+F | Buscar en terminal |

## Controles tactiles

La barra inferior tiene botones para: Ctrl+C, Tab, Flechas, Enter, Copy y Paste.

- **Long press en tab** = renombrar sesion
- **Boton Sel en file browser** = cd a carpeta

### Cloudflare Tunnel (dominio propio)

Si accedes via tunnel con un dominio HTTPS propio, añade el origen al `.env`:

```env
WIBE_ALLOWED_ORIGINS=https://tu-dominio.com
```

## Consideraciones de seguridad

- Usa un token largo y aleatorio (`openssl rand -hex 32`)
- En produccion, habilita HTTPS (`WIBE_SSL_CERT` / `WIBE_SSL_KEY`) o usa un tunnel con TLS
- El servidor esta disenado para uso personal — no lo expongas sin autenticacion
- Las variables de entorno con prefijo `WIBE_` no se heredan a los procesos de shell

## Licencia

MIT
