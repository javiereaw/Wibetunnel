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

// PWA: service worker para instalabilidad y cache de estaticos
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
