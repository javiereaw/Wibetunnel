import { state } from './state.js';

const THEMES = ['dark', 'light', 'auto'];
const THEME_ICONS = { dark: '\u{1F319}', light: '\u{2600}\u{FE0F}', auto: '\u{1F4BB}' };

export let currentThemeMode = localStorage.getItem('wibe-theme') || 'dark';
export function setThemeMode(mode) { currentThemeMode = mode; }

export function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(mode) {
  const resolved = mode === 'auto' ? getSystemTheme() : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  document.getElementById('theme-toggle').textContent = THEME_ICONS[mode];
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim();
  const fg = getComputedStyle(document.documentElement).getPropertyValue('--term-fg').trim();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  state.sessions.forEach(s => { s.term.options.theme = { background: bg, foreground: fg, cursor: accent }; });
}

export function initTheme() {
  applyTheme(currentThemeMode);

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const idx = THEMES.indexOf(currentThemeMode);
    currentThemeMode = THEMES[(idx + 1) % THEMES.length];
    try { localStorage.setItem('wibe-theme', currentThemeMode); } catch (_) {}
    applyTheme(currentThemeMode);
  });

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (currentThemeMode === 'auto') applyTheme('auto');
  });
}
