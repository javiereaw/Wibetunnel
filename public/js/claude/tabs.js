// Ciclo de vida de las sesiones: tabs, terminal xterm oculto detras del chat,
// creacion y cierre. Se separa de app.js solo por tamano (CLAUDE.md pide ~500
// LOC por archivo); app.js sigue siendo quien orquesta.
//
// Lo que NO vive aqui: pintar el chat. Al cambiar de tab se avisa via onSwitch
// y app.js decide que hacer con el transcript.
import { state, getPref, isMobile, inputBatch, active } from '../state.js';
import * as net from './net.js';
import { createTranscript } from './stream.js';

const tabsEl = document.getElementById('c-tabs');
const termPanelsEl = document.getElementById('c-term-panels');
const newTabBtn = document.getElementById('c-tab-new');

let hooks = {};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function renderTabStatus(s) {
  s.tabEl.classList.remove('c-status-attached', 'c-status-searching');
  if (s.claudeStatus === 'attached') s.tabEl.classList.add('c-status-attached');
  else if (s.claudeStatus === 'searching' || s.claudeStatus === 'waiting') s.tabEl.classList.add('c-status-searching');
}

export function doResize(s) {
  if (!s) return;
  s.fitAddon.fit();
  net.resize(s.persistentId, s.term.cols, s.term.rows);
}

export function setupSession(id, name) {
  const tab = el('button', 'c-tab');
  tab.dataset.id = id;
  const close = el('span', 'c-tab-close', '×');
  close.dataset.id = id;
  tab.append(el('span', 'c-tab-dot'), el('span', 'c-tab-name', name), close);
  tabsEl.insertBefore(tab, newTabBtn);

  const panel = el('div', 'c-term-panel');
  panel.id = 'c-term-panel-' + id;
  termPanelsEl.appendChild(panel);

  const cs = getComputedStyle(document.documentElement);
  const term = new Terminal({
    fontSize: state.currentFontSize || 14,
    fontFamily: getPref('wibe-fontfamily', "'Courier New', monospace"),
    theme: {
      background: cs.getPropertyValue('--term-bg').trim(),
      foreground: cs.getPropertyValue('--term-fg').trim(),
      cursor: cs.getPropertyValue('--accent').trim(),
    },
    cursorBlink: !isMobile,
    scrollback: isMobile ? 1000 : 5000,
    fastScrollModifier: 'alt',
    smoothScrollDuration: 0,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (_) { /* addon opcional */ }
  term.open(panel);
  term.onData((data) => {
    const s = state.sessions.get(id);
    if (s && s.persistentId) net.sendKey(s.persistentId, data);
  });
  panel.addEventListener('touchstart', () => term.focus());

  state.sessions.set(id, {
    id, term, fitAddon, tabEl: tab, panelEl: panel, name,
    persistentId: null, takenPid: null,
    transcript: createTranscript(), claudeStatus: 'idle', claudeHasMore: false,
  });
}

export function switchSession(id) {
  if (!state.sessions.has(id)) return;
  state.activeId = id;
  tabsEl.querySelectorAll('.c-tab').forEach((t) => t.classList.toggle('active', t.dataset.id === id));
  state.sessions.forEach((s, sid) => s.panelEl.classList.toggle('active', sid === id));

  const s = active();
  if (hooks.onSwitch) hooks.onSwitch(s);

  requestAnimationFrame(() => {
    if (state.activeId !== id) return;
    doResize(s);
    if (!isMobile && hooks.getMode && hooks.getMode() === 'term') s.term.focus();
  });
}

export function releaseSessionResources(s) {
  if (!s.persistentId) return;
  net.detachClaude(s.persistentId);
  const batch = inputBatch.get(s.persistentId);
  if (batch && batch.timer) clearTimeout(batch.timer);
  inputBatch.delete(s.persistentId);
}

// cwd opcional: carpeta elegida en el explorador. El servidor la valida y falla
// en cerrado si no existe (lo recoge onSessionError en app.js).
export function createNewSession(cwd) {
  if (!state.socket || !state.socket.connected) return;
  if (state.sessions.size >= state.maxSessions) {
    if (hooks.onLimit) hooks.onLimit(state.maxSessions);
    return;
  }
  const id = 'cses-' + (++state.sessionCounter);
  const name = cwd ? (cwd.split(/[/\\]/).filter(Boolean).pop() || 'Shell') : 'Shell ' + state.sessionCounter;
  setupSession(id, name);
  net.createSession(id, null, cwd || null);
  switchSession(id);
}

export function closeSession(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  if (s.persistentId) net.killSession(s.persistentId);
  releaseSessionResources(s);
  disposeSession(id, s);
  if (state.sessions.size > 0) switchSession([...state.sessions.keys()].pop());
  else createNewSession();
}

// Retira la tab sin matar nada en el servidor (sesion que nunca llego a existir).
export function disposeSession(id, session) {
  const s = session || state.sessions.get(id);
  if (!s) return;
  s.term.dispose();
  s.tabEl.remove();
  s.panelEl.remove();
  state.sessions.delete(id);
}

export function initTabs(h) {
  hooks = h || {};
  tabsEl.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.c-tab-close');
    if (closeBtn) { closeSession(closeBtn.dataset.id); return; }
    const tab = e.target.closest('.c-tab');
    if (tab) switchSession(tab.dataset.id);
  });
}
