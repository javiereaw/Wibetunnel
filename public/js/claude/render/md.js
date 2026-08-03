// Markdown: subconjunto propio, cero dependencias.
//
// Por que no una libreria: markdown-it son ~105 KB minificados (el segundo
// asset mas pesado de la pagina despues de xterm) y hay que vendorizarlo,
// registrarlo en scripts/vendor.js y anadirlo al PRECACHE del service worker;
// marked es mas ligero pero deja pasar HTML crudo, asi que necesitaria
// DOMPurify encima. Este subconjunto cubre lo que Claude emite de verdad.
//
// Invariante de seguridad, la misma de siempre: se escapa TODO primero y solo
// se reintroducen etiquetas nuestras. Nada del contenido original puede llegar
// a ser markup.
import { inlineMd, park, unpark } from './inline.js';

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([A-Za-z0-9_+#-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE = /^\s{0,3}&gt;\s?(.*)$/;      // '>' ya viene escapado
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function isBlockStart(line) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line)
    || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line) || !line.trim();
}

function splitRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

// Tabla GFM: cabecera + fila separadora con alineacion.
function readTable(lines, start, store) {
  if (start + 1 >= lines.length) return null;
  if (!lines[start].includes('|') || !TABLE_SEP.test(lines[start + 1])) return null;
  const head = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((c) => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    return r && l ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
  const cell = (tag, text, idx) => {
    const style = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '';
    return `<${tag}${style}>${inlineMd(text, store)}</${tag}>`;
  };
  const thead = '<thead><tr>' + head.map((c, k) => cell('th', c, k)).join('') + '</tr></thead>';
  const tbody = '<tbody>' + rows.map((r) => '<tr>' + r.map((c, k) => cell('td', c, k)).join('') + '</tr>').join('') + '</tbody>';
  return { html: `<table>${thead}${tbody}</table>`, next: i };
}

// Listas con dos niveles de anidado por indentacion (>=2 espacios).
function readList(lines, start, store) {
  const first = lines[start].match(BULLET) || lines[start].match(ORDERED);
  if (!first) return null;
  const ordered = !BULLET.test(lines[start]);
  const baseIndent = first[1].length;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(BULLET) || lines[i].match(ORDERED);
    if (!m) {
      // Continuacion del item anterior (linea suelta indentada)
      if (items.length && lines[i].trim() && lines[i].match(/^\s{2,}/)) {
        items[items.length - 1].text += '\n' + lines[i].trim();
        i++; continue;
      }
      break;
    }
    if (m[1].length > baseIndent) {
      const sub = readList(lines, i, store);
      if (sub && items.length) { items[items.length - 1].sub = sub.html; i = sub.next; continue; }
    }
    if (m[1].length < baseIndent) break;
    items.push({ text: m[3], sub: null });
    i++;
  }
  if (!items.length) return null;
  const tag = ordered ? 'ol' : 'ul';
  const html = `<${tag}>` + items.map((it) => `<li>${inlineMd(it.text, store)}${it.sub || ''}</li>`).join('') + `</${tag}>`;
  return { html, next: i };
}

export function renderMarkdown(src) {
  if (!src) return '';
  const store = [];
  const lines = escapeHtml(src).split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2] || '';
      const body = [];
      i++;
      while (i < lines.length && !new RegExp('^\\s{0,3}' + marker + '{3,}\\s*$').test(lines[i])) { body.push(lines[i]); i++; }
      i++; // cierre (o fin de texto: un bloque sin cerrar se pinta igual)
      const attr = lang ? ` data-lang="${lang}"` : '';
      out.push(park(store, `<pre class="c-md-code"${attr}><code>${body.join('\n')}</code></pre>`));
      continue;
    }

    if (HR.test(line)) { out.push('<hr>'); i++; continue; }

    const h = line.match(HEADING);
    if (h) { const n = h[1].length; out.push(`<h${n}>${inlineMd(h[2], store)}</h${n}>`); i++; continue; }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) { inner.push(lines[i].match(QUOTE)[1]); i++; }
      out.push(`<blockquote>${renderInner(inner.join('\n'), store)}</blockquote>`);
      continue;
    }

    const table = readTable(lines, i, store);
    if (table) { out.push(table.html); i = table.next; continue; }

    const list = readList(lines, i, store);
    if (list) { out.push(list.html); i = list.next; continue; }

    const para = [];
    while (i < lines.length && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
    if (para.length) out.push(`<p>${inlineMd(para.join('\n'), store).replace(/\n/g, '<br>')}</p>`);
    else i++; // linea que abre bloque pero ningun lector la reclamo: no bloquear
  }

  return unpark(store, out.join(''));
}

// Anidado (dentro de blockquote): mismo pipeline pero sin re-escapar ni
// re-desaparcar, porque el texto ya viene escapado y el store es compartido.
function renderInner(escaped, store) {
  const paras = escaped.split(/\n{2,}/).filter((p) => p.trim());
  return paras.map((p) => `<p>${inlineMd(p, store).replace(/\n/g, '<br>')}</p>`).join('');
}
