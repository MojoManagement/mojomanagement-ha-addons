import { errorMessage, redactSecrets } from './util.ts';

export const LOG_LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEntry {
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
}

export interface Logger {
  error(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
  child(scope: string): Logger;
}

export type LogSink = (entry: LogEntry) => void;

function formatDetail(detail: unknown): string {
  if (detail === undefined) return '';
  if (detail instanceof Error) return ` (${detail.message})`;
  if (typeof detail === 'string') return ` ${detail}`;
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return ` ${errorMessage(detail)}`;
  }
}

/** Keeps the most recent log lines in memory so the web UI can show them. */
export class LogBuffer {
  readonly #capacity: number;
  #entries: LogEntry[] = [];

  constructor(capacity = 300) {
    this.#capacity = capacity;
  }

  push(entry: LogEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) this.#entries.splice(0, this.#entries.length - this.#capacity);
  }

  list(): LogEntry[] {
    return [...this.#entries];
  }
}

export function consoleSink(entry: LogEntry): void {
  const line = `${entry.time.slice(11, 19)} ${entry.level.padEnd(5)} [${entry.scope}] ${entry.message}\n`;
  (entry.level === 'ERROR' || entry.level === 'WARN' ? process.stderr : process.stdout).write(line);
}

export function createLogger(options: { level: LogLevel; scope?: string; sinks?: LogSink[] }): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level);
  const sinks = options.sinks ?? [consoleSink];

  const make = (scope: string): Logger => {
    const log = (level: LogLevel, message: string, detail?: unknown): void => {
      if (LOG_LEVELS.indexOf(level) > threshold) return;
      const entry: LogEntry = {
        time: new Date().toISOString(),
        level,
        scope,
        message: redactSecrets(message + formatDetail(detail)),
      };
      for (const sink of sinks) sink(entry);
    };
    return {
      error: (message, detail) => log('ERROR', message, detail),
      warn: (message, detail) => log('WARN', message, detail),
      info: (message, detail) => log('INFO', message, detail),
      debug: (message, detail) => log('DEBUG', message, detail),
      child: (childScope) => make(`${scope}:${childScope}`),
    };
  };
  return make(options.scope ?? 'bridge');
}

/** Logger that discards everything; handy as a default in tests. */
export const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};
