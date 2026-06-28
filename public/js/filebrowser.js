import { state, active, isMobile } from './state.js';

const fbEl = document.getElementById('filebrowser');
const fbPathEl = document.getElementById('fb-path');
const fbListEl = document.getElementById('fb-list');
let fbCurrentPath = '';

export function openFileBrowser(dirPath) {
  if (!state.socket || !state.socket.connected) return;
  state.socket.emit('fs:list', dirPath || '', (res) => {
    if (res.error) return;
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
            state.socket.emit('input', { id: as.persistentId, data: buildCdCmd(fullPath) });
          }
          closeFileBrowser();
        });
      } else {
        const icon = document.createElement('span');
        icon.className = 'fb-icon';
        icon.textContent = '\u{1F4C4}';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = item.name;
        li.append(icon, nameSpan);
        li.addEventListener('click', () => {
          const as = active();
          if (state.socket && state.socket.connected && as && as.persistentId) {
            state.socket.emit('input', { id: as.persistentId, data: quotePathForShell(fullPath) });
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

function quotePathForShell(p) {
  if (state.shellType === 'powershell') {
    return "'" + p.replace(/'/g, "''") + "'";
  }
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

function buildCdCmd(p) {
  return 'cd ' + quotePathForShell(p) + '\r';
}

fbEl.addEventListener('click', (e) => { if (e.target === fbEl) closeFileBrowser(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && fbEl.style.display === 'flex') closeFileBrowser(); });
document.getElementById('btn-files').addEventListener('click', () => openFileBrowser(''));
