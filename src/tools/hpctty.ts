/**
 * Terminal input for the HPC admin tools (hpc-hostkeys, hpc-password).
 * Secrets come back as bytes the caller wipes: echo is off before the prompt
 * appears, and stdin is never given an encoding, which would turn them into
 * strings. test/hpc-stack/hostkeys-pty.py types into these like a person.
 */
/**
 * A visible answer (UID, yes/no). stdin is never given an encoding: that
 * would make the secrets below arrive as strings too.
 */
export function ask(q: string): Promise<string> {
  process.stdout.write(q);
  return new Promise((resolve) => {
    process.stdin.once('data', (d: Buffer) => { process.stdin.pause(); resolve(d.toString('utf8').trim()); });
    process.stdin.resume();
  });
}

/** Reads a secret from the terminal into bytes: no echo, never a string. */
export function askSecret(q: string, max = 128): Promise<Buffer> {
  if (!process.stdin.isTTY) throw new Error('run this in a terminal: secrets are typed, not piped');
  // Echo off before the prompt appears: anything typed the moment the prompt
  // shows must not be printed by the terminal.
  process.stdin.setRawMode(true);
  process.stdout.write(q);
  return new Promise((resolve, reject) => {
    const buf = Buffer.alloc(max);
    let n = 0;
    process.stdin.resume();
    const onData = (chunk: Buffer) => {
      if (!Buffer.isBuffer(chunk)) { done(); return reject(new Error('the terminal handed over text, not bytes; refusing to read a secret that way')); }
      for (const b of chunk) {
        if (b === 0x03) { buf.fill(0); done(); return reject(new Error('cancelled')); }
        if (b === 0x0d || b === 0x0a) { done(); const out = Buffer.from(buf.subarray(0, n)); buf.fill(0); return resolve(out); }
        if (b === 0x7f || b === 0x08) { if (n > 0) buf[--n] = 0; continue; }
        if (n < max) buf[n++] = b;
      }
      chunk.fill(0);
    };
    const done = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    process.stdin.on('data', onData);
  });
}
