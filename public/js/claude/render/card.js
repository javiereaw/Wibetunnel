// Card plegable: cabecera con resumen de una linea + cuerpo perezoso.
//
// updateCard reescribe la cabecera EN SITIO. La version anterior re-renderizaba
// la card entera y volvia a expandirla con un header.click() sintetico, que
// perdia la posicion de scroll del cuerpo y disparaba los listeners de nuevo.
import { el, chip } from './dom.js';

const CHEV_OPEN = '▾';   // ▾
const CHEV_CLOSED = '▸'; // ▸

function bodyOf(card) { return card.lastElementChild; }
function headerOf(card) { return card.firstElementChild; }

function setOpen(card, open) {
  const body = bodyOf(card);
  if (open && body.dataset.built !== '1') {
    body.replaceChildren(card._spec.buildBody ? card._spec.buildBody() : document.createDocumentFragment());
    body.dataset.built = '1';
  }
  body.style.display = open ? 'block' : 'none';
  const chev = headerOf(card).firstElementChild;
  if (chev) chev.textContent = open ? CHEV_OPEN : CHEV_CLOSED;
}

export function isCardOpen(card) { return bodyOf(card).style.display !== 'none'; }
export function openCard(card) { setOpen(card, true); }
export function closeCard(card) { if (card && card._spec) setOpen(card, false); }

// spec: { icon, label, summary (string|Node), chips:[{text,tone}], status, cls, buildBody, open }
function applySpec(card, spec) {
  const prev = card._spec;
  card._spec = spec;
  card.className = 'c-card' + (spec.cls ? ' ' + spec.cls : '');

  const head = headerOf(card);
  const parts = [el('span', 'c-chevron', isCardOpen(card) ? CHEV_OPEN : CHEV_CLOSED)];
  if (spec.icon) parts.push(el('span', 'c-tool-icon', spec.icon));
  if (spec.label) parts.push(el('span', 'c-tool-label', spec.label));
  parts.push(spec.summary instanceof Node ? spec.summary : el('span', 'c-tool-summary', spec.summary || ''));
  for (const c of spec.chips || []) parts.push(chip(c.text, c.tone));
  if (spec.status) parts.push(el('span', 'c-tool-status', spec.status));
  head.replaceChildren(...parts);

  // Si el cuerpo ya estaba construido y el contenido ha cambiado (p.ej. llego
  // el tool_result de una card pendiente), se reconstruye conservando el scroll.
  const body = bodyOf(card);
  if (body.dataset.built === '1' && prev !== spec) {
    const top = body.scrollTop;
    body.replaceChildren(spec.buildBody ? spec.buildBody() : document.createDocumentFragment());
    body.scrollTop = top;
  }
}

export function makeCard(spec) {
  const card = el('div', 'c-card');
  const head = el('div', 'c-card-header');
  const body = el('div', 'c-card-body');
  body.style.display = 'none';
  card.append(head, body);
  head.addEventListener('click', () => setOpen(card, !isCardOpen(card)));
  applySpec(card, spec);
  if (spec.open) setOpen(card, true);
  return card;
}

export function updateCard(card, spec) {
  if (!card || !card.classList.contains('c-card')) return false;
  applySpec(card, spec);
  return true;
}
