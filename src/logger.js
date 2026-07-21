const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Minimal leveled logger. `createLogger('info').child('sync')` yields
 * `{debug, info, warn, error}`; each takes (message, extra?) where extra is
 * JSON-serialized onto the line. warn/error go to stderr.
 */
export function createLogger(level = 'info', streams = { out: process.stdout, err: process.stderr }) {
  let threshold = LEVELS[level] ?? LEVELS.info;

  function child(module) {
    const emit = (lvl, msg, extra) => {
      if (LEVELS[lvl] < threshold) return;
      const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${module}] ${msg}` +
        (extra === undefined ? '' : ` ${JSON.stringify(extra)}`) + '\n';
      (LEVELS[lvl] >= LEVELS.warn ? streams.err : streams.out).write(line);
    };
    return {
      debug: (msg, extra) => emit('debug', msg, extra),
      info: (msg, extra) => emit('info', msg, extra),
      warn: (msg, extra) => emit('warn', msg, extra),
      error: (msg, extra) => emit('error', msg, extra),
    };
  }

  return {
    child,
    get level() {
      return Object.keys(LEVELS).find((k) => LEVELS[k] === threshold);
    },
    // Existing child loggers read the shared threshold, so panel-applied
    // log-level changes take effect immediately without a restart.
    setLevel(next) {
      if (LEVELS[next] !== undefined) threshold = LEVELS[next];
    },
  };
}
