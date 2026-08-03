// Ensamblado del log: agrupa los items en turnos, mantiene el scroll pegado al
// fondo e hidrata los historiales largos por tandas.
//
// Un "turno" va de un mensaje del usuario al siguiente, y lleva cabecera (hora)
// y pie (duracion, modelo, tokens). Los eventos system/turn_duration no se
// pintan: alimentan ese pie.
import { el, dayKey, fmtDay, fmtTime, fmtDuration, fmtTokens, shortModel } from './dom.js';
import { closeCard, openCard } from './card.js';
import { renderItem, refreshItem } from './item.js';

const chatLog = document.getElementById('c-chat-log');
const loadMoreBtn = document.getElementById('c-load-more');
const jumpBtn = document.getElementById('c-jump');

const NEAR_BOTTOM_PX = 80;
const HYDRATE_THRESHOLD = 120; // por debajo de esto no compensa trocear
const HYDRATE_CHUNK = 60;

const itemEls = new WeakMap();
let target = chatLog;   // contenedor donde crecen los turnos (fragmento al anteponer)
let cur = null;         // turno en construccion
let curDay = null;
let hydrateToken = 0;
let unseen = 0;

// === Turnos ===

function newTurn(item) {
  const day = dayKey(item.ts);
  if (day && day !== curDay) {
    if (curDay !== null || target !== chatLog) target.appendChild(el('div', 'c-day-sep', fmtDay(item.ts)));
    curDay = day;
  }
  const turn = el('section', 'c-turn' + (item.sidechain ? ' c-turn--sub' : ''));
  turn._acc = { durMs: 0, msgCount: 0, inTok: 0, outTok: 0, model: null, hasContent: false };
  const head = el('div', 'c-turn-head');
  if (item.ts) head.appendChild(el('time', 'c-turn-time', fmtTime(item.ts)));
  const foot = el('div', 'c-turn-foot');
  turn.append(head, foot);
  turn._foot = foot;
  target.appendChild(turn);
  return turn;
}

function stat(icon, text) {
  const s = el('span', 'c-stat');
  if (icon) s.appendChild(el('span', null, icon));
  s.appendChild(el('span', null, text));
  return s;
}

function renderFoot(turn) {
  const a = turn._acc;
  const parts = [];
  if (a.durMs) parts.push(stat('\u{23F1}', fmtDuration(a.durMs)));
  if (a.msgCount) parts.push(stat('', a.msgCount + ' mensajes'));
  if (a.model) parts.push(stat('\u{271B}', shortModel(a.model)));
  if (a.inTok || a.outTok) parts.push(stat('', `\u{2191}${fmtTokens(a.inTok)} \u{2193}${fmtTokens(a.outTok)} tok`));
  turn._foot.replaceChildren(...parts);
}

// true si el item se consume en el pie del turno y no genera nodo propio.
function absorb(turn, item) {
  const a = turn._acc;
  if (item.usage) { a.inTok += item.usage.in || 0; a.outTok += item.usage.out || 0; }
  if (item.model) a.model = item.model;
  if (item.type === 'meta' && item.eventType === 'system' && item.subtype === 'turn_duration') {
    a.durMs += item.durationMs || 0;
    a.msgCount = Math.max(a.msgCount, item.messageCount || 0);
    return true;
  }
  return false;
}

// Solo la lista de tareas vigente queda abierta; las anteriores se colapsan.
function collapseOlderTodos(keep) {
  for (const card of chatLog.querySelectorAll('.c-card--todo')) {
    if (card !== keep) closeCard(card);
  }
}

function placeItem(item) {
  if (!cur || (item.type === 'user-text' && cur._acc.hasContent)) cur = newTurn(item);
  if (absorb(cur, item)) { renderFoot(cur); return; }
  const node = renderItem(item);
  if (!node) { renderFoot(cur); return; }
  itemEls.set(item, node);
  cur._foot.before(node);
  cur._acc.hasContent = true;
  if (node.classList && node.classList.contains('c-card--todo')) collapseOlderTodos(node);
  renderFoot(cur);
}

// === Scroll ===

export { openCard };

export function isNearBottom() {
  return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < NEAR_BOTTOM_PX;
}

function scrollToBottom(smooth) {
  unseen = 0;
  updateJump();
  chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function updateJump() {
  if (!jumpBtn) return;
  const show = unseen > 0 && !isNearBottom();
  jumpBtn.classList.toggle('visible', show);
  const badge = jumpBtn.querySelector('.c-jump-count');
  if (badge) badge.textContent = unseen > 99 ? '99+' : String(unseen);
}

// === API publica ===

// Tope de turnos vivos en el DOM. transcript.items queda INTACTO: sigue siendo
// la fuente de verdad para la busqueda y para repintar al cambiar de tab. Se
// prefiere esto a una virtualizacion real porque las alturas aqui son extremas
// (una card Read mide 60vh, un chip 24px) y windowing con alturas variables
// pelea con el scroll pegado al fondo por un beneficio marginal.
const MAX_LIVE_TURNS = 60;

function trimOldTurns() {
  const turns = chatLog.querySelectorAll('.c-turn');
  if (turns.length <= MAX_LIVE_TURNS) return;
  const drop = turns.length - MAX_LIVE_TURNS;
  for (let i = 0; i < drop; i++) {
    const t = turns[i];
    const prev = t.previousElementSibling;
    if (prev && prev.classList.contains('c-day-sep')) prev.remove();
    t.remove();
  }
  // "Cargar más" sigue funcionando: el servidor relee del fichero, no de aqui.
  loadMoreBtn.style.display = 'block';
}

export function appendItems(items) {
  if (!items || !items.length) return;
  if (items.length > HYDRATE_THRESHOLD) return hydrate(items);
  const stick = isNearBottom();
  for (const item of items) placeItem(item);
  trimOldTurns();
  if (stick) scrollToBottom();
  else { unseen += items.length; updateJump(); }
}

// Historial largo: se construye en tandas por frame para que la vista no se
// congele 1-3 s al enganchar. El token cancela la hidratacion en curso si se
// cambia de sesion o llega un reset.
function hydrate(items) {
  const token = ++hydrateToken;
  const ghost = el('div', 'c-hydrating', `Cargando ${items.length} mensajes…`);
  chatLog.appendChild(ghost);
  let idx = 0;
  const step = () => {
    if (token !== hydrateToken) { ghost.remove(); return; }
    const end = Math.min(idx + HYDRATE_CHUNK, items.length);
    for (; idx < end; idx++) placeItem(items[idx]);
    ghost.remove();
    if (idx < items.length) {
      chatLog.appendChild(ghost); // siempre al final, detras de los turnos nuevos
      requestAnimationFrame(step);
    } else {
      trimOldTurns();
      scrollToBottom();
    }
  };
  requestAnimationFrame(step);
}

export function updateItems(items) {
  for (const item of items || []) {
    const node = itemEls.get(item);
    if (!node) continue;
    if (refreshItem(node, item)) continue;
    const fresh = renderItem(item);
    if (!fresh) continue;
    node.replaceWith(fresh);
    itemEls.set(item, fresh);
  }
}

// Tramo mas antiguo ("cargar mas"): se monta en un fragmento aparte con su
// propio estado de turno y se inserta justo detras del boton.
export function prependItems(items) {
  if (!items || !items.length) return;
  const prevHeight = chatLog.scrollHeight;
  const prevTop = chatLog.scrollTop;
  const savedTarget = target, savedCur = cur, savedDay = curDay;
  const frag = document.createDocumentFragment();
  target = frag; cur = null; curDay = null;
  try {
    for (const item of items) placeItem(item);
  } finally {
    target = savedTarget; cur = savedCur; curDay = savedDay;
  }
  loadMoreBtn.after(frag);
  chatLog.scrollTop = prevTop + (chatLog.scrollHeight - prevHeight);
}

export function clearChat() {
  hydrateToken++; // cancela cualquier hidratacion en vuelo
  for (const node of [...chatLog.children]) {
    if (node !== loadMoreBtn) node.remove();
  }
  cur = null; curDay = null; unseen = 0;
  updateJump();
}

export function initRender(opts = {}) {
  chatLog.addEventListener('scroll', () => {
    if (isNearBottom()) unseen = 0;
    updateJump();
  }, { passive: true });

  if (jumpBtn) jumpBtn.addEventListener('click', () => scrollToBottom(true));

  // Referencias a fichero detectadas en la prosa (render/inline.js). Delegado
  // para que funcione tambien con los cuerpos de card construidos despues.
  chatLog.addEventListener('click', (e) => {
    const ref = e.target.closest('.c-ref');
    if (!ref || !opts.onOpenRef) return;
    e.preventDefault();
    opts.onOpenRef(ref.dataset.path, ref.dataset.line ? Number(ref.dataset.line) : null);
  });
}

// Nodo DOM de un item, para que la busqueda pueda saltar hasta el.
export function nodeFor(item) { return itemEls.get(item) || null; }

export function setNoiseHidden(hidden) {
  chatLog.classList.toggle('c-hide-noise', !!hidden);
}
