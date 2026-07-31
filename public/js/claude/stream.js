// Modelo del transcript: pliega los eventos ligeros que manda el servidor
// (uno por bloque de contenido) en "items" renderizables, emparejando cada
// tool_use con su tool_result por toolUseId. Sin DOM aqui — solo datos.

export function createTranscript() {
  return { items: [], toolIndex: new Map() };
}

function makeItem(ev) {
  const base = { i: ev.i, ts: ev.ts, sidechain: ev.sidechain, uuid: ev.uuid };
  switch (ev.kind) {
    case 'user-text': return { ...base, type: 'user-text', text: ev.text };
    case 'assistant-text': return { ...base, type: 'assistant-text', text: ev.text };
    case 'thinking': return { ...base, type: 'thinking', text: ev.text };
    case 'attachment': return { ...base, type: 'attachment', attachment: ev.attachment };
    case 'meta': return { ...base, type: 'meta', eventType: ev.eventType, raw: ev.raw };
    default: return { ...base, type: 'meta', eventType: ev.kind, raw: ev };
  }
}

// Aplica un evento a la transcripcion; devuelve { item, isNew }. isNew=false
// significa que se muto un item ya existente (emparejamiento tool_use/tool_result)
// en vez de crear uno nuevo — el llamador no debe volver a insertarlo en la lista.
function foldEvent(t, ev) {
  if (ev.kind === 'tool-result') {
    let item = t.toolIndex.get(ev.toolUseId);
    if (item) {
      item.result = ev.content;
      item.isError = ev.isError;
      item.status = ev.isError ? 'error' : 'done';
      return { item, isNew: false };
    }
    // Resultado sin su tool_use cargado todavia (recorte de la ventana de
    // replay): se muestra como card huerfana hasta que "cargar mas" lo traiga.
    item = {
      i: ev.i, ts: ev.ts, sidechain: ev.sidechain, type: 'tool',
      toolUseId: ev.toolUseId, name: null, input: null, caller: null,
      status: ev.isError ? 'error' : 'done', result: ev.content, isError: ev.isError,
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
      status: 'pending', result: null, isError: false,
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
    const { item, isNew } = foldEvent(t, ev);
    if (isNew) { t.items.push(item); added.push(item); }
    else updated.push(item);
  }
  return { added, updated };
}

// Tramo MAS ANTIGUO que todo lo cargado (respuesta de "cargar mas"). `events`
// viene ya en orden cronologico (mas viejo primero); se antepone tal cual.
export function prependEvents(t, events) {
  const added = [];
  const updated = [];
  for (const ev of events) {
    const { item, isNew } = foldEvent(t, ev);
    if (isNew) added.push(item); else updated.push(item);
  }
  if (added.length) t.items.unshift(...added);
  return { added, updated };
}
