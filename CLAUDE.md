# Wibetunnel — Project Instructions

## Stack
- **Backend:** Node.js + Express + Socket.IO + node-pty
- **Frontend:** Vanilla JS (public/index.html)
- **Platform:** Windows / PowerShell

## Code Style
- ES modules (`import`/`export`)
- Max ~500 LOC per file
- No TypeScript — plain JS
- Match existing error handling patterns

## Key Files
- `server.js` — Express server, Socket.IO handlers, PTY management
- `public/index.html` — Terminal UI (xterm.js)
- `.env` — Runtime config (PORT, auth token, etc.)
