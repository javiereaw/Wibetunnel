// Render por herramienta: de un item de stream.js a una spec de card.js.
//
// Aqui vive el nucleo (ficheros y shell). El resto de herramientas esta en
// tools-extra.js. Todo se apoya en `item.result`, el resultado ESTRUCTURADO que
// resume lib/claude-normalize (structuredPatch de Edit, stdout/stderr de Bash,
// metadatos de Read...). `item.output` es el texto plano del tool_result, que
// se usa cuando no hay estructura o cuando es lo unico legible.
import { el, cappedBlock, streamBlock, kvTable, isFlatSmall, basename, shortPath, fmtBytes } from './dom.js';
import { renderPatch, renderInlinePair, patchStats } from './diff.js';
import { extraSpec } from './tools-extra.js';

export const TOOL_ICON = {
  Read: '\u{1F4C4}', Write: '\u{1F4DD}', Edit: '\u{270F}\u{FE0F}', MultiEdit: '\u{270F}\u{FE0F}',
  Bash: '\u{276F}', BashOutput: '\u{276F}', Grep: '\u{1F50E}', Glob: '\u{1F5C2}\u{FE0F}',
  Task: '\u{1F916}', Agent: '\u{1F916}', TodoWrite: '\u{2611}\u{FE0F}',
  TaskCreate: '\u{2795}', TaskUpdate: '\u{2714}\u{FE0F}', TaskList: '\u{2611}\u{FE0F}',
  WebFetch: '\u{1F310}', WebSearch: '\u{1F50D}', ToolSearch: '\u{1F9F0}',
  AskUserQuestion: '\u{2753}', ExitPlanMode: '\u{1F4CB}', Skill: '\u{1F9E9}',
};

function statusIcon(item) {
  if (item.status === 'pending') return '\u{23F3}';
  if (item.status === 'error') return '\u{2716}';
  return '\u{2714}';
}

// Texto plano del resultado, sea cual sea la forma en que vino.
function outputText(item) {
  if (typeof item.output === 'string' && item.output) return item.output;
  if (item.result && item.result.kind === 'json') return JSON.stringify(item.result.value, null, 2);
  if (item.result && item.result.kind === 'too-big') return `[resultado de ${fmtBytes(item.result.bytes)}, demasiado grande para mostrarlo]`;
  return null;
}

function outputBlock(item) {
  const text = outputText(item);
  if (text != null) return cappedBlock(text, 'c-card-output' + (item.isError ? ' c-error' : ''));
  if (item.status === 'pending') return el('div', 'c-pending', 'Ejecutando…');
  return el('div', 'c-pending', 'Sin salida');
}

function inputBlock(input, name) {
  if (!input || typeof input !== 'object' || !Object.keys(input).length) return null;
  if (isFlatSmall(input)) return kvTable(input);
  return cappedBlock(JSON.stringify(input, null, 2), 'c-card-input');
}

// === Herramientas de fichero ===

function readSpec(item) {
  const r = item.result;
  const path = (r && r.filePath) || (item.input && item.input.file_path) || '';
  const chips = [];
  if (r && r.startLine > 1) chips.push({ text: `líneas ${r.startLine}–${r.startLine + (r.numLines || 0) - 1} de ${r.totalLines}`, tone: 'warn' });
  else if (r && r.numLines) chips.push({ text: `${r.numLines} líneas` });
  return { label: basename(path) || 'Read', summary: shortPath(path, 2), chips, buildBody: () => outputBlock(item) };
}

function writeSpec(item) {
  const r = item.result;
  const path = (r && r.filePath) || (item.input && item.input.file_path) || '';
  const chips = [];
  if (r && r.patch) {
    const { added, removed } = patchStats(r.patch);
    chips.push({ text: r.type === 'create' ? `nuevo · ${added} líneas` : `+${added} −${removed}`, tone: 'ok' });
  } else if (r && r.lines) {
    chips.push({ text: `${r.lines} líneas` });
  }
  return {
    label: basename(path) || 'Write', summary: shortPath(path, 2), chips,
    buildBody: () => {
      const frag = document.createDocumentFragment();
      if (r && r.patch && r.patch.length) frag.appendChild(renderPatch(r.patch));
      else if (item.input && typeof item.input.content === 'string') frag.appendChild(cappedBlock(item.input.content, 'c-card-input'));
      const out = outputText(item);
      if (out) frag.appendChild(cappedBlock(out, 'c-card-output' + (item.isError ? ' c-error' : '')));
      return frag;
    },
  };
}

function editSpec(item) {
  const r = item.result;
  const input = item.input || {};
  const path = (r && r.filePath) || input.file_path || '';
  const chips = [];
  if (r && r.patch) {
    const { added, removed } = patchStats(r.patch);
    chips.push({ text: `+${added} −${removed}`, tone: 'ok' });
  }
  if (Array.isArray(input.edits)) chips.push({ text: `${input.edits.length} ediciones` });
  if (r && r.replaceAll) chips.push({ text: 'todas', tone: 'info' });
  return {
    label: basename(path) || item.name, summary: shortPath(path, 2), chips,
    buildBody: () => {
      const frag = document.createDocumentFragment();
      if (r && Array.isArray(r.patch) && r.patch.length) {
        frag.appendChild(renderPatch(r.patch));
      } else if (input.old_string !== undefined) {
        // Sin patch del servidor (resultado fuera de la ventana de replay):
        // se compara lo que pidio el modelo, que es lo unico disponible.
        frag.appendChild(renderInlinePair(input.old_string, input.new_string));
      } else if (Array.isArray(input.edits)) {
        for (const e of input.edits) frag.appendChild(renderInlinePair(e.old_string, e.new_string));
      }
      if (item.isError) frag.appendChild(cappedBlock(outputText(item) || '', 'c-card-output c-error'));
      return frag;
    },
  };
}

// === Shell ===

function bashSpec(item) {
  const input = item.input || {};
  const r = item.result;
  const cmd = input.command || (r && r.gitOperation) || '';
  const chips = [];
  if (r) {
    if (r.interrupted) chips.push({ text: 'interrumpido', tone: 'warn' });
    if (r.backgroundTaskId) chips.push({ text: 'en segundo plano', tone: 'info' });
    if (r.timedOutAfterMs) chips.push({ text: 'timeout', tone: 'warn' });
    if (r.stderr) chips.push({ text: 'stderr', tone: 'err' });
  }
  return {
    label: 'Bash', summary: cmd, chips,
    buildBody: () => {
      const frag = document.createDocumentFragment();
      if (cmd) frag.appendChild(cappedBlock(cmd, 'c-card-input'));
      if (input.description) frag.appendChild(el('div', 'c-note-text', input.description));
      if (r && r.kind === 'bash') {
        const out = streamBlock(r.stdout, 'stdout', false);
        const err = streamBlock(r.stderr, 'stderr', true);
        if (out) frag.appendChild(out);
        if (err) frag.appendChild(err);
        if (!out && !err) frag.appendChild(el('div', 'c-pending', item.status === 'pending' ? 'Ejecutando…' : 'Sin salida'));
        if (r.persistedOutputPath) frag.appendChild(el('div', 'c-note-text', 'Salida completa: ' + r.persistedOutputPath));
        if (r.returnCodeInterpretation) frag.appendChild(el('div', 'c-note-text', r.returnCodeInterpretation));
      } else {
        frag.appendChild(outputBlock(item));
      }
      return frag;
    },
  };
}

// === Busqueda ===

const HIT_RE = /^(.*?):(\d+):(.*)$/;

function renderHits(text, pattern) {
  const box = el('div', 'c-hits');
  const lines = String(text).split('\n').filter(Boolean).slice(0, 400);
  // El patron viene del modelo: puede no ser una regex valida de JS.
  let re;
  try { re = pattern ? new RegExp(pattern, 'i') : null; } catch (_) { re = null; }
  let lastFile = null;
  for (const line of lines) {
    const m = line.match(HIT_RE);
    if (!m) { box.appendChild(el('div', 'c-hit', line)); continue; }
    if (m[1] !== lastFile) { box.appendChild(el('div', 'c-hit-file', m[1])); lastFile = m[1]; }
    const row = el('div', 'c-hit');
    row.appendChild(el('span', 'c-hit-line', m[2]));
    const body = el('span');
    // La coincidencia se marca creando nodos, nunca con innerHTML: el patron
    // viene del modelo y la linea del disco.
    const hit = re && m[3].match(re);
    if (hit && hit[0]) {
      const at = m[3].indexOf(hit[0]);
      body.append(document.createTextNode(m[3].slice(0, at)), el('mark', null, hit[0]), document.createTextNode(m[3].slice(at + hit[0].length)));
    } else {
      body.textContent = m[3];
    }
    row.appendChild(body);
    box.appendChild(row);
  }
  return box;
}

function grepSpec(item) {
  const input = item.input || {};
  const text = outputText(item) || '';
  const lines = text.split('\n').filter(Boolean);
  const files = new Set();
  for (const l of lines) { const m = l.match(HIT_RE); if (m) files.add(m[1]); }
  const chips = lines.length
    ? [{ text: files.size ? `${lines.length} en ${files.size} archivos` : `${lines.length} líneas` }]
    : [];
  return {
    label: 'Grep', summary: `"${input.pattern || ''}"` + (input.path ? ' en ' + input.path : ''), chips,
    buildBody: () => (lines.length ? renderHits(text, input.pattern) : outputBlock(item)),
  };
}

function globSpec(item) {
  const input = item.input || {};
  const text = outputText(item) || '';
  const paths = text.split('\n').filter(Boolean);
  return {
    label: 'Glob', summary: input.pattern || '',
    chips: paths.length ? [{ text: `${paths.length} archivos` }] : [],
    buildBody: () => {
      const box = el('div', 'c-hits');
      for (const p of paths.slice(0, 200)) {
        const row = el('div', 'c-hit');
        const dir = p.slice(0, p.length - basename(p).length);
        row.append(el('span', null, basename(p)), el('span', 'c-hit-line', dir));
        box.appendChild(row);
      }
      if (paths.length > 200) box.appendChild(el('div', 'c-pending', `… y ${paths.length - 200} más`));
      return box;
    },
  };
}

// === Generico y MCP ===

function genericSpec(item) {
  const name = item.name || '(desconocida)';
  const mcp = name.startsWith('mcp__') ? name.split('__') : null;
  const input = item.input || {};
  const keys = Object.keys(input);
  const summary = keys.length
    ? keys.slice(0, 2).map((k) => `${k}=${String(JSON.stringify(input[k])).slice(0, 24)}`).join(' ')
    : '';
  return {
    label: mcp ? mcp[2] || name : name,
    summary: mcp ? mcp[1] + ' · ' + summary : summary,
    chips: mcp ? [{ text: 'mcp', tone: 'info' }] : [],
    buildBody: () => {
      const frag = document.createDocumentFragment();
      const inp = inputBlock(input, name);
      if (inp) frag.appendChild(inp);
      frag.appendChild(outputBlock(item));
      return frag;
    },
  };
}

const CORE = {
  Read: readSpec, Write: writeSpec, Edit: editSpec, MultiEdit: editSpec,
  Bash: bashSpec, BashOutput: bashSpec, Grep: grepSpec, Glob: globSpec,
};

// Spec completa de una card de herramienta.
export function toolSpec(item) {
  const build = CORE[item.name] || extraSpec(item.name);
  const spec = build ? build(item) : genericSpec(item);
  return {
    icon: TOOL_ICON[item.name] || '\u{1F6E0}\u{FE0F}',
    status: statusIcon(item),
    cls: 'c-card-' + (item.status || 'done') + (item.sidechain ? ' c-card--sub' : ''),
    ...spec,
  };
}

export { outputText, outputBlock, inputBlock };
