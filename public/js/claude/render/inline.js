// Pase inline del markdown: codigo, enfasis, tachado, enlaces y referencias a
// ficheros. Opera SIEMPRE sobre texto ya escapado (ver md.js), asi que ningun
// `<` del contenido original sobrevive hasta aqui: las unicas etiquetas que
// salen son las que emitimos nosotros.

// Marcadores de aparcado: caracteres de control que escapeHtml nunca produce,
// asi que no pueden colisionar con prosa real.
const OPEN = '\x01';
const CLOSE = '\x02';
const MARK_RE = new RegExp(OPEN + '(\\d+)' + CLOSE, 'g');

export function park(store, html) {
  store.push(html);
  return OPEN + (store.length - 1) + CLOSE;
}

// El contenido aparcado puede contener a su vez marcadores (una etiqueta de
// enlace con codigo inline dentro), de ahi el bucle.
export function unpark(store, text) {
  let out = text;
  for (let pass = 0; pass < 5 && MARK_RE.test(out); pass++) {
    MARK_RE.lastIndex = 0;
    out = out.replace(MARK_RE, (m, i) => (store[Number(i)] !== undefined ? store[Number(i)] : m));
  }
  return out;
}

// Solo http(s) y mailto. Nunca javascript: ni data:, ni esquemas relativos que
// el navegador pueda reinterpretar.
const SAFE_SCHEME = /^(https?:\/\/|mailto:)/i;

function safeLink(store, url, label) {
  const clean = String(url).trim().replace(/&amp;/g, '&amp;');
  if (!SAFE_SCHEME.test(clean.replace(/&amp;/g, '&'))) return null;
  return park(store, `<a href="${clean}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`);
}

// Rutas tipo src/app.js o lib/x.js:123 — se marcan como referencia clicable.
// Sin href: las abre el editor por delegacion de eventos en #c-chat-log, asi
// que si el editor no esta montado el click simplemente no hace nada.
const FILE_REF = /(^|[\s(`'"])((?:[\w.@~-]+\/)+[\w.-]+\.[A-Za-z][\w]{0,7})(?::(\d+))?(?=$|[\s),.;:'"`])/g;

export function inlineMd(src, store) {
  let t = String(src);

  // 1. Codigo inline PRIMERO: dentro de backticks, ** y * son literales.
  t = t.replace(/`([^`\n]+)`/g, (_, code) => park(store, `<code class="c-md-inline">${code}</code>`));

  // 2. Enlaces explicitos, aparcados para que el autolink no los vuelva a tocar.
  t = t.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, label, url) => safeLink(store, url, label) || m);

  // 3. Enfasis.
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // 4. URLs sueltas.
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => {
    const trailing = url.match(/[.,;:)]+$/);
    const clean = trailing ? url.slice(0, -trailing[0].length) : url;
    const link = safeLink(store, clean, clean);
    return link ? pre + link + (trailing ? trailing[0] : '') : m;
  });

  // 5. Referencias a fichero.
  t = t.replace(FILE_REF, (m, pre, path, line) => {
    const attrs = `class="c-ref" data-path="${path}"` + (line ? ` data-line="${line}"` : '');
    return pre + park(store, `<a ${attrs}>${path}${line ? ':' + line : ''}</a>`);
  });

  return t;
}
