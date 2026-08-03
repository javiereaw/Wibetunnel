// Normalizacion pura del JSONL de Claude Code -> eventos ligeros para el cliente.
// Sin I/O, sin timers, sin estado global: lib/claude-watch.js aporta el fichero,
// el tailing y los watchers; aqui solo se decide QUE se manda y QUE se descarta.
//
// Tres invariantes que no se pueden romper:
//  1. Nunca reenviar un campo que duplique otro campo del mismo evento
//     (file.content vs el tool_result textual, stdout vs content en Bash) ni
//     binarios en base64: al otro lado hay un movil detras de un tunel.
//  2. summarizeToolResult despacha por la FORMA del objeto, NO por el nombre de
//     la herramienta: el tool_use puede haber quedado fuera de la ventana de
//     replay, asi que el nombre no siempre esta disponible cuando llega el
//     resultado.
//  3. Todo lo que no se reconoce se sigue mostrando (como card 'meta'), pero
//     capado en bytes. Descartar es solo para bookkeeping sin contenido visible.

const MAX_FIELD_CHARS = 120 * 1024;  // tope por campo de texto largo (stdout, result...)
const MAX_JSON_BYTES = 8 * 1024;     // tope de un objeto crudo que se manda como JSON
const MAX_RESULT_BYTES = 64 * 1024;  // tope del toolUseResult resumido entero

// Lineas de puro bookkeeping: ~19% del JSONL real, sin nada que ensenar.
// Filtrarlas aqui hace que la misma ventana de replay cubra mas conversacion util.
const DROP_TYPES = new Set([
  'queue-operation', 'last-prompt',
  'mode', 'permission-mode',
  'file-history-snapshot', 'file-history-delta',
  'bridge-session',
]);

// Campos de contexto que van repetidos en casi todas las lineas: se emiten como
// un unico evento 'session-info' cuando cambian (ver parseLines), nunca por evento.
const CTX_FIELDS = ['cwd', 'gitBranch', 'version', 'sessionId', 'slug'];

function clip(s, max = MAX_FIELD_CHARS) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) + `\n… [recortado, ${s.length} caracteres]` : s;
}

// Devuelve el valor tal cual si cabe; si no, un marcador con una vista previa.
function capJson(value, max = MAX_JSON_BYTES) {
  let s;
  try { s = JSON.stringify(value); } catch (_) { return { _clipped: true }; }
  if (s === undefined) return null;
  return s.length <= max ? value : { _clipped: s.length, preview: s.slice(0, max) };
}

function num(v) { return Number.isFinite(v) ? v : null; }

// === usage: 5 numeros, nunca el objeto entero (trae iterations[], que crece) ===

function pickUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    in: num(u.input_tokens) || 0,
    out: num(u.output_tokens) || 0,
    cacheRead: num(u.cache_read_input_tokens) || 0,
    cacheCreate: num(u.cache_creation_input_tokens) || 0,
    tier: u.service_tier || null,
  };
}

// === toolUseResult: despacho por forma ===

function pickResultShape(tr) {
  // Bash y familia. El tool_result textual es stdout+stderr concatenados en el
  // ~92% de los casos, asi que quien llame descarta el textual y usa estos dos.
  if (tr.stdout !== undefined || tr.stderr !== undefined) {
    return {
      kind: 'bash',
      stdout: clip(tr.stdout),
      stderr: clip(tr.stderr),
      interrupted: !!tr.interrupted,
      backgroundTaskId: tr.backgroundTaskId || null,
      gitOperation: tr.gitOperation || null,
      persistedOutputPath: tr.persistedOutputPath || null,
      returnCodeInterpretation: tr.returnCodeInterpretation || null,
      timedOutAfterMs: num(tr.timedOutAfterMs),
      sandboxDisabled: !!tr.dangerouslyDisableSandbox,
    };
  }
  // Edit / MultiEdit: el patch estructurado es lo unico que hace falta.
  // originalFile (el fichero ENTERO antes del cambio) y oldString/newString son
  // redundantes con el patch y pueden pesar cientos de KB.
  if (Array.isArray(tr.structuredPatch) && tr.oldString !== undefined) {
    return {
      kind: 'edit',
      filePath: tr.filePath || null,
      patch: tr.structuredPatch,
      replaceAll: !!tr.replaceAll,
      userModified: !!tr.userModified,
    };
  }
  // Write: mismo caso, pero el redundante es content (el fichero nuevo entero).
  if (Array.isArray(tr.structuredPatch)) {
    return {
      kind: 'write',
      filePath: tr.filePath || null,
      type: tr.type || null,
      patch: tr.structuredPatch,
      lines: typeof tr.content === 'string' ? tr.content.split('\n').length : null,
      userModified: !!tr.userModified,
    };
  }
  // Read: file.content duplica el tool_result textual (que ademas trae los
  // numeros de linea, que es lo que queremos pintar). Solo metadatos.
  if (tr.file && typeof tr.file === 'object') {
    const f = tr.file;
    return {
      kind: 'read',
      filePath: f.filePath || null,
      numLines: num(f.numLines),
      startLine: num(f.startLine),
      totalLines: num(f.totalLines),
    };
  }
  // Listas de tareas: esquema clasico (TodoWrite) y el actual (TaskCreate/TaskUpdate).
  if (tr.oldTodos !== undefined || tr.newTodos !== undefined) {
    return { kind: 'todos', todos: capJson(tr.newTodos || []), prev: capJson(tr.oldTodos || []) };
  }
  if (tr.taskId && tr.statusChange) {
    return {
      kind: 'task-update',
      taskId: tr.taskId,
      statusChange: tr.statusChange,
      updatedFields: tr.updatedFields || [],
    };
  }
  if (tr.task) {
    return { kind: 'task', task: capJson(tr.task, 2048), retrievalStatus: tr.retrieval_status || null };
  }
  if (tr.taskId && tr.timeoutMs !== undefined) {
    return { kind: 'monitor', taskId: tr.taskId, timeoutMs: num(tr.timeoutMs), persistent: !!tr.persistent };
  }
  // Subagentes. Se descarta `prompt` (lo repite la card del tool_use).
  if (tr.agentId) {
    return {
      kind: 'agent',
      agentId: tr.agentId,
      agentType: tr.agentType || null,
      description: tr.description || null,
      status: tr.status || null,
      resolvedModel: tr.resolvedModel || null,
      isAsync: !!tr.isAsync,
      outputFile: tr.outputFile || null,
      content: clip(tr.content),
      toolStats: capJson(tr.toolStats, 2048),
      totalTokens: num(tr.totalTokens),
      totalDurationMs: num(tr.totalDurationMs),
      totalToolUseCount: num(tr.totalToolUseCount),
    };
  }
  if (Array.isArray(tr.matches) && tr.query !== undefined) {
    return { kind: 'toolsearch', query: tr.query, matches: tr.matches.slice(0, 60), total: num(tr.total_deferred_tools) };
  }
  if (Array.isArray(tr.results) && tr.query !== undefined) {
    return {
      kind: 'websearch',
      query: tr.query,
      results: capJson(tr.results.slice(0, 20), 32 * 1024),
      searchCount: num(tr.searchCount),
      durationSeconds: num(tr.durationSeconds),
    };
  }
  if (tr.url && tr.code !== undefined) {
    return {
      kind: 'webfetch',
      url: tr.url, code: num(tr.code), codeText: tr.codeText || null,
      bytes: num(tr.bytes), durationMs: num(tr.durationMs), result: clip(tr.result),
    };
  }
  if (tr.questions !== undefined || tr.answers !== undefined) {
    return { kind: 'questions', questions: capJson(tr.questions), answers: capJson(tr.answers) };
  }
  if (tr.plan !== undefined) {
    return { kind: 'plan', plan: clip(tr.plan), filePath: tr.filePath || null, isAgent: !!tr.isAgent };
  }
  if (Array.isArray(tr.attachments)) {
    return {
      kind: 'files',
      caption: tr.caption || null,
      files: tr.attachments.slice(0, 20).map((a) => ({
        path: (a && a.path) || null, size: num(a && a.size), isImage: !!(a && a.isImage),
      })),
    };
  }
  if (tr.status !== undefined && tr.json !== undefined) {
    return { kind: 'http', status: tr.status, json: clip(typeof tr.json === 'string' ? tr.json : JSON.stringify(tr.json)) };
  }
  return { kind: 'json', value: capJson(tr) };
}

function summarizeToolResult(tr) {
  if (typeof tr === 'string' || tr == null) return null; // el content textual ya lo dice todo
  if (typeof tr !== 'object' || Array.isArray(tr)) return null;
  const out = pickResultShape(tr);
  if (!out) return null;
  let size;
  try { size = JSON.stringify(out).length; } catch (_) { return { kind: 'too-big', bytes: 0 }; }
  return size > MAX_RESULT_BYTES ? { kind: 'too-big', bytes: size } : out;
}

// === Bloques de contenido ===

// Aplana el content de un tool_result a un string. Los bloques no textuales se
// sustituyen por un marcador: antes caian en String(objeto) -> "[object Object]".
function flattenResultContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((c) => {
    if (typeof c === 'string') return c;
    if (!c || typeof c !== 'object') return '';
    if (c.type === 'text') return c.text || '';
    if (c.type === 'image') return '[imagen]';
    if (c.type === 'tool_reference') return '[herramienta: ' + (c.tool_name || '?') + ']';
    return '[' + (c.type || 'bloque') + ']';
  }).join('\n');
}

function blockToEvents(base, block, isUser) {
  if (!block || typeof block !== 'object') return [];
  switch (block.type) {
    case 'text':
      return block.text ? [{ ...base, kind: isUser ? 'user-text' : 'assistant-text', text: clip(block.text) }] : [];
    case 'thinking':
      return [{ ...base, kind: 'thinking', text: clip(block.thinking) }];
    case 'tool_use':
      return [{ ...base, kind: 'tool-use', toolUseId: block.id, name: block.name, input: capJson(block.input, 32 * 1024), caller: block.caller || null }];
    case 'tool_result':
      return [{ ...base, kind: 'tool-result', toolUseId: block.tool_use_id, content: clip(flattenResultContent(block.content)), isError: !!block.is_error }];
    case 'image': {
      // NUNCA reenviar el base64: una captura pegada son cientos de KB por el socket.
      const src = block.source || {};
      const data = typeof src.data === 'string' ? src.data : '';
      return [{ ...base, kind: 'image', mediaType: src.media_type || null, bytes: Math.round(data.length * 0.75) }];
    }
    case 'fallback':
      return [{ ...base, kind: 'meta', eventType: 'fallback',
        raw: { from: (block.from && block.from.model) || null, to: (block.to && block.to.model) || null } }];
    default:
      return [{ ...base, kind: 'meta', eventType: block.type || 'block', raw: capJson(block) }];
  }
}

// === Attachments: 16 subtipos, algunos de 13 KB por linea ===

function compactAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const t = a.type || 'attachment';
  switch (t) {
    case 'task_reminder':
      if (!a.itemCount) return null; // recordatorio vacio: ruido puro
      return { at: t, itemCount: a.itemCount, content: capJson(a.content, 4096) };
    case 'edited_text_file':
      return { at: t, filename: a.filename || null, snippet: clip(a.snippet, 8192) };
    case 'queued_command':
      return { at: t, prompt: clip(a.prompt, 4096), commandMode: a.commandMode || null };
    case 'read_truncation_notice':
      return { at: t, banner: clip(a.banner, 2048), toolUseID: a.toolUseID || null };
    case 'nested_memory':
      return { at: t, path: a.displayPath || a.path || null };
    case 'dynamic_skill':
      return { at: t, displayPath: a.displayPath || null, skillNames: a.skillNames || [] };
    case 'skill_listing':
      return { at: t, count: num(a.skillCount) || (a.names || []).length, names: a.names || [] };
    case 'deferred_tools_delta':
      return { at: t, added: a.addedNames || [], removed: a.removedNames || [] };
    case 'agent_listing_delta':
      return { at: t, added: a.addedTypes || [], removed: a.removedTypes || [] };
    case 'plan_mode':
    case 'plan_mode_exit':
    case 'plan_file_reference':
      return { at: t, planFilePath: a.planFilePath || null, planExists: !!a.planExists };
    case 'auto_mode':
      return { at: t, consent: !!a.autoModeConsentFlow };
    case 'command_permissions':
      return { at: t, allowedTools: a.allowedTools || [] };
    case 'date_change':
      return { at: t, newDate: a.newDate || null };
    case 'file':
      return { at: t, filename: a.filename || a.displayPath || null };
    default:
      return { at: t, raw: capJson(a, 2048) };
  }
}

// === Linea -> 0..n eventos ===

function normalizeLine(o) {
  if (!o || typeof o !== 'object') return [];
  if (DROP_TYPES.has(o.type)) return [];

  const base = {
    ts: o.timestamp || null,
    uuid: o.uuid || null,
    parentUuid: o.parentUuid || null,
    sidechain: !!o.isSidechain,
  };

  if (o.type === 'user' || o.type === 'assistant') {
    const content = o.message && o.message.content;
    const isUser = o.type === 'user';
    let evs;
    if (typeof content === 'string') {
      evs = content ? [{ ...base, kind: isUser ? 'user-text' : 'assistant-text', text: clip(content) }] : [];
    } else if (Array.isArray(content)) {
      evs = content.flatMap((b) => blockToEvents(base, b, isUser));
    } else {
      evs = [];
    }
    if (!evs.length) return evs;

    // Modelo / stop_reason / tokens: al ULTIMO evento del turno, para que el
    // cliente pueda cerrar el pie del turno sin inflar todos los eventos.
    if (!isUser) {
      const m = o.message || {};
      const last = evs[evs.length - 1];
      last.model = m.model || null;
      last.stopReason = m.stop_reason || null;
      last.usage = pickUsage(m.usage);
    }
    // El resultado estructurado va pegado a su tool-result.
    if (o.toolUseResult !== undefined) {
      const summary = summarizeToolResult(o.toolUseResult);
      if (summary) {
        for (const ev of evs) {
          if (ev.kind !== 'tool-result') continue;
          ev.result = summary;
          if (summary.kind === 'bash') ev.content = null; // stdout/stderr lo sustituyen
        }
      }
    }
    return evs;
  }

  if (o.type === 'attachment') {
    const at = compactAttachment(o.attachment);
    return at ? [{ ...base, kind: 'attachment', attachment: at }] : [];
  }

  if (o.type === 'system') {
    const cm = o.compactMetadata;
    return [{
      ...base, kind: 'meta', eventType: 'system', subtype: o.subtype || null,
      level: o.level || null,
      content: typeof o.content === 'string' ? clip(o.content, 8192) : null,
      durationMs: num(o.durationMs),
      messageCount: num(o.messageCount),
      compact: cm ? {
        trigger: cm.trigger || null, preTokens: num(cm.preTokens),
        postTokens: num(cm.postTokens), durationMs: num(cm.durationMs),
      } : null,
    }];
  }

  // Titulo generado y nombre de agente: contexto de cabecera, no cards.
  if (o.type === 'ai-title') return [{ ...base, kind: 'session-info', title: o.aiTitle || null }];
  if (o.type === 'agent-name') return [{ ...base, kind: 'session-info', agentName: o.agentName || o.name || null }];

  return [{
    ...base, kind: 'meta', eventType: o.type || 'unknown',
    text: typeof o.summary === 'string' ? o.summary : (typeof o.content === 'string' ? clip(o.content, 4096) : null),
    raw: capJson(o, 4096),
  }];
}

// === Parseo de un bloque de lineas, con diferencial de contexto ===

function createParseContext() { return { last: null }; }

// Emite un session-info solo cuando alguno de los CTX_FIELDS cambia respecto de
// la ultima linea util. Sin esto, cwd/gitBranch/version/sessionId viajarian en
// practicamente cada evento del transcript.
function contextEvent(ctx, o) {
  const next = {};
  let changed = false;
  for (const k of CTX_FIELDS) {
    const v = o[k];
    if (typeof v !== 'string' || !v) continue;
    next[k] = v;
    if (!ctx.last || ctx.last[k] !== v) changed = true;
  }
  if (!changed) return null;
  ctx.last = { ...(ctx.last || {}), ...next };
  return { kind: 'session-info', ...ctx.last };
}

function parseLines(lines, ctx) {
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; } // linea partida/corrupta: se ignora
    const evs = normalizeLine(obj);
    if (!evs.length) continue; // no gastar un session-info en una linea descartada
    if (ctx) {
      const ci = contextEvent(ctx, obj);
      if (ci) events.push(ci);
    }
    events.push(...evs);
  }
  return events;
}

module.exports = {
  normalizeLine, blockToEvents, summarizeToolResult, pickUsage,
  parseLines, createParseContext, compactAttachment, flattenResultContent,
};
