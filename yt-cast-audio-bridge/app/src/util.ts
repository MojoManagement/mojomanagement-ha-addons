/** Small dependency-free helpers shared across the bridge. */

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects with a TimeoutError when `promise` does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(errorMessage(err)));
      },
    );
  });
}

/** Turns a node-style callback API call into a promise that cannot hang. */
export function callWithTimeout<T>(
  invoke: (callback: (err: unknown, result?: T) => void) => void,
  ms: number,
  what: string,
): Promise<T> {
  return withTimeout(
    new Promise<T>((resolve, reject) => {
      invoke((err, result) => {
        if (err) reject(err instanceof Error ? err : new Error(errorMessage(err)));
        else resolve(result as T);
      });
    }),
    ms,
    what,
  );
}

/** Runs async tasks strictly one after another; a failing task does not block the next. */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

/** Exponential backoff: base, 2x base, 4x base ... capped at `maxMs`. `attempt` starts at 1. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 20);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

/** Signed media URLs and YouTube pairing tokens are credentials; never write them to logs. */
export function redactSecrets(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"']*googlevideo\.com\/[^\s"']*/g, '<media-url>')
    .replace(/((?:lounge_?token|loungeIdToken|SAPISID|__Secure-[\w-]+)['"]?\s*[:=]\s*['"]?)[\w%.-]{12,}/gi, '$1<redacted>');
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
