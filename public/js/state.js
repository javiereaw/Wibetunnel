// === Helpers de preferencias (localStorage con manejo de errores) ===
export function getPref(key, defaultVal) {
  try { const v = localStorage.getItem(key); return v !== null ? v : defaultVal; } catch (_) { return defaultVal; }
}
export function setPref(key, value) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, String(value)); } catch (_) {}
}

export const state = {
  socket: null,
  sessions: new Map(),
  activeId: null,
  savedToken: '',
  initialized: false,
  maxSessions: 5,
  sessionCounter: 0,
  currentFontSize: parseInt(getPref('wibe-fontsize', '14')) || 14,
  shellType: 'posix',
  profiles: [],
  installPrompt: null,
};

export const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || 'ontouchstart' in window;

export const INPUT_BATCH_MS = isMobile ? 12 : 4;
export const RESIZE_DEBOUNCE_DESKTOP_MS = 50;
export const RESIZE_DEBOUNCE_MOBILE_MS = 150;
export const LONG_PRESS_MS = 500;
export const NOTIF_IDLE_MS = 3000;
export const HEARTBEAT_INTERVAL_MS = 30000;

export const inputBatch = new Map();

export function active() {
  return state.sessions.get(state.activeId);
}

export function parseEscapes(str) {
  return str.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
             .replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\n/g, '\n');
}

export function saveSessions() {
  try {
    const data = {};
    state.sessions.forEach((s, id) => {
      if (s.persistentId) data[s.persistentId] = { name: s.name };
    });
    localStorage.setItem('wibe-sessions', JSON.stringify(data));
  } catch (_) {}
}

export function loadSavedSessions() {
  try {
    return JSON.parse(localStorage.getItem('wibe-sessions') || '{}');
  } catch { return {}; }
}

export function findSessionByPersistentId(pid) {
  for (const [id, s] of state.sessions) {
    if (s.persistentId === pid) return { id, session: s };
  }
  return null;
}

export const outputTimers = new Map();
export let notifEnabled = getPref('wibe-notif', 'false') === 'true';
export function setNotifEnabled(val) { notifEnabled = val; }
export function trackOutput(sessionId) {
  if (!notifEnabled || document.visibilityState === 'visible') {
    clearTimeout(outputTimers.get(sessionId));
    outputTimers.set(sessionId, setTimeout(() => outputTimers.delete(sessionId), NOTIF_IDLE_MS));
    return;
  }
  if (!outputTimers.has(sessionId)) {
    const num = sessionId.replace('ses-', '');
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('Wibetunnel', { body: `Shell ${num}: comando completado`, icon: '/favicon.ico' });
    }
  }
  clearTimeout(outputTimers.get(sessionId));
  outputTimers.set(sessionId, setTimeout(() => outputTimers.delete(sessionId), NOTIF_IDLE_MS));
}
