// Modelo del transcript: pliega los eventos ligeros que manda el servidor
// (uno por bloque de contenido) en "items" renderizables, emparejando cada
// tool_use con su tool_result por toolUseId. Sin DOM aqui — solo datos.

export function createTranscript() {
  return {
    items: [], toolIndex: new Map(),
    // Contexto de la sesion (carpeta, rama, version, modelo) y contadores de
    // tokens: se acumulan aqui, nunca en el render, para que la cabecera pueda
    // leerlos de un tiron sin recorrer los items.
    info: {},
    stats: { inTotal: 0, outTotal: 0, ctx: 0, model: null },
  };
}

function makeItem(ev) {
  const base = { i: ev.i, ts: ev.ts, sidechain: ev.sidechain, uuid: ev.uuid };
  switch (ev.kind) {
    case 'user-text': return { ...base, type: 'user-text', text: ev.text };
    case 'assistant-text': return { ...base, type: 'assistant-text', text: ev.text };
    case 'thinking': return { ...base, type: 'thinking', text: ev.text };
    case 'attachment': return { ...base, type: 'attachment', attachment: ev.attachment };
    case 'image': return { ...base, type: 'image', mediaType: ev.mediaType, bytes: ev.bytes };
    case 'meta': return { ...base, type: 'meta', eventType: ev.eventType, subtype: ev.subtype || null, text: ev.text || null, raw: ev.raw, durationMs: ev.durationMs, messageCount: ev.messageCount, compact: ev.compact };
    default: return { ...base, type: 'meta', eventType: ev.kind, raw: ev };
  }
}

// Lo que el servidor manda en un evento 'session-info' (ver lib/claude-normalize).
const INFO_FIELDS = ['cwd', 'gitBranch', 'version', 'sessionId', 'slug', 'title', 'agentName'];

// Metadatos que el servidor cuelga del ultimo evento de cada turno del asistente.
function absorbTurnMeta(t, ev) {
  if (ev.model) t.stats.model = ev.model;
  if (!ev.usage) return;
  t.stats.inTotal += ev.usage.in || 0;
  t.stats.outTotal += ev.usage.out || 0;
  // Ventana de contexto en uso ahora mismo: es la cifra que de verdad importa
  // ("¿cuanto me queda?"), y solo vale la del turno mas reciente.
  t.stats.ctx = (ev.usage.in || 0) + (ev.usage.cacheRead || 0) + (ev.usage.cacheCreate || 0);
}

// Aplica un evento a la transcripcion; devuelve { item, isNew }. isNew=false
// significa que se muto un item ya existente (emparejamiento tool_use/tool_result)
// en vez de crear uno nuevo — el llamador no debe volver a insertarlo en la lista.
// backwards=true cuando el evento viene de "cargar mas": es MAS VIEJO que todo
// lo que ya hay, asi que no debe pisar el contexto ni el uso de ventana actuales.
function foldEvent(t, ev, backwards) {
  const folded = foldRaw(t, ev, backwards);
  // El servidor cuelga modelo/uso del ULTIMO evento del turno, que puede ser
  // perfectamente un tool_use. Se estampan en el item para que el pie del turno
  // los encuentre sin volver a recorrer los eventos.
  if (folded && folded.item && (ev.model || ev.usage)) {
    if (ev.model) folded.item.model = ev.model;
    if (ev.usage) folded.item.usage = ev.usage;
  }
  return folded;
}

function foldRaw(t, ev, backwards) {
  if (ev.kind === 'session-info') {
    if (!backwards) {
      for (const k of INFO_FIELDS) if (ev[k]) t.info[k] = ev[k];
    }
    return null;
  }
  if (!backwards && (ev.model || ev.usage)) absorbTurnMeta(t, ev);

  if (ev.kind === 'tool-result') {
    let item = t.toolIndex.get(ev.toolUseId);
    if (item) {
      item.output = ev.content;
      item.result = ev.result || null;
      item.isError = ev.isError;
      item.status = ev.isError ? 'error' : 'done';
      return { item, isNew: false };
    }
    // Resultado sin su tool_use cargado todavia (recorte de la ventana de
    // replay): se muestra como card huerfana hasta que "cargar mas" lo traiga.
    item = {
      i: ev.i, ts: ev.ts, sidechain: ev.sidechain, type: 'tool',
      toolUseId: ev.toolUseId, name: null, input: null, caller: null,
      status: ev.isError ? 'error' : 'done',
      output: ev.content, result: ev.result || null, isError: ev.isError,
    };
    t.toolIndex.set(ev.toolUseId, item);
    return { item, isNew: true };
  }
  if (ev.kind === 'tool-use') {
    let item = t.toolIndex.get(ev.toolUseId);
    if (item) {
      // El tool_use llega DESPUES que su resultado huerfano (cargando hacia
      // atras con "cargar mas"): completar la card ya existente.
      item.name = ev.name;
      item.input = ev.input;
      item.caller = ev.caller || null;
      return { item, isNew: false };
    }
    item = {
      i: ev.i, ts: ev.ts, sidechain: ev.sidechain, type: 'tool',
      toolUseId: ev.toolUseId, name: ev.name, input: ev.input, caller: ev.caller || null,
      status: 'pending', output: null, result: null, isError: false,
    };
    t.toolIndex.set(ev.toolUseId, item);
    return { item, isNew: true };
  }
  return { item: makeItem(ev), isNew: true };
}

// Eventos NUEVOS (mas recientes que todo lo cargado hasta ahora), en orden.
// Devuelve { added: [...en orden de aparicion], updated: [...items mutados] }
export function applyEvents(t, events) {
  const added = [];
  const updated = [];
  for (const ev of events) {
    const folded = foldEvent(t, ev);
    if (!folded) continue; // absorbido en t.info / t.stats, no produce card
    if (folded.isNew) { t.items.push(folded.item); added.push(folded.item); }
    else updated.push(folded.item);
  }
  return { added, updated };
}

// Tramo MAS ANTIGUO que todo lo cargado (respuesta de "cargar mas"). `events`
// viene ya en orden cronologico (mas viejo primero); se antepone tal cual.
export function prependEvents(t, events) {
  const added = [];
  const updated = [];
  for (const ev of events) {
    const folded = foldEvent(t, ev, true);
    if (!folded) continue;
    if (folded.isNew) added.push(folded.item); else updated.push(folded.item);
  }
  if (added.length) t.items.unshift(...added);
  return { added, updated };
}
