// Helpers compartidos de los tests E2E.

// Desactiva el historial de la shell de la sesion recien abierta.
//
// tests/e2e/run.sh ya arranca su servidor con HISTFILE=/dev/null, pero smoke.js
// tambien corre contra el servidor de produccion (scripts/prod-smoke.sh --ui) y
// ahi no controlamos el env del proceso. Sin esto, cada marcador que teclea el
// smoke queda escrito en el ~/.bash_history real.
//
// Con HISTFILE sin definir, bash no guarda el historial al salir, asi que basta
// con lanzarlo como primer comando de la sesion.
async function disableShellHistory(page) {
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type('unset HISTFILE');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}

module.exports = { disableShellHistory };
