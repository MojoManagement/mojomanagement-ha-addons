declare module 'multicast-dns' {
  import type { EventEmitter } from 'node:events';

  export interface MdnsRecord {
    name: string;
    type: string;
    ttl?: number;
    data?: unknown;
  }
  export interface MdnsPacket {
    answers?: MdnsRecord[];
    additionals?: MdnsRecord[];
  }
  export interface MdnsInstance extends EventEmitter {
    query(questions: { name: string; type: string }[], callback?: (err: Error | null) => void): void;
    respond(packet: MdnsPacket): void;
    destroy(callback?: () => void): void;
  }
  export default function createMdns(options?: { interface?: string; bind?: string; reuseAddr?: boolean }): MdnsInstance;
}
