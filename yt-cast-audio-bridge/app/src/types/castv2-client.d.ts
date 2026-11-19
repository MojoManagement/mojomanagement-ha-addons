declare module 'castv2-client' {
  import type { EventEmitter } from 'node:events';

  // The library ships no types. The bridge talks to it through the narrow
  // interfaces in `src/cast/link.ts`, so the constructors are all it needs here.
  export const Client: new () => EventEmitter;
  export const DefaultMediaReceiver: (new (...args: unknown[]) => EventEmitter) & { APP_ID: string };
}
