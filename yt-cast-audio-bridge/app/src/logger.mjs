const LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

export function createLogger(name, level = 'INFO') {
  const active = LEVELS[level] ?? LEVELS.INFO;
  const print = (wanted, method, ...args) => {
    if ((LEVELS[wanted] ?? 99) <= active) {
      console[method](`[${new Date().toISOString()}] [${name}] [${wanted}]`, ...args);
    }
  };
  return {
    error: (...args) => print('ERROR', 'error', ...args),
    warn: (...args) => print('WARN', 'warn', ...args),
    info: (...args) => print('INFO', 'log', ...args),
    debug: (...args) => print('DEBUG', 'log', ...args),
  };
}
