// Markdown minimo y seguro para el texto de Claude (que puede contener codigo
// y salida de shell arbitraria: la superficie de XSS obvia de esta vista).
// Regla dura: TODO se escapa primero; las etiquetas que introducimos despues
// son siempre las nuestras, nunca las del contenido original.

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

// Marcador de bloque de codigo: caracteres de control (\x01..\x02) que jamas
// sobreviven a escapeHtml, asi que nunca pueden colisionar con prosa real del
// usuario (a diferencia de un marcador en texto plano tipo " B0 ").
const MARK_OPEN = '\x01';
const MARK_CLOSE = '\x02';
const MARK_RE = new RegExp(MARK_OPEN + '(\\d+)' + MARK_CLOSE, 'g');

// Subconjunto: bloques ```, codigo inline `, **negrita**, *cursiva*, enlaces
// [texto](http...) — solo esquemas http/https, nunca javascript:/data:.
export function renderMarkdown(src) {
  if (!src) return '';
  let text = escapeHtml(src);

  const blocks = [];
  text = text.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre class="c-md-code"><code>${code}</code></pre>`);
    return `${MARK_OPEN}${blocks.length - 1}${MARK_CLOSE}`;
  });

  text = text.replace(/`([^`\n]+)`/g, '<code class="c-md-inline">$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  text = text.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
  text = text.replace(MARK_RE, (_, i) => blocks[Number(i)]);
  return text;
}
