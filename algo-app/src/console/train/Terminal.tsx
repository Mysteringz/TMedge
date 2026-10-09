/**
 * The CONSOLE's "ssh" mode: a shell on the cluster, as the person's own SSH
 * session (src/algo/train/hpc/terminal.ts). xterm.js draws it; every
 * keystroke and every byte of output is sealed end to end between this page
 * and the edge (src/shared/hpcterm.ts), so the proxies between only carry
 * ciphertext -- a `passwd` typed here is as private as the PIN was.
 */
import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { T_DATA, T_EXIT, T_RESIZE, TermChannel, TermSender, type TermTicket } from '../../../../src/shared/hpcterm.js';
import { installCspShims } from './csp.ts';

const THEME = {
  background: '#161616', foreground: '#c6c6c6', cursor: '#ff832b', cursorAccent: '#161616',
  selectionBackground: 'rgba(255, 131, 43, .3)', black: '#393939', brightBlack: '#8d8d8d',
  red: '#ff8389', brightRed: '#ffb3b8', green: '#42be65', brightGreen: '#6fdc8c', yellow: '#f1c21b', brightYellow: '#fddc69',
  blue: '#78a9ff', brightBlue: '#a6c8ff', magenta: '#ff832b', brightMagenta: '#ffb784', cyan: '#3ddbd9', brightCyan: '#9ef0f0',
  white: '#c6c6c6', brightWhite: '#f4f4f4',
};

export interface TerminalProps {
  /** A fresh one-time ticket from POST /api/train/hpc/term. */
  ticket: () => Promise<TermTicket>;
  target: string;
  onClosed(why: string): void;
}

export function ClusterTerminal({ ticket, target, onClosed }: TerminalProps) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;

  useEffect(() => {
    let disposed = false;
    let cleanup = () => undefined as void;
    (async () => {
      installCspShims();
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (disposed || !host.current) return;
      const term = new Terminal({
        fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 13, lineHeight: 1.15, cursorBlink: true,
        theme: THEME, scrollback: 5000, allowProposedApi: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      fit.fit();
      term.write(`\x1b[38;2;147;151;171mconnecting to ${target} over your HKU session…\x1b[0m\r\n`);
      const t = await ticket();
      const ch = await TermChannel.open(t);
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${scheme}://${location.host}/train-term?tid=${encodeURIComponent(t.tid)}&epk=${ch.publicKey}&cols=${term.cols}&rows=${term.rows}`);
      ws.binaryType = 'arraybuffer';
      const enc = new TextEncoder();
      // Frames made before the socket opens are held, not dropped (TermSender).
      const sender = new TermSender(ch);
      const send = (type: number, payload: Uint8Array) => { void sender.send(type, payload); };
      ws.onopen = () => { void sender.open(ws); if (!disposed) setState('open'); term.focus(); };
      ws.onmessage = (m) => {
        void ch.open(new Uint8Array(m.data as ArrayBuffer)).then((msg) => {
          if (msg.type === T_DATA) term.write(msg.payload);
          if (msg.type === T_EXIT) term.write(`\r\n\x1b[38;2;147;151;171m[shell exited ${msg.payload[0] ?? ''}]\x1b[0m\r\n`);
        }, () => ws.close());
      };
      ws.onclose = (e) => {
        if (disposed) return;
        setState('closed');
        const why = e.reason || (e.code === 1006 ? 'connection lost' : `closed (${e.code})`);
        term.write(`\r\n\x1b[38;2;255;201;163m[terminal closed: ${why}]\x1b[0m\r\n`);
        closedRef.current(why);
      };
      const data = term.onData((s) => send(T_DATA, enc.encode(s)));
      const bin = term.onBinary((s) => send(T_DATA, Uint8Array.from(s, (ch2) => ch2.charCodeAt(0) & 255)));
      const sizes = term.onResize(({ cols, rows }) => {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint16(0, cols);
        new DataView(b.buffer).setUint16(2, rows);
        send(T_RESIZE, b);
      });
      const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* hidden */ } });
      ro.observe(host.current);
      cleanup = () => { ro.disconnect(); data.dispose(); bin.dispose(); sizes.dispose(); ws.close(); term.dispose(); };
      if (disposed) cleanup();
    })().catch((err: Error) => { if (!disposed) { setState('closed'); closedRef.current(err.message); } });
    return () => { disposed = true; cleanup(); };
    // One terminal per mount; the parent remounts it to reconnect.
  }, []);

  return <div className={`cx-term is-${state}`} ref={host} aria-label={`Shell on ${target}`} />;
}
