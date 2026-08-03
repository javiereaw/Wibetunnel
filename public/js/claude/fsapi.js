// Cliente HTTP de los endpoints /fs/* . Normaliza errores de red y de HTTP a
// la misma forma, para que quien llame no tenga que distinguir "no hay
// conexion" de "el servidor dijo 412".
import { state } from '../state.js';

function authHeaders() {
  return { Authorization: 'Bearer ' + state.savedToken };
}

export function downloadUrl(fullPath) {
  return '/fs/download?path=' + encodeURIComponent(fullPath);
}

async function parse(res) {
  let body;
  try { body = await res.json(); } catch (_) { body = null; } // 204 o cuerpo no-JSON
  if (res.ok) return { ok: true, data: body };
  return {
    ok: false,
    status: res.status,
    error: (body && body.error) || 'error ' + res.status,
    meta: body || {},
  };
}

export async function readFile(fullPath) {
  try {
    const res = await fetch('/fs/file?path=' + encodeURIComponent(fullPath), {
      headers: authHeaders(), cache: 'no-store',
    });
    return await parse(res);
  } catch (_) {
    return { ok: false, status: 0, error: 'sin conexión', meta: {} };
  }
}

// etag es obligatorio: el servidor rechaza un PUT sin If-Match (428). Para
// "sobrescribir de todos modos" hay que releer primero y reenviar con el etag
// fresco, nunca saltarse la precondicion.
export async function writeFile(fullPath, { content, eol, bom, etag }) {
  const qs = new URLSearchParams({ path: fullPath, eol: eol || 'lf', bom: bom ? '1' : '0' });
  try {
    const res = await fetch('/fs/file?' + qs.toString(), {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'text/plain; charset=utf-8', 'If-Match': `"${etag}"` },
      body: content,
    });
    return await parse(res);
  } catch (_) {
    return { ok: false, status: 0, error: 'sin conexión', meta: {} };
  }
}
