import { initTheme } from './theme.js';
import { connect } from './socket.js';
import { getPref } from './state.js';
import './ui.js';
import './filebrowser.js';
import './palette.js';
import './settings.js';

initTheme();

document.getElementById('btn-eye').addEventListener('click', () => {
  const tokenInput = document.getElementById('token');
  const isHidden = tokenInput.type === 'password';
  tokenInput.type = isHidden ? 'text' : 'password';
  tokenInput.focus();
});

document.getElementById('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connect();
});
document.getElementById('btn-connect').addEventListener('click', connect);

// Remember-me: si hay token guardado, rellenar y conectar automaticamente
const savedToken = getPref('wibe-token', '');
if (savedToken) {
  document.getElementById('token').value = savedToken;
  document.getElementById('remember-token').checked = true;
  connect();
}

// PWA: service worker para instalabilidad y cache de estaticos.
// updateViaCache:'none': el propio sw.js nunca pasa por la cache HTTP — un proxy
// con max-age largo dejaria fijado un SW viejo (y sus estaticos stale) para siempre
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      // Buscar SW nuevo al volver a la pestaña: los deploys llegan sin esperar al ciclo del navegador
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {});
  // Un SW nuevo tomo el control: recargar para no ejecutar un grafo de modulos
  // mezclado de dos versiones. hadController evita recargar en la primera
  // instalacion (clients.claim() tambien dispara controllerchange).
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
}

// Capturar el prompt de instalacion para dispararlo desde la paleta
import { state } from './state.js';
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
});
window.addEventListener('appinstalled', () => {
  state.installPrompt = null;
});
