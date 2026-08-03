// Unit tests del markdown de la vista /claude (render/md.js + render/inline.js).
// Son funciones puras de string, sin DOM, asi que se pueden probar en node.
//
// La mitad de este fichero es la lista de comprobacion de XSS: este modulo es
// la unica superficie de la vista donde entra HTML, y el texto que procesa
// incluye salida de shell arbitraria.
const { test, before } = require('node:test');
const assert = require('node:assert');

let renderMarkdown, escapeHtml;
before(async () => {
  const md = await import('../../public/js/claude/render/md.js');
  renderMarkdown = md.renderMarkdown;
  escapeHtml = md.escapeHtml;
});

// === Seguridad ===

test('XSS: el HTML del contenido nunca sobrevive como markup', () => {
  const out = renderMarkdown('<img src=x onerror="alert(1)"> y <script>alert(2)</script>');
  assert.ok(!out.includes('<img'), 'no debe emitir <img>');
  assert.ok(!out.includes('<script'), 'no debe emitir <script>');
  assert.ok(out.includes('&lt;img'), 'debe quedar escapado y visible');
  // Se inspeccionan solo las etiquetas REALES del resultado: lo que quedo
  // escapado es texto inerte y puede contener la palabra "onerror" sin riesgo.
  for (const tag of out.match(/<[a-z][^>]*>/gi) || []) {
    assert.ok(!/\son\w+\s*=/i.test(tag), `manejador de evento en una etiqueta emitida: ${tag}`);
  }
});

test('XSS: los enlaces solo aceptan http(s) y mailto', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x', 'vbscript:x', 'file:///etc/passwd']) {
    const out = renderMarkdown(`[pincha](${bad})`);
    assert.ok(!out.includes('<a '), `no debe crear enlace para ${bad}: ${out}`);
  }
  const good = renderMarkdown('[ok](https://ejemplo.dev/a?b=1&c=2)');
  assert.ok(good.includes('href="https://ejemplo.dev/a?b=1&amp;c=2"'));
  assert.ok(good.includes('rel="noopener noreferrer nofollow"'));
  assert.ok(renderMarkdown('[correo](mailto:a@b.c)').includes('<a '));
});

test('XSS: no se puede cerrar un atributo desde el contenido', () => {
  const out = renderMarkdown('[x](https://a.dev/" onmouseover="alert(1))');
  assert.ok(!out.includes('onmouseover="alert'), out);
});

test('escapeHtml: round-trip de entidades sin doble escapado visible', () => {
  const out = renderMarkdown('usa `a < b && c > d` en el codigo');
  assert.ok(out.includes('a &lt; b &amp;&amp; c &gt; d'), out);
  assert.strictEqual(escapeHtml('&'), '&amp;');
});

// === Correccion del subconjunto ===

test('el codigo inline protege sus asteriscos de la negrita', () => {
  const out = renderMarkdown('el patron `a**b**c` es literal, pero **esto** no');
  assert.ok(out.includes('<code class="c-md-inline">a**b**c</code>'), out);
  assert.ok(out.includes('<strong>esto</strong>'), out);
});

test('bloque cercado: conserva el lenguaje y el contenido intacto', () => {
  const out = renderMarkdown('```js\nconst x = 1;\nif (a < b) {}\n```');
  assert.ok(out.includes('data-lang="js"'), out);
  assert.ok(out.includes('const x = 1;\nif (a &lt; b) {}'), out);
  assert.ok(!out.includes('<p>'), 'un bloque de codigo no se envuelve en parrafo');
});

test('un bloque cercado sin cerrar se pinta igualmente', () => {
  const out = renderMarkdown('```\nsin cerrar');
  assert.ok(out.includes('<pre class="c-md-code"'), out);
  assert.ok(out.includes('sin cerrar'), out);
});

test('titulos, hr y cita', () => {
  assert.ok(renderMarkdown('## Titulo').includes('<h2>Titulo</h2>'));
  assert.ok(renderMarkdown('###### Seis').includes('<h6>Seis</h6>'));
  assert.ok(renderMarkdown('---').includes('<hr>'));
  const q = renderMarkdown('> una cita\n> en dos lineas');
  assert.ok(q.includes('<blockquote>'), q);
  assert.ok(q.includes('una cita'), q);
});

test('listas no ordenadas, ordenadas y anidadas', () => {
  const ul = renderMarkdown('- uno\n- dos');
  assert.ok(ul.includes('<ul><li>uno</li><li>dos</li></ul>'), ul);
  const ol = renderMarkdown('1. uno\n2. dos');
  assert.ok(ol.startsWith('<ol>') && ol.includes('<li>dos</li>'), ol);
  const nested = renderMarkdown('- padre\n  - hijo');
  assert.ok(nested.includes('<li>padre<ul><li>hijo</li></ul></li>'), nested);
});

test('tabla GFM con alineacion', () => {
  const out = renderMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |');
  assert.ok(out.includes('<table>'), out);
  assert.ok(out.includes('<th style="text-align:left">a</th>'), out);
  assert.ok(out.includes('<th style="text-align:right">b</th>'), out);
  assert.ok(out.includes('<td style="text-align:left">1</td>'), out);
});

test('una tabla mal formada se queda en parrafo, no rompe el render', () => {
  const out = renderMarkdown('| a | b |\ntexto normal');
  assert.ok(!out.includes('<table>'), out);
  assert.ok(out.includes('<p>'), out);
});

test('enfasis, tachado y URL suelta', () => {
  assert.ok(renderMarkdown('*it*').includes('<em>it</em>'));
  assert.ok(renderMarkdown('~~no~~').includes('<del>no</del>'));
  const auto = renderMarkdown('mira https://ejemplo.dev/x y ya');
  assert.ok(auto.includes('href="https://ejemplo.dev/x"'), auto);
  // La puntuacion final de la frase no debe entrar en la URL
  const dot = renderMarkdown('en https://ejemplo.dev/x.');
  assert.ok(dot.includes('href="https://ejemplo.dev/x"'), dot);
});

test('un guion bajo dentro de un identificador no crea cursiva', () => {
  const out = renderMarkdown('la variable mi_nombre_largo vale 1');
  assert.ok(!out.includes('<em>'), out);
});

test('referencia a fichero: se marca clicable con ruta y linea', () => {
  const out = renderMarkdown('mira public/js/claude/app.js:120 para el detalle');
  assert.ok(out.includes('class="c-ref"'), out);
  assert.ok(out.includes('data-path="public/js/claude/app.js"'), out);
  assert.ok(out.includes('data-line="120"'), out);
  assert.ok(!out.includes('href='), 'la referencia no lleva href: la abre el editor');
});

test('una referencia dentro de codigo inline no se convierte en enlace', () => {
  const out = renderMarkdown('ejecuta `cat src/app.js:1` ahora');
  assert.ok(!out.includes('c-ref'), out);
});

test('texto vacio o nulo no revienta', () => {
  assert.strictEqual(renderMarkdown(''), '');
  assert.strictEqual(renderMarkdown(null), '');
  assert.strictEqual(renderMarkdown(undefined), '');
});

test('un documento largo con todo mezclado se renderiza entero', () => {
  const src = [
    '# Titulo', '', 'Parrafo con `codigo` y **negrita**.', '',
    '```bash', 'ls -la | grep "x"', '```', '',
    '- item con [enlace](https://a.dev)', '- otro', '',
    '| k | v |', '|---|---|', '| a | 1 |', '',
    '> cita final',
  ].join('\n');
  const out = renderMarkdown(src);
  for (const frag of ['<h1>', '<code class="c-md-inline">', '<strong>', 'data-lang="bash"',
    '<ul>', 'href="https://a.dev"', '<table>', '<blockquote>']) {
    assert.ok(out.includes(frag), `falta ${frag} en:\n${out}`);
  }
});
