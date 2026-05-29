import { initTheme } from './theme.js';
import { connect } from './socket.js';
import './ui.js';

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
