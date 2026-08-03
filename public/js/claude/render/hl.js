// Resaltado de sintaxis: escaner generico parametrizado por tabla, 0 KB de
// vendor.
//
// Por que propio: en 360px las clases de token que aportan algo son seis
// (cadena, comentario, numero, palabra clave, llamada, puntuacion) y un escaner
// parametrizado las clava en la practica totalidad de los casos. highlight.js
// "common" son ~120 KB; Prism core + 7 lenguajes ~24 KB pero anade un global
// UMD, una entrada en scripts/vendor.js, otra en el PRECACHE del SW y deriva de
// versiones.
//
// Invariante de seguridad: highlight() recibe TEXTO CRUDO y devuelve NODOS DOM
// (createTextNode + span). Nunca ve ni produce HTML, asi que no puede reabrir
// una via de XSS ni pelearse con &lt;/&amp; ya escapados — el error clasico de
// tokenizar sobre HTML.
//
// Escape hatch: si algun lenguaje se resalta visiblemente mal, Prism entra
// detras de ESTA MISMA firma tocando tres archivos (este, claude.html y
// scripts/vendor.js). Nada mas depende de como esta implementado.
import { el } from './dom.js';

const KW = {
  clike: 'abstract async await break case catch class const continue debugger default delete do else enum export extends false final finally for from function get goto if implements import in instanceof interface let new null of package private protected public return set static super switch this throw throws true try typeof var void while with yield struct impl fn mut pub use match trait where unsafe defer go range chan select type nil func var package',
  sh: 'if then elif else fi for while do done case esac function return local export readonly declare source alias unset shift trap set unalias echo cd exit break continue in',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self',
  sql: 'select from where insert update delete create drop alter table index view join left right inner outer on group by order having limit offset values set into as and or not null distinct union all primary key foreign references default',
  json: 'true false null',
  yaml: 'true false null yes no on off',
};

const SPECS = {
  clike: { line: ['//'], block: ['/*', '*/'], strings: '"\'`', kw: KW.clike, num: true },
  sh: { line: ['#'], strings: '"\'', kw: KW.sh, num: true },
  py: { line: ['#'], strings: '"\'', triple: true, kw: KW.py, num: true },
  json: { strings: '"', kw: KW.json, num: true },
  css: { block: ['/*', '*/'], strings: '"\'', kw: '', num: true },
  sql: { line: ['--'], block: ['/*', '*/'], strings: '\'"', kw: KW.sql, num: true, ci: true },
  yaml: { line: ['#'], strings: '"\'', kw: KW.yaml, num: true },
};

const ALIASES = {
  js: 'clike', javascript: 'clike', jsx: 'clike', ts: 'clike', typescript: 'clike', tsx: 'clike',
  mjs: 'clike', cjs: 'clike', java: 'clike', c: 'clike', h: 'clike', cpp: 'clike', cc: 'clike',
  cs: 'clike', go: 'clike', rs: 'clike', rust: 'clike', php: 'clike', swift: 'clike', kt: 'clike',
  scala: 'clike', dart: 'clike', groovy: 'clike',
  sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', fish: 'sh', ksh: 'sh',
  py: 'py', python: 'py', python3: 'py',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  sql: 'sql', psql: 'sql', mysql: 'sql',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml', ini: 'yaml', conf: 'yaml', env: 'yaml',
};

// Un lenguaje que no esta en la tabla se pinta SIN color a proposito: mejor sin
// resaltado que con resaltado incorrecto.
export function guessLang(hint) {
  if (!hint) return null;
  const raw = String(hint).toLowerCase();
  const ext = raw.includes('.') ? raw.split('.').pop() : raw;
  return ALIASES[ext] || ALIASES[raw] || (SPECS[raw] ? raw : null);
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[A-Za-z0-9_$]/;

export function highlight(code, lang) {
  const frag = document.createDocumentFragment();
  const spec = SPECS[guessLang(lang) || lang] || null;
  const src = String(code == null ? '' : code);
  if (!spec) { frag.appendChild(document.createTextNode(src)); return frag; }

  const kw = new Set((spec.kw || '').split(/\s+/).filter(Boolean));
  let plain = '';
  const flushPlain = () => { if (plain) { frag.appendChild(document.createTextNode(plain)); plain = ''; } };
  const push = (cls, text) => { flushPlain(); frag.appendChild(el('span', cls, text)); };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];

    // Comentario de bloque
    if (spec.block && src.startsWith(spec.block[0], i)) {
      const end = src.indexOf(spec.block[1], i + spec.block[0].length);
      const stop = end < 0 ? n : end + spec.block[1].length;
      push('hl-com', src.slice(i, stop)); i = stop; continue;
    }
    // Comentario de linea
    let lineTok = null;
    for (const tok of spec.line || []) if (src.startsWith(tok, i)) { lineTok = tok; break; }
    if (lineTok) {
      const nl = src.indexOf('\n', i);
      const stop = nl < 0 ? n : nl;
      push('hl-com', src.slice(i, stop)); i = stop; continue;
    }
    // Cadena (con triples de Python y escapes)
    if (spec.strings && spec.strings.includes(ch)) {
      const triple = spec.triple && src.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      let j = i + quote.length;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src.startsWith(quote, j)) { j += quote.length; break; }
        if (!triple && src[j] === '\n') break; // cadena sin cerrar: no comerse el resto
        j++;
      }
      push('hl-str', src.slice(i, Math.min(j, n))); i = Math.min(j, n); continue;
    }
    // Numero
    if (spec.num && /[0-9]/.test(ch) && !(i > 0 && IDENT.test(src[i - 1]))) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoObB_.]/.test(src[j])) j++;
      push('hl-num', src.slice(i, j)); i = j; continue;
    }
    // Identificador: palabra clave, llamada a funcion, o texto plano
    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < n && IDENT.test(src[j])) j++;
      const word = src.slice(i, j);
      const probe = spec.ci ? word.toLowerCase() : word;
      if (kw.has(probe)) push('hl-kw', word);
      else if (src[j] === '(') push('hl-fn', word);
      else plain += word;
      i = j; continue;
    }
    // Puntuacion
    if (/[{}[\]().,;:=<>!&|+\-*/%?]/.test(ch)) { push('hl-punct', ch); i++; continue; }

    plain += ch; i++;
  }
  flushPlain();
  return frag;
}
