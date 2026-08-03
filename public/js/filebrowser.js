import { state, active, isMobile } from './state.js';
import { showToast } from './ui.js';
import { quotePathForShell, buildCdCmd } from './shell-quote.js';

const fbEl = document.getElementById('filebrowser');
const fbPathEl = document.getElementById('fb-path');
const fbListEl = document.getElementById('fb-list');
let fbCurrentPath = '';

function authHeaders() {
  return { Authorization: 'Bearer ' + state.savedToken };
}

function downloadFile(fullPath, name) {
  showToast('Descargando ' + name + '...');
  fetch('/fs/download?path=' + encodeURIComponent(fullPath), { headers: authHeaders() })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    })
    .catch(() => showToast('No se pudo descargar ' + name));
}

async function uploadFile(file) {
  showToast('Subiendo ' + file.name + '...');
  try {
    const res = await fetch(
      '/fs/upload?dir=' + encodeURIComponent(fbCurrentPath) + '&name=' + encodeURIComponent(file.name),
      { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' }, body: file }
    );
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
    showToast('Subido: ' + file.name);
    openFileBrowser(fbCurrentPath); // refrescar listado
  } catch (err) {
    showToast('Error al subir: ' + (err.message || ''));
  }
}

document.getElementById('fb-upload').addEventListener('click', () => {
  document.getElementById('fb-file').click();
});
document.getElementById('fb-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) uploadFile(f);
});

export function openFileBrowser(dirPath) {
  if (!state.socket || !state.socket.connected) return;
  state.socket.emit('fs:list', dirPath || '', (res) => {
    if (res.error) {
      // Error visible en el propio panel en vez de fallo silencioso
      fbPathEl.textContent = res.path || fbCurrentPath || '';
      fbListEl.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'fb-error';
      li.textContent = res.error;
      fbListEl.appendChild(li);
      fbEl.style.display = 'flex';
      return;
    }
    fbCurrentPath = res.path;
    fbPathEl.textContent = res.path;
    fbListEl.innerHTML = '';

    const parentLi = document.createElement('li');
    parentLi.innerHTML = '<span class="fb-icon">..</span><span>Subir</span>';
    parentLi.addEventListener('click', () => {
      const parent = fbCurrentPath.replace(/[\\/][^\\/]+$/, '') || fbCurrentPath;
      openFileBrowser(parent);
    });
    fbListEl.appendChild(parentLi);

    res.items.forEach(item => {
      const li = document.createElement('li');
      const fullPath = item.fullPath;
      if (item.isDir) {
        const icon = document.createElement('span');
        icon.className = 'fb-icon';
        icon.textContent = '\u{1F4C1}';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = item.name;
        const selBtn = document.createElement('button');
        selBtn.className = 'fb-select';
        selBtn.textContent = 'Sel';
        li.append(icon, nameSpan, selBtn);
        li.addEventListener('click', (e) => {
          if (e.target.classList.contains('fb-select')) return;
          openFileBrowser(fullPath);
        });
        selBtn.addEventListener('click', () => {
          const as = active();
          if (state.socket && state.socket.connected && as && as.persistentId) {
            state.socket.emit('input', { id: as.persistentId, data: buildCdCmd(fullPath, state.shellType) });
          }
          closeFileBrowser();
        });
      } else {
        const icon = document.createElement('span');
        icon.className = 'fb-icon';
        icon.textContent = '\u{1F4C4}';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = item.name;
        const dlBtn = document.createElement('button');
        dlBtn.className = 'fb-select';
        dlBtn.title = 'Descargar';
        dlBtn.textContent = '⤓';
        li.append(icon, nameSpan, dlBtn);
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          downloadFile(fullPath, item.name);
        });
        li.addEventListener('click', () => {
          const as = active();
          if (state.socket && state.socket.connected && as && as.persistentId) {
            state.socket.emit('input', { id: as.persistentId, data: quotePathForShell(fullPath, state.shellType) });
          }
          closeFileBrowser();
        });
      }
      fbListEl.appendChild(li);
    });

    fbEl.style.display = 'flex';
  });
}

export function closeFileBrowser() {
  fbEl.style.display = 'none';
  const s = active();
  if (s && !isMobile) s.term.focus();
}

fbEl.addEventListener('click', (e) => { if (e.target === fbEl) closeFileBrowser(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && fbEl.style.display === 'flex') closeFileBrowser(); });
document.getElementById('btn-files').addEventListener('click', () => openFileBrowser(''));
