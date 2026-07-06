// Logger minimo con niveles: WIBE_LOG_LEVEL=debug|info|warn|error (default info).
// Sin timestamps propios: journald/systemd ya los añade.
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[(process.env.WIBE_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

module.exports = {
  debug: (...args) => { if (current <= LEVELS.debug) console.log(...args); },
  info:  (...args) => { if (current <= LEVELS.info) console.log(...args); },
  warn:  (...args) => { if (current <= LEVELS.warn) console.warn(...args); },
  error: (...args) => { if (current <= LEVELS.error) console.error(...args); },
};
