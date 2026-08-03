// Eventos de sistema y adjuntos: casi ninguno merece una card. La mayoria son
// notas de una linea (ocultables en bloque con el interruptor de ruido) y unos
// pocos son separadores anchos.
import { el, fmtTokens, fmtBytes, basename, fmtDuration } from './dom.js';
import { makeCard } from './card.js';
import { renderMarkdown } from './md.js';
import { prose } from './decorate.js';

function note(icon, text, tone) {
  const n = el('div', 'c-note');
  if (icon) n.appendChild(el('span', null, icon));
  const t = el('span', 'c-note-text', text);
  if (tone) t.classList.add('c-chip--' + tone);
  n.appendChild(t);
  n.title = text;
  return n;
}

function separator(text) { return el('div', 'c-sep', text); }

// === type: 'system' y 'summary' ===

// Devuelve null cuando el evento no se pinta: lo absorbe el pie del turno
// (render/index.js lo detecta antes de llamar aqui).
export function metaNode(item) {
  const type = item.eventType;

  if (type === 'system') {
    switch (item.subtype) {
      case 'turn_duration':
        return null; // alimenta .c-turn-foot
      case 'compact_boundary': {
        const c = item.compact || {};
        const detail = c.preTokens
          ? `Conversación compactada · ${fmtTokens(c.preTokens)} → ${fmtTokens(c.postTokens)} tokens`
          : 'Conversación compactada';
        return separator(detail);
      }
      case 'local_command': {
        const m = (item.content || '').match(/<command-name>([^<]*)<\/command-name>/);
        return note('\u{2318}', m ? m[1] : 'comando local');
      }
      case 'model_refusal_fallback':
      case 'model_refusal_no_fallback':
        return note('\u{26A0}', item.content || 'el modelo cambió', 'warn');
      default:
        return note('\u{2139}', item.content || item.subtype || 'sistema');
    }
  }

  if (type === 'fallback') {
    const r = item.raw || {};
    return note('\u{21C4}', `modelo cambiado: ${r.from || '?'} → ${r.to || '?'}`, 'warn');
  }

  if (type === 'summary') return separator(item.text || 'resumen de la conversación');

  if (type === 'pr-link') {
    const raw = item.raw || {};
    return note('\u{1F517}', raw.prUrl || ('PR #' + (raw.prNumber || '')), 'info');
  }

  // Tipo no reconocido: card plegada con el JSON, nunca volcado a pelo.
  return makeCard({
    label: type || 'evento', cls: 'c-meta', summary: item.text || '',
    buildBody: () => el('pre', 'c-card-input', JSON.stringify(item.raw, null, 2)),
  });
}

// === type: 'attachment' ===

export function attachmentNode(item) {
  const a = item.attachment || {};
  switch (a.at) {
    case 'edited_text_file':
      return makeCard({
        icon: '\u{1F4DD}', label: 'Editado fuera', summary: basename(a.filename) || '',
        cls: 'c-meta',
        buildBody: () => el('pre', 'c-card-input', a.snippet || ''),
      });
    case 'queued_command':
      return makeCard({
        icon: '\u{23F3}', label: 'En cola', cls: 'c-meta',
        summary: (a.prompt || '').split('\n')[0].slice(0, 80),
        buildBody: () => prose(renderMarkdown(a.prompt || ''), 'c-bubble'),
      });
    case 'read_truncation_notice':
      return note('\u{26A0}', 'vista parcial del fichero', 'warn');
    case 'plan_mode':
      return note('\u{1F4CB}', 'modo plan activado');
    case 'plan_mode_exit':
      return note('\u{1F4CB}', 'salida del modo plan');
    case 'auto_mode':
      return note('\u{26A1}', 'modo automático');
    case 'date_change':
      return note('\u{1F4C5}', 'cambio de día: ' + (a.newDate || ''));
    case 'nested_memory':
      return note('\u{1F9E0}', 'memoria: ' + (a.path || ''));
    case 'dynamic_skill':
      return note('\u{1F9E9}', 'skills: ' + (a.skillNames || []).join(', '));
    case 'skill_listing':
      return note('\u{1F9E9}', `${a.count || 0} skills disponibles`);
    case 'deferred_tools_delta':
      return note('\u{1F9F0}', `herramientas: +${(a.added || []).length}`);
    case 'agent_listing_delta':
      return note('\u{1F916}', `agentes: ${(a.added || []).join(', ')}`);
    case 'command_permissions':
      return note('\u{1F511}', 'permisos: ' + (a.allowedTools || []).join(', '));
    case 'task_reminder':
      return note('\u{2611}', `${a.itemCount} tareas pendientes`);
    case 'file':
      return note('\u{1F4CE}', basename(a.filename) || 'adjunto');
    default:
      return note('\u{2022}', a.at || 'adjunto');
  }
}

export function imageNode(item) {
  return note('\u{1F5BC}', `imagen · ${(item.mediaType || '').replace('image/', '').toUpperCase()} · ${fmtBytes(item.bytes)}`);
}

export { note, separator, fmtDuration };
