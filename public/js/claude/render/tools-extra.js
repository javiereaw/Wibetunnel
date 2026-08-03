// Render de las herramientas que no son de fichero ni de shell: subagentes,
// listas de tareas, web y preguntas. Se separa de tools.js solo por tamano;
// el contrato es el mismo (item -> spec parcial de card).
import { el, cappedBlock, kvTable, isFlatSmall, fmtDuration, fmtTokens, shortModel, basename } from './dom.js';
import { renderMarkdown } from './md.js';
import { prose } from './decorate.js';

function outText(item) {
  if (typeof item.output === 'string' && item.output) return item.output;
  if (item.result && item.result.kind === 'json') return JSON.stringify(item.result.value, null, 2);
  return null;
}

// === Subagentes ===

function agentSpec(item) {
  const input = item.input || {};
  const r = item.result && item.result.kind === 'agent' ? item.result : null;
  const type = (r && r.agentType) || input.subagent_type || 'agente';
  const desc = (r && r.description) || input.description || '';
  const chips = [];
  if (r) {
    if (r.status === 'async_launched') chips.push({ text: 'en marcha', tone: 'info' });
    if (r.resolvedModel) chips.push({ text: shortModel(r.resolvedModel) });
    if (r.totalTokens) chips.push({ text: fmtTokens(r.totalTokens) + ' tok' });
    if (r.totalDurationMs) chips.push({ text: fmtDuration(r.totalDurationMs) });
  }
  return {
    label: type, summary: desc, chips, cls: 'c-card-' + (item.status || 'done') + ' c-card--sub',
    buildBody: () => {
      const frag = document.createDocumentFragment();
      if (input.prompt) {
        frag.appendChild(el('div', 'c-stream-label', 'Encargo'));
        frag.appendChild(prose(renderMarkdown(input.prompt), 'c-bubble'));
      }
      if (r && r.content) {
        frag.appendChild(el('div', 'c-stream-label', 'Informe'));
        frag.appendChild(prose(renderMarkdown(r.content), 'c-bubble'));
      } else {
        const t = outText(item);
        if (t) frag.appendChild(cappedBlock(t, 'c-card-output'));
      }
      if (r && r.outputFile) frag.appendChild(el('div', 'c-note-text', 'Salida: ' + r.outputFile));
      if (r && r.toolStats && typeof r.toolStats === 'object') {
        const stats = Object.entries(r.toolStats).map(([k, v]) => `${k}×${v}`).join('  ');
        if (stats) frag.appendChild(el('div', 'c-note-text', stats));
      }
      return frag;
    },
  };
}

// === Listas de tareas ===

// El circulo lo dibuja el CSS (.c-todo-mark); aqui solo va el estado accesible.
const MARK_CLS = { completed: 'c-todo--done', in_progress: 'c-todo--doing', pending: '' };
const MARK_LABEL = { completed: 'hecha', in_progress: 'en curso', pending: 'pendiente' };

function normalizeTodos(list) {
  return (Array.isArray(list) ? list : []).map((t) => ({
    text: (t && (t.content || t.subject || t.text)) || '',
    active: (t && t.activeForm) || '',
    status: (t && t.status) || 'pending',
    id: (t && t.id) != null ? String(t.id) : null,
  }));
}

function renderTodoList(todos, prev) {
  const prevById = new Map(normalizeTodos(prev).map((t) => [t.id || t.text, t.status]));
  const ul = el('ul', 'c-todo');
  for (const t of todos) {
    const li = el('li', MARK_CLS[t.status] || '');
    const before = prevById.get(t.id || t.text);
    if (before !== undefined && before !== t.status) li.classList.add('c-todo--changed');
    const mark = el('span', 'c-todo-mark');
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', MARK_LABEL[t.status] || MARK_LABEL.pending);
    li.append(mark, el('span', null, t.status === 'in_progress' && t.active ? t.active : t.text));
    ul.appendChild(li);
  }
  return ul;
}

function todoSpec(item) {
  const r = item.result;
  const raw = (r && r.kind === 'todos' && r.todos) || (item.input && item.input.todos) || [];
  const todos = normalizeTodos(raw);
  const done = todos.filter((t) => t.status === 'completed').length;
  const doing = todos.find((t) => t.status === 'in_progress');
  return {
    label: 'Tareas',
    summary: doing ? (doing.active || doing.text) : '',
    cls: 'c-card-' + (item.status || 'done') + ' c-card--todo',
    chips: todos.length ? [{ text: `${done}/${todos.length}`, tone: done === todos.length ? 'ok' : '' }] : [],
    // Las listas de tareas nacen ABIERTAS: el plan vigente es lo que se quiere
    // ver. index.js colapsa las anteriores cuando llega una nueva.
    open: todos.length > 0,
    buildBody: () => (todos.length
      ? renderTodoList(todos, r && r.prev)
      : cappedBlock(outText(item) || '', 'c-card-output')),
  };
}

function taskCreateSpec(item) {
  const r = item.result;
  const task = (r && r.kind === 'task' && r.task) || null;
  const subject = (task && task.subject) || (item.input && item.input.subject) || '';
  return {
    label: 'Tarea', summary: subject,
    chips: task && task.id ? [{ text: '#' + task.id }] : [],
    buildBody: () => (isFlatSmall(item.input) ? kvTable(item.input) : cappedBlock(outText(item) || '', 'c-card-output')),
  };
}

function taskUpdateSpec(item) {
  const r = item.result;
  const ch = (r && r.kind === 'task-update' && r.statusChange) || null;
  return {
    label: 'Tarea', summary: ch ? `#${r.taskId}: ${ch.from} → ${ch.to}` : (item.input && item.input.taskId) || '',
    chips: ch && ch.to === 'completed' ? [{ text: 'hecha', tone: 'ok' }] : [],
    buildBody: () => (isFlatSmall(item.input) ? kvTable(item.input) : cappedBlock(outText(item) || '', 'c-card-output')),
  };
}

// === Web ===

function webFetchSpec(item) {
  const r = item.result && item.result.kind === 'webfetch' ? item.result : null;
  const url = (r && r.url) || (item.input && item.input.url) || '';
  let host = url;
  try { host = new URL(url).host + new URL(url).pathname; } catch (_) { /* url rara: se muestra cruda */ }
  const chips = [];
  if (r && r.code) chips.push({ text: String(r.code), tone: r.code < 300 ? 'ok' : 'err' });
  if (r && r.durationMs) chips.push({ text: fmtDuration(r.durationMs) });
  return {
    label: 'WebFetch', summary: host, chips,
    buildBody: () => {
      const text = (r && r.result) || outText(item) || '';
      return prose(renderMarkdown(text), 'c-bubble');
    },
  };
}

function webSearchSpec(item) {
  const r = item.result && item.result.kind === 'websearch' ? item.result : null;
  const query = (r && r.query) || (item.input && item.input.query) || '';
  const results = r && Array.isArray(r.results) ? r.results : [];
  return {
    label: 'WebSearch', summary: query,
    chips: results.length ? [{ text: `${results.length} resultados` }] : [],
    buildBody: () => {
      if (!results.length) return cappedBlock(outText(item) || '', 'c-card-output');
      const box = el('div', 'c-hits');
      for (const res of results) {
        if (typeof res === 'string') { box.appendChild(el('div', 'c-hit', res)); continue; }
        box.appendChild(el('div', 'c-hit-file', (res && res.title) || (res && res.url) || ''));
        if (res && res.url) box.appendChild(el('div', 'c-hit', res.url));
      }
      return box;
    },
  };
}

function toolSearchSpec(item) {
  const r = item.result && item.result.kind === 'toolsearch' ? item.result : null;
  const matches = (r && r.matches) || [];
  return {
    label: 'ToolSearch', summary: (r && r.query) || (item.input && item.input.query) || '',
    chips: matches.length ? [{ text: `${matches.length}` }] : [],
    buildBody: () => {
      const box = el('div', 'c-hits');
      for (const m of matches) box.appendChild(el('div', 'c-hit', m));
      return box;
    },
  };
}

// === Preguntas y planes ===

function questionsSpec(item) {
  const r = item.result && item.result.kind === 'questions' ? item.result : null;
  const questions = (r && r.questions) || (item.input && item.input.questions) || [];
  const answers = (r && r.answers) || null;
  const first = Array.isArray(questions) && questions[0] ? questions[0].question || questions[0].header : '';
  return {
    label: 'Pregunta', summary: first, open: true,
    buildBody: () => {
      const frag = document.createDocumentFragment();
      for (const q of Array.isArray(questions) ? questions : []) {
        frag.appendChild(el('div', 'c-stream-label', q.header || ''));
        frag.appendChild(el('div', 'c-note-text', q.question || ''));
        const ul = el('ul', 'c-todo');
        const chosen = answers && q.header ? answers[q.header] : null;
        for (const o of q.options || []) {
          const picked = chosen && String(chosen).includes(o.label);
          const li = el('li', picked ? 'c-todo--done' : '');
          li.append(el('span', 'c-todo-mark'), el('span', null, o.label));
          ul.appendChild(li);
        }
        frag.appendChild(ul);
      }
      if (answers && !questions.length) frag.appendChild(kvTable(answers));
      return frag;
    },
  };
}

function planSpec(item) {
  const r = item.result && item.result.kind === 'plan' ? item.result : null;
  const plan = (r && r.plan) || (item.input && item.input.plan) || '';
  const file = (r && r.filePath) || '';
  return {
    label: 'Plan', summary: file ? basename(file) : 'propuesto',
    buildBody: () => prose(renderMarkdown(plan || outText(item) || ''), 'c-bubble'),
  };
}

const EXTRA = {
  Task: agentSpec, Agent: agentSpec,
  TodoWrite: todoSpec, TaskList: todoSpec,
  TaskCreate: taskCreateSpec, TaskUpdate: taskUpdateSpec, TaskGet: taskCreateSpec,
  WebFetch: webFetchSpec, WebSearch: webSearchSpec, ToolSearch: toolSearchSpec,
  AskUserQuestion: questionsSpec, ExitPlanMode: planSpec,
};

export function extraSpec(name) { return EXTRA[name] || null; }
