// Development aid: announces a fake Cast speaker on the local network and serves the
// Cast protocol for it, so the bridge can be tried without real hardware.
//
//   npm run fake-speaker -- <LAN address of this machine> [name]
import createMdns from 'multicast-dns';
import { FakeCastDevice } from './fake-cast-device.ts';

const [address, name = 'Fake Speaker'] = process.argv.slice(2);
if (!address) {
  process.stderr.write('Usage: npm run fake-speaker -- <LAN address of this machine> [name]\n');
  process.exit(1);
}

const SERVICE = '_googlecast._tcp.local';
const INSTANCE = `Fake-Speaker-0011223344556677.${SERVICE}`;
const device = new FakeCastDevice();
await device.listen();

const mdns = createMdns({ interface: address, bind: '0.0.0.0', reuseAddr: true });
mdns.on('query', (query: { questions?: { name: string }[] }) => {
  if (!query.questions?.some((question) => question.name === SERVICE || question.name === INSTANCE)) return;
  mdns.respond({
    answers: [{ name: SERVICE, type: 'PTR', ttl: 120, data: INSTANCE }],
    additionals: [
      { name: INSTANCE, type: 'SRV', ttl: 120, data: { target: 'fake-speaker.local', port: device.port } },
      { name: INSTANCE, type: 'TXT', ttl: 120, data: ['id=0011223344556677', `fn=${name}`, 'md=Nest Mini', 'ca=199172'] },
      { name: 'fake-speaker.local', type: 'A', ttl: 120, data: '127.0.0.1' },
    ],
  });
});

process.stdout.write(`Fake speaker "${name}" is announced via ${address}; Cast port ${device.port}. Ctrl+C to stop.\n`);
let lastReport = '';
setInterval(() => {
  const report = JSON.stringify({ app: device.session?.appId ?? null, state: device.media?.playerState ?? null, lastLoad: device.loads.at(-1) ?? null, volume: device.volume });
  if (report !== lastReport) process.stdout.write(`${report}\n`);
  lastReport = report;
}, 1000);
