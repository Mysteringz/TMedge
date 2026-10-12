/**
 * A pretend TMsense board at the level of its USB serial port: the two reset
 * wires, the ESP32-S3's bootloader protocol on one side of a reset and the
 * firmware's console (test/fake-tmsense.ts) on the other.
 *
 * It exists so the web flasher can be run end to end -- the real page, the
 * real esptool-js -- against something that remembers exactly what was done
 * to its flash: every loader command, every region erased, every byte
 * written. "The flasher never erases NVS" is then a statement about what
 * this board received, not about what the code intends.
 *
 * Faithful to what esptool-js needs and no further. It is not evidence that
 * a real chip will accept the same bytes; a real board is.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { FakeTmsense } from './fake-tmsense.js';

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SECTOR = 0x1000;
const OPS: Record<number, string> = {
  0x02: 'flash_begin', 0x03: 'flash_data', 0x04: 'flash_end', 0x05: 'mem_begin', 0x06: 'mem_end', 0x07: 'mem_data',
  0x08: 'sync', 0x09: 'write_reg', 0x0a: 'read_reg', 0x0b: 'spi_set_params', 0x0d: 'spi_attach', 0x0f: 'change_baudrate',
  0x10: 'flash_defl_begin', 0x11: 'flash_defl_data', 0x12: 'flash_defl_end', 0x13: 'spi_flash_md5', 0x14: 'get_security_info',
  0xd0: 'erase_flash', 0xd1: 'erase_region', 0xd2: 'read_flash',
};
// ESP32-S3 registers esptool-js reads or drives (targets/esp32s3.js).
const MAC_EFUSE = 0x60007044;
const SPI_CMD = 0x60002000;
const SPI_USR2 = 0x60002020;
const SPI_W0 = 0x60002058;
/** A GigaDevice part whose size code (0x17) reads as 8 MB. */
const FLASH_ID = 0x1740c8;

export interface LoaderOp { op: number; name: string; address?: number; size?: number }

export class FakeBoard {
  readonly node: FakeTmsense;
  readonly flash = Buffer.alloc(8 * 1024 * 1024, 0xff);
  /** Every loader command that changes or erases flash, plus the first of each other kind, in order. */
  readonly ops: LoaderOp[] = [];
  /** [start, end) of every region cleared, by an erase or ahead of a write. */
  readonly erased: [number, number][] = [];
  /** How many times the chip came out of reset into its bootloader. */
  downloads = 0;
  /** The chip id the bootloader reports; 9 is an ESP32-S3. */
  chipId = 9;
  private mode: 'held' | 'bootloader' | 'app' = 'app';
  private stub = false;
  private dtr = false;
  private rts = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly registers = new Map<number, number>();
  private frame: number[] | null = null;
  private escaping = false;
  private line = '';
  private writing: { address: number; size: number; chunks: Buffer[] } | null = null;

  constructor(readonly uid: string, private readonly emit: (bytes: Uint8Array) => void, options: { blank?: boolean } = {}) {
    this.node = new FakeTmsense(uid);
    this.node.bootDelayMs = 150;
    // A board that has never had TMsense on it says nothing a flasher understands.
    this.node.silent = options.blank ?? false;
    const mac = uid.split(':').map((part) => parseInt(part, 16));
    this.registers.set(MAC_EFUSE, (((mac[2] ?? 0) << 24) | ((mac[3] ?? 0) << 16) | ((mac[4] ?? 0) << 8) | (mac[5] ?? 0)) >>> 0);
    this.registers.set(MAC_EFUSE + 4, ((mac[0] ?? 0) << 8) | (mac[1] ?? 0));
    this.node.reset(Date.now());
  }

  /**
   * The auto-reset circuit every ESP32 dev board has: RTS alone pulls the
   * chip's reset line, DTR alone its boot-select pin, and what the pin reads
   * a moment after reset is released decides what starts.
   */
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): void {
    if (signals.dataTerminalReady !== undefined) this.dtr = signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) this.rts = signals.requestToSend;
    if (this.rts && !this.dtr) {
      this.mode = 'held';
      clearTimeout(this.timer);
      this.timer = undefined;
    } else if (this.mode === 'held' && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.boot(this.dtr && !this.rts); }, 15);
    }
  }

  private boot(download: boolean): void {
    this.stub = false; this.frame = null; this.escaping = false; this.line = ''; this.writing = null;
    if (download) {
      this.mode = 'bootloader';
      this.downloads += 1;
      this.text('ESP-ROM:esp32s3-20210327\r\nBuild:Mar 27 2021\r\nrst:0x1 (POWERON),boot:0x0 (DOWNLOAD(USB/UART0))\r\nwaiting for download\r\n');
      return;
    }
    this.mode = 'app';
    this.text('ESP-ROM:esp32s3-20210327\r\nrst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)\r\n');
    for (const line of this.node.reset(Date.now())) this.text(`${line}\r\n`);
  }

  /** Bytes from the host. */
  write(bytes: Uint8Array): void {
    if (this.mode === 'held') return;
    if (this.mode === 'app') {
      for (const byte of bytes) {
        if (byte === 0x0d) continue;
        if (byte !== 0x0a) { this.line += String.fromCharCode(byte); continue; }
        const line = this.line;
        this.line = '';
        for (const reply of this.node.handle(line, Date.now())) this.text(`${reply}\r\n`);
      }
      return;
    }
    for (const byte of bytes) {
      if (this.frame === null) { if (byte === SLIP_END) this.frame = []; continue; }
      if (this.escaping) { this.frame.push(byte === 0xdc ? SLIP_END : SLIP_ESC); this.escaping = false; continue; }
      if (byte === SLIP_ESC) { this.escaping = true; continue; }
      if (byte !== SLIP_END) { this.frame.push(byte); continue; }
      const frame = Buffer.from(this.frame);
      this.frame = null;
      if (frame.length >= 8) this.command(frame);
      else if (frame.length === 0) this.frame = [];   // back-to-back delimiters: the next frame has begun
    }
  }

  private text(text: string): void {
    this.emit(Buffer.from(text, 'latin1'));
  }

  private slip(payload: Buffer): void {
    const out: number[] = [SLIP_END];
    for (const byte of payload) {
      if (byte === SLIP_END) out.push(SLIP_ESC, 0xdc);
      else if (byte === SLIP_ESC) out.push(SLIP_ESC, 0xdd);
      else out.push(byte);
    }
    out.push(SLIP_END);
    this.emit(Uint8Array.from(out));
  }

  private respond(op: number, value = 0, data: Buffer = Buffer.alloc(0), failed = false): void {
    // The ROM ends a reply with four status bytes, the stub with two.
    const status = Buffer.alloc(this.stub ? 2 : 4);
    if (failed) { status[0] = 1; status[1] = 0x05; }
    const header = Buffer.alloc(8);
    header[0] = 0x01; header[1] = op;
    header.writeUInt16LE(data.length + status.length, 2);
    header.writeUInt32LE(value >>> 0, 4);
    this.slip(Buffer.concat([header, data, status]));
  }

  private note(op: number, detail: { address?: number; size?: number } = {}): void {
    const name = OPS[op] ?? `unknown_0x${op.toString(16)}`;
    const changesFlash = [0x02, 0x10, 0xd0, 0xd1].includes(op);
    if (changesFlash || !this.ops.some((entry) => entry.op === op)) this.ops.push({ op, name, ...detail });
  }

  private clear(start: number, bytes: number): void {
    const end = Math.min(this.flash.length, start + Math.ceil(bytes / SECTOR) * SECTOR);
    this.flash.fill(0xff, start, end);
    this.erased.push([start, end]);
  }

  private command(frame: Buffer): void {
    const op = frame.readUInt8(1);
    const checksum = frame.readUInt32LE(4);
    const data = frame.subarray(8);
    const word = (index: number): number => data.length >= index * 4 + 4 ? data.readUInt32LE(index * 4) : 0;
    const sum = (bytes: Buffer): number => bytes.reduce((state, byte) => state ^ byte, 0xef);
    switch (op) {
      case 0x08:   // sync: the ROM answers eight times, and with a non-zero value the stub does not use
        this.note(op);
        for (let i = 0; i < 8; i++) this.respond(op, this.stub ? 0 : 0x20120707);
        return;
      case 0x14: {   // security info: flags, crypt count, key purposes, chip id, api version
        this.note(op);
        const info = Buffer.alloc(20);
        info.writeUInt32LE(this.chipId, 12);
        this.respond(op, 0, info);
        return;
      }
      case 0x0a:
        this.note(op);
        this.respond(op, this.registers.get(word(0)) ?? 0);
        return;
      case 0x09: {
        this.note(op);
        const address = word(0);
        if (address === SPI_CMD) {
          // A SPI flash command runs to completion at once. The only one that
          // returns anything here is "read JEDEC id".
          if ((this.registers.get(SPI_USR2) ?? 0) & 0xff) this.registers.set(SPI_W0, ((this.registers.get(SPI_USR2) ?? 0) & 0xff) === 0x9f ? FLASH_ID : 0);
          this.registers.set(SPI_CMD, 0);
        } else {
          this.registers.set(address, word(1));
        }
        this.respond(op);
        return;
      }
      case 0x05: case 0x0b: case 0x0d: case 0x0f:
        this.note(op);
        this.respond(op);
        return;
      case 0x07:
        this.note(op);
        this.respond(op, 0, Buffer.alloc(0), sum(data.subarray(16)) !== checksum);
        return;
      case 0x06:   // mem_end with an entry point: the flasher stub takes over and says so
        this.note(op);
        this.respond(op);
        if (word(1) !== 0) { this.stub = true; this.slip(Buffer.from('OHAI')); }
        return;
      case 0x10: {
        const size = word(0), address = word(3);
        this.note(op, { address, size });
        this.clear(address, size);
        this.writing = { address, size, chunks: [] };
        this.respond(op);
        return;
      }
      case 0x11: {
        this.note(op);
        const block = data.subarray(16, 16 + word(0));
        const bad = !this.writing || sum(block) !== checksum;
        if (!bad) this.writing?.chunks.push(Buffer.from(block));
        this.respond(op, 0, Buffer.alloc(0), bad);
        return;
      }
      case 0x12: {
        this.note(op);
        const writing = this.writing;
        this.writing = null;
        let bad = !writing;
        if (writing) {
          try {
            const image = inflateSync(Buffer.concat(writing.chunks));
            bad = image.length !== writing.size;
            if (!bad) {
              image.copy(this.flash, writing.address);
              // An application that announces itself: from the next reset this board is a TMsense.
              if (image.includes('tmsense-')) this.node.silent = false;
            }
          } catch { bad = true; }
        }
        this.respond(op, 0, Buffer.alloc(0), bad);
        return;
      }
      case 0x13: {
        this.note(op);
        const digest = createHash('md5').update(this.flash.subarray(word(0), word(0) + word(1))).digest();
        // The stub answers with the 16 bytes; the ROM with 32 characters of hex.
        this.respond(op, 0, this.stub ? digest : Buffer.from(digest.toString('hex'), 'latin1'));
        return;
      }
      case 0xd0:
        this.note(op, { address: 0, size: this.flash.length });
        this.clear(0, this.flash.length);
        this.respond(op);
        return;
      case 0xd1:
        this.note(op, { address: word(0), size: word(1) });
        this.clear(word(0), word(1));
        this.respond(op);
        return;
      default:
        // Uncompressed writes, reads and anything unknown: the flasher has no
        // business sending them, so they are recorded and refused.
        this.note(op, op === 0x02 ? { address: word(3), size: word(0) } : {});
        this.respond(op, 0, Buffer.alloc(0), true);
    }
  }
}
