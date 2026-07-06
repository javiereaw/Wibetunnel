// Panel de estado del servidor: consume /health y se refresca mientras esta abierto
import { state, active, isMobile } from './state.js';

const panelEl = document.getElementById('statuspanel');
const bodyEl = document.getElementById('statuspanel-body');
let refreshTimer = null;

function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function row(label, value) {
  const div = document.createElement('div');
  div.className = 'sp-row';
  const l = document.createElement('span');
  l.className = 'sp-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.textContent = value;
  div.append(l, v);
  return div;
}

async function render() {
  try {
    const res = await fetch('/health', { headers: { Authorization: 'Bearer ' + state.savedToken } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const h = await res.json();
    bodyEl.innerHTML = '';
    bodyEl.append(
      row('Uptime', fmtUptime(h.uptime)),
      row('Memoria (RSS)', Math.round(h.rssBytes / 1048576) + ' MB'),
      row('Conexiones', String(h.connections)),
      row('Sesiones PTY', `${h.ptys}${h.pausedPtys ? ` (${h.pausedPtys} pausadas)` : ''}`),
    );
    if (h.sessions && h.sessions.length) {
      const title = document.createElement('div');
      title.className = 'sp-title';
      title.textContent = 'Sesiones';
      bodyEl.appendChild(title);
      for (const s of h.sessions) {
        const flags = [
          s.orphan ? 'huérfana' : 'conectada',
          s.paused ? 'pausada' : null,
          s.recording ? '● REC' : null,
        ].filter(Boolean).join(', ');
        const idle = Math.round((Date.now() - s.lastActivity) / 1000);
        bodyEl.appendChild(row(`${s.persistentId} (PID ${s.pid})`, `${flags} · ${(s.bufLen / 1024).toFixed(1)}KB buffer · hace ${idle}s`));
      }
    }
  } catch (e) {
    bodyEl.textContent = 'No se pudo obtener el estado del servidor';
  }
}

export function openStatusPanel() {
  panelEl.style.display = 'flex';
  render();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(render, 5000);
}

function closeStatusPanel() {
  panelEl.style.display = 'none';
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  const s = active();
  if (s && !isMobile) s.term.focus();
}

document.getElementById('statuspanel-close').addEventListener('click', closeStatusPanel);
panelEl.addEventListener('click', (e) => { if (e.target === panelEl) closeStatusPanel(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panelEl.style.display === 'flex') closeStatusPanel();
});
