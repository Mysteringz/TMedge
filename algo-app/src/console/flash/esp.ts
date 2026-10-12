/**
 * Writing firmware to the board on a serial port, with Espressif's own
 * loader (esptool-js) rather than one of ours: the bootloader protocol is
 * theirs, and a flasher that drifts from it bricks boards.
 *
 * What this file adds is the project's rule. There is no erase anywhere in
 * it, the plan it is given has already been confined to the regions an
 * install may touch (src/shared/flasher/images.ts) and is checked once more
 * here, and every region written is read back as an MD5 before the job is
 * called done.
 */
import { assertPreserves, FLASH_BYTES, type FlashPlan } from '../../../../src/shared/flasher/images.js';
import { md5Hex } from '../../../../src/shared/flasher/md5.js';
import { FlasherError } from '../../../../src/shared/flasher/node-console.js';

export interface WriteHooks {
  log(line: string): void;
  /** 0…1 across all four images, weighted by size. */
  progress(fraction: number): void;
}

/** The board's upload speed, which its CP2102 handles reliably (as TMflash). */
const FLASH_BAUD = 460800;
const ROM_BAUD = 115200;
const SIZES: Record<string, number> = { '256KB': 1 / 4, '512KB': 1 / 2, '1MB': 1, '2MB': 2, '4MB': 4, '8MB': 8, '16MB': 16, '32MB': 32, '64MB': 64, '128MB': 128, '256MB': 256 };

/** Writes `plan` to the board and returns the MAC the chip reported. */
export async function writeFirmware(port: SerialPort, plan: FlashPlan, hooks: WriteHooks): Promise<string> {
  // Checked where it was planned, and again where it is carried out.
  assertPreserves(plan);
  // Most of this module's weight, and needed by nobody who is only reading the page.
  const { ESPLoader, Transport } = await import('esptool-js');
  let partial = '';
  const say = (line: string) => {
    const text = line.trim();
    // One line per block written is the progress bar's job, not the log's.
    if (text && !text.startsWith('Writing at ')) hooks.log(text);
  };
  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport, baudrate: FLASH_BAUD, romBaudrate: ROM_BAUD,
    terminal: {
      clean() { partial = ''; },
      writeLine(data) { say(partial + data); partial = ''; },
      write(data) {
        const lines = (partial + data).split(/\r?\n/);
        partial = lines.pop() ?? '';
        for (const line of lines) say(line);
      },
    },
  });
  try {
    await loader.main();
    if (loader.chip.CHIP_NAME !== 'ESP32-S3') {
      throw new FlasherError(`this board is an ${loader.chip.CHIP_NAME}, not the ESP32-S3 a TMsense node uses`);
    }
    const megabytes = SIZES[await loader.detectFlashSize() ?? ''];
    if (megabytes !== undefined && megabytes * 1024 * 1024 < FLASH_BYTES) {
      throw new FlasherError(`this board has ${megabytes} MB of flash; TMsense needs 8 MB`);
    }
    const mac = (await loader.chip.readMac(loader)).toLowerCase();
    const sizes = plan.segments.map((segment) => segment.data.length);
    await loader.writeFlash({
      fileArray: plan.segments.map((segment) => ({ data: segment.data, address: segment.address })),
      // Written exactly as PlatformIO built them. The loader can rewrite the
      // bootloader's flash-settings header on the way, but that changes the
      // image without renewing the hash inside it; the build already carries
      // the right settings, and the plan refused it if it did not.
      flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep',
      // Never. NVS holds the node's settings and its boot counter.
      eraseAll: false,
      compress: true,
      reportProgress: (index, written, total) => {
        const before = sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
        hooks.progress(Math.min(1, (before + (sizes[index] ?? 0) * (total > 0 ? written / total : 1)) / plan.totalBytes));
      },
      calculateMD5Hash: (image) => md5Hex(image),
    });
    hooks.progress(1);
    return mac;
  } catch (error) {
    if (error instanceof FlasherError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new FlasherError(/Failed to connect|No serial data|Wrong boot mode|TX path/i.test(message)
      ? `could not reach the board's bootloader (${message.split('\n')[0]}) — hold the board's PRG button, tap RST, and try again`
      : `writing firmware failed: ${message}`);
  } finally {
    // Closes the port; the caller reopens it at the console's speed and
    // restarts the board itself (serial.ts), so there is one reset, in one place.
    try { await transport.disconnect(); } catch { /* unplugged mid-write: nothing left to close */ }
  }
}
