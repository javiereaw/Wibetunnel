// DOM del chat: convierte "items" (public/js/claude/stream.js) en burbujas y
// cards plegables. Todo el contenido nace plegado con un resumen de una linea;
// expandir muestra input/output completos — nunca se descarta nada, solo se oculta.
import { renderMarkdown, escapeHtml } from './md.js';

const chatLog = document.getElementById('c-chat-log');
const loadMoreBtn = document.getElementById('c-load-more');
const itemEls = new WeakMap(); // item -> HTMLElement

const TOOL_ICON = {
  Read: '\u{1F4C4}', Write: '\u{1F4DD}', Edit: '✏️', Bash: '\u{1F4BB}',
  Grep: '\u{1F50E}', Glob: '\u{1F5C2}️', Task: '\u{1F916}', TodoWrite: '☑️',
  WebFetch: '\u{1F310}', WebSearch: '\u{1F50D}',
};
const OUTPUT_LINE_CAP = 400;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function jsonPreview(v) {
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

// Resumen de una linea para la cabecera plegada, por herramienta
function toolSummary(item) {
  const input = item.input || {};
  switch (item.name) {
    case 'Read': case 'Write': return input.file_path || '';
    case 'Edit': {
      const added = (input.new_string || '').split('\n').length;
      const removed = (input.old_string || '').split('\n').length;
      return `${input.file_path || ''}  +${added}/-${removed}`;
    }
    case 'Bash': return input.command || input.description || '';
    case 'Grep': return `"${input.pattern || ''}"` + (input.path ? ' en ' + input.path : '');
    case 'Glob': return input.pattern || '';
    case 'Task': return `${input.subagent_type || 'agente'}: ${input.description || ''}`;
    case 'TodoWrite': return Array.isArray(input.todos) ? `${input.todos.length} tareas` : '';
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    default: {
      const keys = Object.keys(input);
      if (!keys.length) return '';
      return keys.slice(0, 2).map((k) => `${k}=${jsonPreview(input[k]).slice(0, 24)}`).join(' ');
    }
  }
}

function statusIcon(item) {
  if (item.status === 'pending') return '⏳';
  if (item.status === 'error') return '✖';
  return '✔';
}

function toggleBody(header, body) {
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  const chevron = header.querySelector('.c-chevron');
  if (chevron) chevron.textContent = open ? '▸' : '▾';
}

function makeCollapsible(headerChildren, buildBody, extraCardClass) {
  const card = el('div', 'c-card' + (extraCardClass ? ' ' + extraCardClass : ''));
  const header = el('div', 'c-card-header');
  header.append(el('span', 'c-chevron', '▸'), ...headerChildren);
  const body = el('div', 'c-card-body');
  body.style.display = 'none';
  header.addEventListener('click', () => {
    if (body.dataset.built !== '1') { body.appendChild(buildBody()); body.dataset.built = '1'; }
    toggleBody(header, body);
  });
  card.append(header, body);
  return card;
}

function renderDiff(oldStr, newStr) {
  const box = el('div', 'c-diff');
  const before = el('div', 'c-diff-old');
  before.append(el('span', 'c-diff-sign', '−'), document.createTextNode(oldStr || ''));
  const after = el('div', 'c-diff-new');
  after.append(el('span', 'c-diff-sign', '+'), document.createTextNode(newStr || ''));
  box.append(before, after);
  return box;
}

function renderCapped(text, cls) {
  const frag = document.createDocumentFragment();
  const lines = text.split('\n');
  const pre = el('pre', cls);
  if (lines.length <= OUTPUT_LINE_CAP) {
    pre.textContent = text;
    frag.appendChild(pre);
    return frag;
  }
  pre.textContent = lines.slice(0, OUTPUT_LINE_CAP).join('\n');
  frag.appendChild(pre);
  const btn = el('button', 'c-show-all', `Mostrar todo (${lines.length} líneas)`);
  btn.addEventListener('click', () => { pre.textContent = text; btn.remove(); });
  frag.appendChild(btn);
  return frag;
}

function buildToolBody(item) {
  const body = document.createDocumentFragment();
  if (item.name === 'Edit' && item.input) {
    body.appendChild(renderDiff(item.input.old_string, item.input.new_string));
  } else if (item.input && Object.keys(item.input).length) {
    const text = item.name === 'Bash' ? (item.input.command || '') : JSON.stringify(item.input, null, 2);
    body.appendChild(renderCapped(text, 'c-card-input'));
  }
  if (item.result != null) {
    const text = typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2);
    body.appendChild(renderCapped(text, 'c-card-output' + (item.isError ? ' c-error' : '')));
  } else if (item.status === 'pending') {
    body.appendChild(el('div', 'c-pending', 'Ejecutando…'));
  }
  return body;
}

function renderToolCard(item) {
  const header = [
    el('span', 'c-tool-icon', TOOL_ICON[item.name] || '\u{1F6E0}️'),
    el('span', 'c-tool-label', item.name || '(desconocida)'),
    el('span', 'c-tool-summary', toolSummary(item)),
    el('span', 'c-tool-status', statusIcon(item)),
  ];
  const card = makeCollapsible(header, () => buildToolBody(item), 'c-card-' + item.status);
  if (item.sidechain) card.classList.add('c-sidechain');
  return card;
}

function renderThinking(item) {
  const header = [el('span', 'c-tool-icon', '✻'), el('span', 'c-tool-label', 'Pensando')];
  return makeCollapsible(header, () => el('pre', 'c-thinking-body', item.text || ''), 'c-thinking');
}

function renderMeta(item) {
  const label = item.eventType || 'evento';
  const header = [el('span', 'c-tool-label', label)];
  const raw = item.raw !== undefined ? item.raw : item;
  return makeCollapsible(header, () => el('pre', '', JSON.stringify(raw, null, 2)), 'c-meta');
}

function renderTextBubble(item, roleClass) {
  const wrap = el('div', 'c-msg ' + roleClass + (item.sidechain ? ' c-sidechain' : ''));
  const bubble = el('div', 'c-bubble');
  bubble.innerHTML = renderMarkdown(item.text || '');
  wrap.appendChild(bubble);
  return wrap;
}

export function renderItem(item) {
  switch (item.type) {
    case 'user-text': return renderTextBubble(item, 'c-msg-user');
    case 'assistant-text': return renderTextBubble(item, 'c-msg-assistant');
    case 'thinking': return renderThinking(item);
    case 'tool': return renderToolCard(item);
    case 'attachment': return renderMeta({ ...item, eventType: 'attachment', raw: item.attachment });
    default: return renderMeta(item);
  }
}

const NEAR_BOTTOM_PX = 80;
function isNearBottom() {
  return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < NEAR_BOTTOM_PX;
}

export function appendItems(items) {
  if (!items.length) return;
  const stick = isNearBottom();
  for (const item of items) {
    const node = renderItem(item);
    itemEls.set(item, node);
    chatLog.appendChild(node);
  }
  if (stick) chatLog.scrollTop = chatLog.scrollHeight;
}

// Re-renderiza in-place items ya mutados (p.ej. un tool_result que llega
// despues de su tool_use), preservando si la card estaba expandida.
export function updateItems(items) {
  for (const item of items) {
    const oldEl = itemEls.get(item);
    if (!oldEl) continue;
    const oldBody = oldEl.querySelector('.c-card-body');
    const wasOpen = oldBody && oldBody.style.display !== 'none';
    const newEl = renderItem(item);
    if (wasOpen) {
      const newHeader = newEl.querySelector('.c-card-header');
      const newBody = newEl.querySelector('.c-card-body');
      if (newHeader && newBody) newHeader.click();
    }
    oldEl.replaceWith(newEl);
    itemEls.set(item, newEl);
  }
}

export function prependItems(items) {
  if (!items.length) return;
  const prevHeight = chatLog.scrollHeight;
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const node = renderItem(item);
    itemEls.set(item, node);
    frag.appendChild(node);
  }
  loadMoreBtn.after(frag);
  chatLog.scrollTop += (chatLog.scrollHeight - prevHeight);
}

export function clearChat() {
  chatLog.querySelectorAll('.c-card, .c-msg').forEach((n) => n.remove());
}

export { escapeHtml };
