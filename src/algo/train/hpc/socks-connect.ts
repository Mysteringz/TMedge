/**
 * ssh's ProxyCommand for module 02: `socks-connect.js 127.0.0.1 <port> <host> <port>`.
 * Opens a SOCKS5 CONNECT through ocproxy (the person's own tunnel) and then
 * passes bytes both ways. The host name goes to the proxy unresolved, so it
 * is looked up inside the VPN, the way PySocks' rdns=True does in the handover.
 */
import { connect } from 'node:net';

const [proxyHost, proxyPort, host, port] = process.argv.slice(2);
const p = Number(proxyPort);
const q = Number(port);
if (!proxyHost || !host || !Number.isInteger(p) || !Number.isInteger(q) || host.length > 255) {
  process.stderr.write('usage: socks-connect <proxy-host> <proxy-port> <host> <port>\n');
  process.exit(2);
}
const s = connect({ host: proxyHost, port: p });
let stage = 0;
let pending = Buffer.alloc(0);
s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
s.on('data', (chunk: Buffer) => {
  if (stage === 2) { process.stdout.write(chunk); return; }
  pending = Buffer.concat([pending, chunk]);
  if (stage === 0 && pending.length >= 2) {
    if (pending[0] !== 5 || pending[1] !== 0) fail('proxy refused the greeting');
    pending = pending.subarray(2);
    // An IPv4 address goes as one (ATYP 1); a name goes unresolved (ATYP 3).
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    const name = Buffer.from(host, 'ascii');
    const addr = v4 && v4.slice(1).every((x) => Number(x) <= 255)
      ? Buffer.from([1, ...v4.slice(1).map(Number)])
      : Buffer.concat([Buffer.from([3, name.length]), name]);
    s.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([q >> 8, q & 255])]));
    stage = 1;
  }
  if (stage === 1 && pending.length >= 5) {
    if (pending[1] !== 0) fail(`proxy could not connect (SOCKS reply ${pending[1]})`);
    const atyp = pending[3];
    const len = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + (pending[4] ?? 0);
    if (pending.length < len) return;
    const rest = pending.subarray(len);
    stage = 2;
    if (rest.length) process.stdout.write(rest);
    process.stdin.pipe(s);
  }
});
s.on('end', () => process.exit(0));
s.on('error', (e) => fail(e.message));
process.stdin.on('end', () => s.end());

function fail(why: string): never {
  process.stderr.write(`socks-connect: ${why}\n`);
  process.exit(1);
}
