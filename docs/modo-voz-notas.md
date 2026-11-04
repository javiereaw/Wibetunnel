# Modo voz — notas de investigación (04/11/2026, parado)

El modo voz para Wibetunnel se paró antes de escribir código: Javi ya no usa Wibetunnel y el
encargo pasó a ser una propuesta más amplia (`~/www/personal/app-ia-movil/propuesta.md`).
Esta rama guarda lo aprendido y unas capturas reales de pantalla de Claude Code
(`tests/unit/fixtures/voz/*.ansi`, sacadas con `tmux capture-pane -p -e` de una sesión de
prueba) para quien construya el puente de voz.

## Pantalla apagada en Android
- Web Speech (`SpeechRecognition`) en Chrome Android se aborta a propósito cuando la página se
  oculta (pantalla apagada, cambio de app): https://issuetracker.google.com/issues/517429672
- El micro por WebRTC también se corta poco después de apagar la pantalla:
  https://lists.w3.org/Archives/Public/public-webrtc-logs/2020Mar/0129.html
- `speechSynthesis` con la página oculta no es fiable; un `<audio>` sí suena en segundo plano y
  recibe el botón play/pausa del auricular (Media Session).
- Conclusión: para el bolsillo con la pantalla apagada hace falta app nativa (servicio en primer
  plano con `foregroundServiceType=microphone`, `SpeechRecognizer`, `TextToSpeech`,
  `MediaSession` para el botón del auricular). Con pantalla encendida (Wake Lock) la web vale.
  Sin probar en el móvil de Javi.

## Leer una sesión de Claude Code en tmux
- **Nombre de la sesión:** `tmux list-panes -a -F '#{session_name} #{pane_id} #{pane_pid} #{pane_title}'`.
  `pane_title` trae el nombre de Claude (`✳ Sereno 4 nov`). Mejor apuntar por `pane_id` (`%395`)
  que por nombre: `-t nombre` hace casado por prefijo.
- **Fin de turno (fiable):** el transcript JSONL escribe una línea
  `{"type":"system","subtype":"turn_duration"}` al acabar cada turno, justo después del
  `assistant` con `stop_reason: "end_turn"`. La respuesta nueva = bloques `text` del asistente
  entre el último prompt y ese `turn_duration` (los del final, tras el último `tool_use`).
  El JSONL se localiza como en `lib/claude-watch.js` (`findClaudePid` + `resolveTranscript`).
  Los mensajes entre sesiones llegan como `type:user` con `isMeta: true` y `origin.kind: "peer"`:
  no son palabras de Javi.
- **Ocupada (pantalla):** línea de spinner `<glifo> <Verbo>… (2m 32s · ↓ 10.9k tokens …)` o
  `⎿  Waiting…`. Al acabar queda `✻ Crunched for 3s · done 11:29` (sin `…`).
- **Caja de entrada:** la línea que empieza por `❯` entre dos reglas `─`. Si el texto tras `❯`
  va en `ESC[2m` (tenue) es la *sugerencia* automática, no texto de Javi. Si hay texto normal,
  Javi tiene un borrador a medias: **no enviar** (se concatenaría).
- **Permiso pendiente:** título en negrita (`Bash command`), descripción, el comando entre reglas
  `╌`, `Do you want to proceed?` y opciones numeradas (`❯ 1. Yes`, `2. Yes, and always allow …`,
  `3. Yes, and switch to auto mode`, `4. No`). Se responde con el dígito. Ojo: «siempre» debe
  casar con `always allow` / `don't ask again`, nunca con `switch to auto mode`. Volver a leer la
  pantalla justo antes de mandar el dígito.

## Seguridad pensada (sin implementar)
- `execFile('tmux', ['send-keys', '-t', paneId, '-l', '--', texto])` + `Enter` aparte: sin shell,
  `-l` literal, `--` para que un texto que empiece por `-` no se lea como opción. Quitar
  caracteres de control y limitar longitud. Solo a `pane_id` que salgan en `list-panes`.
- Solo por Tailscale: rechazar peticiones con `cf-connecting-ip`/`cf-ray` (vienen del túnel de
  Cloudflare) y exigir `Host` en una lista permitida, además del token y el rate limit.
