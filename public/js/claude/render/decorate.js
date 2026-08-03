// Post-pase sobre un contenedor ya rellenado con el HTML de renderMarkdown:
// resalta los bloques de codigo, les pone cabecera con lenguaje y boton de
// copiar, y pliega los muy largos.
//
// El resaltado se hace AQUI y no en md.js a proposito: el navegador ya
// desescapo el texto al parsear el HTML, asi que el tokenizador ve el codigo
// original. Tokenizar sobre el string escapado veria "&lt;" como tres tokens.
import { el } from './dom.js';
import { highlight, guessLang } from './hl.js';

const FOLD_LINES = 25;   // por encima de esto se pliega
const FOLD_TO = '15em';  // altura visible al plegar (coincide con claude-chat.css)

export function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = 'copiado';
    setTimeout(() => { btn.textContent = prev; }, 1200);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    return;
  }
  fallbackCopy(text, done);
}

// Contextos no seguros (LAN por http): clipboard API no existe.
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (_) { /* sin portapapeles */ }
  ta.remove();
}

function decorateCodeBlock(pre) {
  const code = pre.querySelector('code');
  if (!code) return;
  const raw = code.textContent;
  const lang = guessLang(pre.dataset.lang);

  if (lang) code.replaceChildren(highlight(raw, lang));

  const box = el('div', 'c-code');
  const head = el('div', 'c-code-head');
  head.appendChild(el('span', 'c-code-lang', pre.dataset.lang || lang || 'texto'));
  const copy = el('button', 'c-code-copy', 'copiar');
  copy.type = 'button';
  copy.addEventListener('click', (e) => { e.stopPropagation(); copyText(raw, copy); });
  head.appendChild(copy);

  pre.replaceWith(box);
  box.append(head, pre);

  const lines = raw.split('\n').length;
  if (lines > FOLD_LINES) {
    box.classList.add('c-code--folded');
    pre.style.maxHeight = FOLD_TO;
    const more = el('button', 'c-code-more', `Mostrar las ${lines} líneas`);
    more.type = 'button';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      box.classList.remove('c-code--folded');
      pre.style.maxHeight = '';
      more.remove();
    });
    box.appendChild(more);
  }
}

// Idempotente: un contenedor ya decorado no vuelve a procesarse (los bloques
// tratados quedan dentro de .c-code).
export function decorate(container) {
  if (!container) return container;
  for (const pre of container.querySelectorAll('pre.c-md-code')) {
    if (pre.parentElement && pre.parentElement.classList.contains('c-code')) continue;
    decorateCodeBlock(pre);
  }
  return container;
}

// Atajo: crea el nodo de prosa a partir de markdown y lo decora.
export function prose(markdownHtml, cls) {
  const box = el('div', cls || 'c-bubble');
  box.innerHTML = markdownHtml;
  return decorate(box);
}
