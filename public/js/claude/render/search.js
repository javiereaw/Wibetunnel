// Busqueda dentro del chat.
//
// Se busca sobre transcript.items (los DATOS), no sobre el DOM. Es lo unico que
// funciona con cuerpos de card perezosos —el texto de un resultado de Bash no
// existe en el DOM hasta que despliegas la card— y seguira funcionando cuando
// haya un tope de nodos vivos.
import { el } from './dom.js';

const MAX_HITS = 500;

// Campos donde tiene sentido buscar, por tipo de item.
function itemText(item) {
  switch (item.type) {
    case 'user-text':
    case 'assistant-text':
    case 'thinking':
      return item.text || '';
    case 'tool': {
      const parts = [item.name || ''];
      if (item.input) { try { parts.push(JSON.stringify(item.input)); } catch (_) { /* input raro */ } }
      if (typeof item.output === 'string') parts.push(item.output);
      const r = item.result;
      if (r) {
        if (r.stdout) parts.push(r.stdout);
        if (r.stderr) parts.push(r.stderr);
        if (r.filePath) parts.push(r.filePath);
        if (r.content) parts.push(r.content);
      }
      return parts.join('\n');
    }
    case 'meta':
      return item.text || item.eventType || '';
    default:
      return '';
  }
}

export function search(items, query) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const hits = [];
  for (const item of items || []) {
    const text = itemText(item);
    if (!text) continue;
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) continue;
    hits.push({ item, offset: at, len: q.length, preview: text.slice(Math.max(0, at - 30), at + 70) });
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

// Lleva el hit a la vista: si cae dentro del cuerpo de una card, la despliega.
export function gotoHit(hit, nodeFor, openCard) {
  const node = nodeFor(hit.item);
  if (!node) return false;
  if (node.classList.contains('c-card') && openCard) openCard(node);
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('c-hit-flash');
  setTimeout(() => node.classList.remove('c-hit-flash'), 1200);
  return true;
}

export function makeCounter() { return el('span', 'c-search-count', ''); }
