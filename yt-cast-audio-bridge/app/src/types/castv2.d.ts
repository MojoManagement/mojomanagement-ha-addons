declare module 'castv2' {
  import type { EventEmitter } from 'node:events';

  // Only used by the test suite's fake Cast device.
  export class Server extends EventEmitter {
    constructor(options: { key: string | Buffer; cert: string | Buffer });
    listen(port: number, host: string, callback: () => void): void;
    close(): void;
    send(clientId: string, sourceId: string, destinationId: string, namespace: string, data: string): void;
  }
}
