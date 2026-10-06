/**
 * SSH_ASKPASS for module 02's logins to HPC2021 (see ssh.ts). ssh runs this
 * with the prompt as its argument; it asks the edge, over the one-time Unix
 * socket named in TM_ASKPASS_SOCK, and copies the answer to stdout as bytes.
 * It never holds the answer as a string and never writes it anywhere else.
 */
import { connect } from 'node:net';

const sock = process.env.TM_ASKPASS_SOCK;
if (!sock) process.exit(1);
const prompt = (process.argv[2] ?? '').replace(/[\r\n]/g, ' ').slice(0, 300);
const c = connect(sock);
c.on('connect', () => c.write(`${prompt}\n`));
c.on('data', (b: Buffer) => { process.stdout.write(b, () => b.fill(0)); });
c.on('end', () => process.stdout.end());
c.on('error', () => process.exit(1));
setTimeout(() => process.exit(1), 10_000).unref();
