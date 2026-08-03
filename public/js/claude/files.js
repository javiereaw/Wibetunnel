// Explorador de carpetas de /claude. Dos modos:
//
//   browse — navegar y hacer `cd` en la sesion activa (lo mismo que hace el
//            explorador de "/", para que la memoria muscular transfiera)
//   pick   — elegir la carpeta donde arrancar una sesion NUEVA
//
// Divergencia deliberada respecto de "/": alli un tap en un archivo inserta su
// ruta en el terminal porque no hay editor; aqui el editor es la funcion
// estrella, asi que se lleva el gesto primario y la insercion pasa a un boton.
import { el, basename } from './render/dom.js';
import { downloadUrl } from './fsapi.js';
import * as net from './net.js';

const overlay = document.getElementById('c-files');
const pathEl = document.getElementById('cf-path');
const listEl = document.getElementById('cf-list');
const useBtn = document.getElementById('cf-use');
const defaultBtn = document.getElementById('cf-default');
const upBtn = document.getElementById('cf-up');

let cbs = {};
let mode = 'browse';
let currentPath = '';
let parentPath = null;
// Raiz del jail: la aprende el primer listado con ruta vacia, que es lo que
// devuelve el servidor como CWD. Sin esto el boton "subir" ofreceria salir del
// jail y el servidor respondería denegado, que es una via muerta fea.
let rootPath = null;

export function currentDir() { return currentPath; }
export function isFilesOpen() { return overlay.style.display === 'flex'; }

// "…/proyectos/wibe": el breadcrumb completo no cabe en 360px y lo unico que
// se necesita saber es donde estas, no como llegaste.
function crumb(p) {
  const parts = String(p || '').split(/[/\\]/).filter(Boolean);
  return parts.length <= 3 ? '/' + parts.join('/') : '…/' + parts.slice(-3).join('/');
}

function rowFolder(item) {
  const li = el('li', 'cf-row cf-row--dir');
  li.append(el('span', 'cf-icon', '\u{1F4C1}'), el('span', 'cf-name', item.name));

  const pill = el('button', 'cf-pill', mode === 'pick' ? 'Usar' : 'cd');
  pill.type = 'button';
  // Sin sesion activa el `cd` no tiene destino: se oculta en vez de quedar en
  // gris, que solo anade ruido.
  if (mode === 'browse' && !cbs.hasSession()) pill.style.display = 'none';
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    if (mode === 'pick') cbs.onPickCwd(item.fullPath);
    else cbs.onCd(item.fullPath);
    closeFiles();
  });
  li.appendChild(pill);
  li.addEventListener('click', () => openFiles({ mode, startPath: item.fullPath }));
  return li;
}

function rowFile(item) {
  const li = el('li', 'cf-row');
  li.append(el('span', 'cf-icon', '\u{1F4C4}'), el('span', 'cf-name', item.name));

  const insert = el('button', 'cf-icon-btn', '\u{21A9}');
  insert.type = 'button';
  insert.title = 'Insertar la ruta en el mensaje';
  insert.addEventListener('click', (e) => { e.stopPropagation(); cbs.onInsertPath(item.fullPath); closeFiles(); });

  const dl = el('a', 'cf-icon-btn', '\u{2913}');
  dl.title = 'Descargar';
  dl.href = downloadUrl(item.fullPath);
  dl.addEventListener('click', (e) => e.stopPropagation());

  li.append(insert, dl);
  // No se filtra por extension: adivinar que es editable mentiria (.env,
  // Makefile y .gitignore no tienen extension util, y un .txt puede ser
  // basura binaria). Se intenta abrir y el servidor decide.
  li.addEventListener('click', () => cbs.onOpenFile(item.fullPath, item.name));
  return li;
}

export function openFiles(opts = {}) {
  // Si se abre directamente en una carpeta guardada (modo pick) todavia no se
  // conoce la raiz del jail: se resuelve antes con un listado vacio.
  if (rootPath === null && opts.startPath) {
    net.listDir('', (res) => {
      if (res && !res.error) rootPath = res.path;
      doOpen(opts);
    });
    return;
  }
  doOpen(opts);
}

function doOpen({ mode: nextMode = 'browse', startPath = '' } = {}) {
  mode = nextMode;
  overlay.style.display = 'flex';
  overlay.classList.toggle('cf-mode-pick', mode === 'pick');
  listEl.replaceChildren(el('li', 'cf-empty', 'Cargando…'));

  net.listDir(startPath, (res) => {
    if (!res || res.error) {
      listEl.replaceChildren(el('li', 'cf-empty', (res && res.error) || 'No se pudo listar'));
      return;
    }
    currentPath = res.path || '';
    if (!startPath) rootPath = currentPath;
    pathEl.textContent = crumb(currentPath);
    pathEl.title = currentPath;

    const parts = currentPath.split(/[/\\]/);
    const atRoot = rootPath !== null && currentPath === rootPath;
    parentPath = (!atRoot && parts.length > 1) ? parts.slice(0, -1).join('/') : null;
    upBtn.style.visibility = parentPath ? 'visible' : 'hidden';

    if (!res.items.length) {
      listEl.replaceChildren(el('li', 'cf-empty', 'Carpeta vacía'));
      return;
    }
    listEl.replaceChildren(...res.items.map((it) => (it.isDir ? rowFolder(it) : rowFile(it))));
  });
}

export function closeFiles() { overlay.style.display = 'none'; }

export function initFiles(handlers) {
  cbs = handlers;

  upBtn.addEventListener('click', () => { if (parentPath !== null) openFiles({ mode, startPath: parentPath }); });
  overlay.querySelector('.cf-close').addEventListener('click', closeFiles);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFiles(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isFilesOpen()) closeFiles(); });

  // En modo pick: usar la carpeta en la que estas ahora mismo (dos taps desde
  // el "+" para crear una sesion donde quieras).
  useBtn.addEventListener('click', () => { cbs.onPickCwd(currentPath); closeFiles(); });
  defaultBtn.addEventListener('click', () => { cbs.onPickCwd(null); closeFiles(); });

  document.getElementById('c-btn-files').addEventListener('click', () => {
    openFiles({ mode: 'browse', startPath: currentPath });
  });
}

export { basename };
