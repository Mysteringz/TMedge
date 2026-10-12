/**
 * The USB side of the web flasher: Web Serial.
 *
 * A page cannot see or open a serial port by itself. `chooseBoard` raises the
 * browser's own chooser -- only from a click, and only the device the person
 * picks there becomes reachable -- which is the permission the whole module
 * rests on. Chromium browsers on a computer have it; Safari, Firefox and
 * phones do not, and the page says so rather than pretending.
 */
import { FlasherError, type LineLink } from '../../../../src/shared/flasher/node-console.js';

export function serialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

// The USB-to-serial bridges an ESP32 board comes with, so the chooser lists
// boards rather than every Bluetooth modem the computer has ever paired. The
// same four TMflash recognises (TMflash/Sources/TMflashCore/SerialDevices.swift).
const BRIDGES: { usbVendorId: number; name: string }[] = [
  { usbVendorId: 0x10c4, name: 'Silicon Labs CP210x' },   // the Heltec V3's
  { usbVendorId: 0x1a86, name: 'WCH CH34x' },
  { usbVendorId: 0x0403, name: 'FTDI' },
  { usbVendorId: 0x303a, name: 'Espressif USB' },
];

/** Asks the person which board; null when they close the chooser. */
export async function chooseBoard(): Promise<SerialPort | null> {
  try {
    return await navigator.serial.requestPort({ filters: BRIDGES.map(({ usbVendorId }) => ({ usbVendorId })) });
  } catch (error) {
    // Dismissing the chooser is an answer, not a failure.
    if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'AbortError')) return null;
    throw error;
  }
}

export function describePort(port: SerialPort): string {
  const { usbVendorId, usbProductId } = port.getInfo();
  const bridge = BRIDGES.find((entry) => entry.usbVendorId === usbVendorId)?.name ?? 'USB serial device';
  const id = (value: number | undefined) => (value ?? 0).toString(16).padStart(4, '0');
  return `${bridge} (${id(usbVendorId)}:${id(usbProductId)})`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** TMsense's console speed (TM_SERIAL_BAUD). */
const CONSOLE_BAUD = 115200;
/** Garbage from a boot ROM at another speed must not grow a line without end. */
const MAX_LINE = 2048;
const MAX_QUEUED = 2000;

/**
 * A board's serial console, a line at a time: what NodeConsole talks through.
 * Owns the port while it is open; `close` gives it back.
 */
export class SerialConsole implements LineLink {
  private readonly lines: string[] = [];
  private partial = '';
  private wake: (() => void) | null = null;
  private failure: FlasherError | null = null;
  private closed = false;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private pump: Promise<void> = Promise.resolve();

  private constructor(private readonly port: SerialPort) {}

  static async open(port: SerialPort): Promise<SerialConsole> {
    try {
      await port.open({ baudRate: CONSOLE_BAUD });
    } catch (error) {
      // Another tab, the Mac app or a serial monitor already has it.
      throw new FlasherError(`could not open the board's serial port (${error instanceof Error ? error.message : 'unknown reason'}) — close anything else using it, such as TMflash or a serial monitor`);
    }
    const link = new SerialConsole(port);
    link.pump = link.read();
    return link;
  }

  /**
   * Restarts the board into its firmware, by the same two wires esptool uses
   * to reach the bootloader: RTS pulls the chip's reset line, DTR its boot
   * select. Done on purpose after opening, because opening a port moves those
   * lines in ways that differ by adapter and platform; this leaves one known
   * state instead -- reset, boot select released, application running.
   */
  async restart(): Promise<void> {
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(120);
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    this.lines.length = 0;
    this.partial = '';
  }

  private async read(): Promise<void> {
    const readable = this.port.readable;
    if (!readable) { this.fail('the board’s serial port cannot be read'); return; }
    const reader = readable.getReader();
    this.reader = reader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this.accept(this.decoder.decode(value, { stream: true }));
      }
    } catch {
      if (!this.closed) this.fail('the board stopped answering — was it unplugged?');
    } finally {
      reader.releaseLock();
    }
  }

  private accept(text: string): void {
    this.partial += text;
    for (;;) {
      const newline = this.partial.indexOf('\n');
      if (newline < 0) break;
      this.lines.push(this.partial.slice(0, newline).replace(/\r$/, ''));
      this.partial = this.partial.slice(newline + 1);
    }
    if (this.partial.length > MAX_LINE) this.partial = '';
    if (this.lines.length > MAX_QUEUED) this.lines.splice(0, this.lines.length - MAX_QUEUED);
    this.wake?.();
  }

  private fail(message: string): void {
    this.failure = new FlasherError(message);
    this.wake?.();
  }

  async write(text: string): Promise<void> {
    if (this.failure) throw this.failure;
    const writable = this.port.writable;
    if (!writable) throw new FlasherError('the board’s serial port cannot be written to');
    const writer = writable.getWriter();
    try {
      await writer.write(this.encoder.encode(text));
    } catch {
      throw new FlasherError('could not write to the board — was it unplugged?');
    } finally {
      writer.releaseLock();
    }
  }

  async readLine(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) return line;
      if (this.failure) throw this.failure;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); this.wake = null; resolve(); };
        const timer = setTimeout(finish, remaining);
        this.wake = finish;
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* already gone */ }
    await this.pump;
    try { await this.port.close(); } catch { /* unplugged: there is nothing left to close */ }
  }
}
