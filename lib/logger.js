// ─────────────────────────────────────────────────────────────────────────────
// CousinsWatch PRO — Logger
// Lightweight levelled logger. Replace ad-hoc console.log calls with this.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

  function getThreshold() {
    const lvl = window.CW_CONFIG?.logLevel || 'info';
    return LEVELS[lvl] ?? LEVELS.info;
  }

  function makeLogger(tag) {
    const prefix = `[CW${tag ? ':' + tag : ''}]`;

    function emit(method, levelName, args) {
      if (LEVELS[levelName] < getThreshold()) return;
      try {
        console[method](prefix, ...args);
      } catch (_) {
        // Some environments (PiP windows) may not have full console — ignore
      }
    }

    return {
      debug: (...args) => emit('debug', 'debug', args),
      info:  (...args) => emit('log',   'info',  args),
      warn:  (...args) => emit('warn',  'warn',  args),
      error: (...args) => emit('error', 'error', args),
      child: (subTag) => makeLogger(tag ? `${tag}:${subTag}` : subTag),
    };
  }

  window.CWLogger = makeLogger();
  window.CWMakeLogger = makeLogger;
})();
