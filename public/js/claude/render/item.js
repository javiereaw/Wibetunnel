// Dispatch de un item de stream.js a su nodo DOM.
//
// Solo el mensaje del usuario va en burbuja. La respuesta del asistente es
// prosa a ancho completo con un rail a la izquierda: en 360px eso son ~15% mas
// de ancho util, que es la diferencia entre que un bloque de codigo se lea o no.
import { el, fmtFullTime } from './dom.js';
import { makeCard, updateCard } from './card.js';
import { renderMarkdown } from './md.js';
import { decorate } from './decorate.js';
import { toolSpec } from './tools.js';
import { metaNode, attachmentNode, imageNode } from './system.js';

function textBubble(item, roleClass) {
  const wrap = el('div', 'c-msg ' + roleClass + (item.sidechain ? ' c-turn--sub' : ''));
  const bubble = el('div', 'c-bubble');
  bubble.innerHTML = renderMarkdown(item.text || '');
  decorate(bubble);
  if (item.ts) wrap.title = fmtFullTime(item.ts);
  wrap.appendChild(bubble);
  return wrap;
}

function thinkingCard(item) {
  return makeCard({
    icon: '\u{273B}', label: 'Pensando', cls: 'c-thinking' + (item.sidechain ? ' c-card--sub' : ''),
    summary: (item.text || '').split('\n').find((l) => l.trim()) || '',
    buildBody: () => el('pre', 'c-thinking-body', item.text || ''),
  });
}

// Devuelve un Node, o null si el item no se pinta (lo absorbe el turno).
export function renderItem(item) {
  switch (item.type) {
    case 'user-text': return textBubble(item, 'c-msg-user');
    case 'assistant-text': return textBubble(item, 'c-msg-assistant');
    case 'thinking': return thinkingCard(item);
    case 'tool': return makeCard(toolSpec(item));
    case 'image': return imageNode(item);
    case 'attachment': return attachmentNode(item);
    case 'meta': return metaNode(item);
    default: return metaNode({ ...item, eventType: item.type, raw: item });
  }
}

// Re-render en sitio de un item mutado (el tool_result que llega despues de su
// tool_use). Devuelve true si se pudo actualizar sin reemplazar el nodo.
export function refreshItem(node, item) {
  if (item.type !== 'tool') return false;
  return updateCard(node, toolSpec(item));
}
