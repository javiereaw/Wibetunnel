// Citado de rutas para inyectarlas en la shell. Compartido por el explorador
// de "/" (filebrowser.js) y el de "/claude" (claude/files.js).
//
// shellType llega explicito en vez de leerse de state: asi el modulo no queda
// acoplado a la forma del estado de ninguna de las dos paginas.

export function quotePathForShell(p, shellType) {
  if (shellType === 'powershell') return "'" + String(p).replace(/'/g, "''") + "'";
  return "'" + String(p).replace(/'/g, "'\\''") + "'";
}

export function buildCdCmd(p, shellType) {
  return 'cd ' + quotePathForShell(p, shellType) + '\r';
}
