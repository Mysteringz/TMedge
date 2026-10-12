/**
 * What to write to a board's flash, and where -- decided from the images
 * themselves, before a single byte is sent.
 *
 * The rule this file exists to keep: **a flash never erases NVS.** NVS holds
 * the node's settings and its boot counter, and a boot counter that goes back
 * to zero makes TMedge reject every packet the node then sends as a replay.
 * So the plan is an allow-list. Each image may land in exactly one region
 * (bootloader space, the partition table's sector, the boot selector's
 * partition, the first application slot), the regions are read from the
 * partition table being flashed, and a plan that would touch anything else
 * -- an NVS partition above all -- is refused rather than trimmed.
 *
 * The Mac app gets the same four images and offsets from PlatformIO's build
 * metadata (TMflash/Sources/TMflashCore/Toolchain.swift). A browser cannot
 * run PlatformIO, so the offsets come from the table instead.
 */
import { FlasherError } from './node-console.js';
import { hex, md5 } from './md5.js';

/** A flash sector: what an erase rounds up to. */
export const SECTOR = 0x1000;
/** Heltec WiFi LoRa 32 V3: an ESP32-S3 with 8 MB of flash. */
export const FLASH_BYTES = 8 * 1024 * 1024;
/** The chip id in an ESP32-S3 image header, and what its loader reports. */
export const ESP32_S3_CHIP_ID = 9;
export const BOOTLOADER_OFFSET = 0x0;
export const PARTITION_TABLE_OFFSET = 0x8000;

const IMAGE_MAGIC = 0xe9;
const TYPE_APP = 0x00;
const TYPE_DATA = 0x01;
const SUBTYPE_OTA_0 = 0x10;
const SUBTYPE_OTADATA = 0x00;
const SUBTYPE_NVS = 0x02;
const SUBTYPE_NVS_KEYS = 0x04;

export interface Partition {
  label: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
}

export type SegmentName = 'bootloader' | 'partition table' | 'boot selector' | 'application';

export interface FlashSegment {
  name: SegmentName;
  address: number;
  data: Uint8Array;
}

export interface FlashPlan {
  /** TM_FW_VERSION as the application image carries it, e.g. tmsense-1.6. */
  version: string;
  segments: FlashSegment[];
  /** Regions no segment may reach: every NVS partition in the table. */
  preserved: Partition[];
  totalBytes: number;
}

export interface FirmwareFiles {
  bootloader: Uint8Array;
  partitions: Uint8Array;
  application: Uint8Array;
}

const end = (p: { offset: number; size: number }): number => p.offset + p.size;
const sectors = (bytes: number): number => Math.ceil(bytes / SECTOR) * SECTOR;
const at = (address: number): string => `0x${address.toString(16)}`;

/**
 * Reads an ESP-IDF partition table (the `partitions.bin` of a build): 32-byte
 * entries, then an MD5 of them, then padding.
 */
export function parsePartitionTable(bytes: Uint8Array): Partition[] {
  if (bytes.length === 0 || bytes.length > SECTOR || bytes.length % 32 !== 0) {
    throw new FlasherError('the partition table is not a partitions.bin (wrong size)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Partition[] = [];
  let checked = false;
  for (let offset = 0; offset < bytes.length; offset += 32) {
    const magic = view.getUint16(offset, true);
    if (magic === 0x50aa) {
      let label = '';
      for (let i = 12; i < 28; i++) {
        const code = bytes[offset + i] ?? 0;
        if (code === 0) break;
        label += String.fromCharCode(code);
      }
      out.push({ label, type: bytes[offset + 2] ?? 0, subtype: bytes[offset + 3] ?? 0, offset: view.getUint32(offset + 4, true), size: view.getUint32(offset + 8, true) });
      continue;
    }
    if (magic === 0xebeb) {
      // The table's own checksum: a truncated or hand-edited file stops here.
      if (hex(md5(bytes.subarray(0, offset))) !== hex(bytes.subarray(offset + 16, offset + 32))) {
        throw new FlasherError('the partition table is damaged (its checksum does not match)');
      }
      checked = true;
    }
    break;
  }
  if (out.length === 0) throw new FlasherError('the partition table is not a partitions.bin (no entries)');
  if (!checked) throw new FlasherError('the partition table has no checksum; rebuild the firmware');
  return out;
}

/** The chip an ESP image was built for, or null if it is not an ESP image. */
export function imageChipId(image: Uint8Array): number | null {
  if (image.length < 24 || image[0] !== IMAGE_MAGIC) return null;
  return (image[12] ?? 0) | ((image[13] ?? 0) << 8);
}

/** TM_FW_VERSION, which the firmware prints at boot and so carries as text. */
export function tmsenseVersion(application: Uint8Array): string | null {
  // Latin-1, one character per byte, so the search runs over the bytes as they are.
  const marker = [0x74, 0x6d, 0x73, 0x65, 0x6e, 0x73, 0x65, 0x2d];   // "tmsense-"
  for (let i = 0; i + marker.length < application.length; i++) {
    if (application[i] !== marker[0] || !marker.every((byte, j) => application[i + j] === byte)) continue;
    let text = '';
    // "at most 12 chars" (TMsense include/tm_config.h): the STATUS packet's field width.
    for (let j = i; j < i + 12 && j < application.length; j++) {
      const code = application[j] ?? 0;
      if (!/[0-9A-Za-z.-]/.test(String.fromCharCode(code))) break;
      text += String.fromCharCode(code);
    }
    if (/^tmsense-\d/.test(text)) return text;
  }
  return null;
}

/**
 * The boot selector as PlatformIO flashes it (the framework's boot_app0.bin):
 * "start the first application slot". Without it a node that has taken an
 * over-the-air update keeps booting the second slot, and the image just
 * written to the first would never run.
 *
 * It is a constant -- two copies of the selector, the first saying sequence 1
 * with its CRC, the second deliberately invalid -- so it is built here rather
 * than asked for; test/flasher.test.ts pins it to the hash of the
 * framework's file.
 */
export function bootSelector(): Uint8Array {
  const out = new Uint8Array(0x2000).fill(0xff);
  out.set([0x01, 0x00, 0x00, 0x00], 0);
  out.set([0x9a, 0x98, 0x43, 0x47], 28);
  // The second copy: sequence 0 with no CRC, which the bootloader ignores.
  out.set([0x00, 0x00, 0x00, 0x00], 0x1000);
  return out;
}

function requireImage(image: Uint8Array, what: string): void {
  const chip = imageChipId(image);
  if (chip === null) throw new FlasherError(`the ${what} is not an ESP32 image`);
  if (chip !== ESP32_S3_CHIP_ID) throw new FlasherError(`the ${what} was built for a different chip, not the ESP32-S3 a TMsense node uses`);
}

/**
 * Turns a build's three files into the four writes that install it, or says
 * why they cannot be installed. Nothing here talks to a board.
 */
export function planFlash(files: FirmwareFiles): FlashPlan {
  requireImage(files.bootloader, 'bootloader');
  requireImage(files.application, 'application image');
  // The bootloader's header says how much flash it expects, and it is written
  // exactly as built -- nothing rewrites that header on the way to the board
  // (flash/esp.ts) -- so a build for another board size has to stop here. A
  // bootloader that believes in 4 MB cannot reach this table's second half.
  const megabytes = 1 << ((files.bootloader[3] ?? 0) >> 4);
  if (megabytes * 1024 * 1024 !== FLASH_BYTES) throw new FlasherError(`the bootloader was built for ${megabytes} MB of flash, not the 8 MB a TMsense node has`);
  const version = tmsenseVersion(files.application);
  if (!version) throw new FlasherError('the application image does not identify itself as TMsense firmware');

  const table = parsePartitionTable(files.partitions);
  const selector = table.find((p) => p.type === TYPE_DATA && p.subtype === SUBTYPE_OTADATA);
  const slot = table.find((p) => p.type === TYPE_APP && p.subtype === SUBTYPE_OTA_0);
  const preserved = table.filter((p) => p.type === TYPE_DATA && (p.subtype === SUBTYPE_NVS || p.subtype === SUBTYPE_NVS_KEYS));
  if (!selector || !slot) throw new FlasherError('the partition table has no boot selector or no first application slot; TMsense needs both');
  if (preserved.length === 0) throw new FlasherError('the partition table has no NVS partition; a node could not keep its settings');
  const boot = bootSelector();
  if (boot.length !== selector.size) throw new FlasherError('the partition table has an unexpected boot selector size');

  // Where each image is allowed to be. The bootloader ends where the table
  // begins, and the table has the one sector before the first partition.
  const allowed: Record<SegmentName, { offset: number; size: number }> = {
    bootloader: { offset: BOOTLOADER_OFFSET, size: PARTITION_TABLE_OFFSET - BOOTLOADER_OFFSET },
    'partition table': { offset: PARTITION_TABLE_OFFSET, size: SECTOR },
    'boot selector': selector,
    application: slot,
  };
  const segments: FlashSegment[] = [
    { name: 'bootloader', address: BOOTLOADER_OFFSET, data: files.bootloader },
    { name: 'partition table', address: PARTITION_TABLE_OFFSET, data: files.partitions },
    { name: 'boot selector', address: selector.offset, data: boot },
    { name: 'application', address: slot.offset, data: files.application },
  ];
  const plan: FlashPlan = { version, segments, preserved, totalBytes: segments.reduce((sum, s) => sum + s.data.length, 0) };
  for (const segment of segments) {
    const region = allowed[segment.name];
    if (segment.data.length === 0) throw new FlasherError(`the ${segment.name} is empty`);
    if (segment.data.length > region.size) {
      throw new FlasherError(`the ${segment.name} (${segment.data.length} bytes) does not fit its ${region.size}-byte region at ${at(region.offset)}`);
    }
  }
  for (const partition of table) {
    if (partition.offset < PARTITION_TABLE_OFFSET + SECTOR || end(partition) > FLASH_BYTES) {
      throw new FlasherError(`partition “${partition.label}” lies outside the board's 8 MB of flash`);
    }
  }
  assertPreserves(plan);
  return plan;
}

/**
 * The check behind "never erases NVS", on what will actually be erased: a
 * write clears whole sectors, so each segment is widened to the sectors it
 * covers before it is compared with the regions that must survive.
 *
 * Exported so the code that drives the loader can run it once more on the
 * plan it was handed, immediately before the first write.
 */
export function assertPreserves(plan: FlashPlan): void {
  const extents = plan.segments.map((s) => ({ name: s.name, offset: s.address, size: sectors(s.data.length) }));
  for (const extent of extents) {
    if (extent.offset % SECTOR !== 0) throw new FlasherError(`the ${extent.name} would not start on a sector boundary`);
    for (const keep of plan.preserved) {
      if (extent.offset < end(keep) && end(extent) > keep.offset) {
        throw new FlasherError(`refusing to flash: the ${extent.name} would erase the “${keep.label}” partition, which holds the node's settings and boot counter`);
      }
    }
    for (const other of extents) {
      if (other !== extent && extent.offset < end(other) && end(extent) > other.offset) {
        throw new FlasherError(`refusing to flash: the ${extent.name} and the ${other.name} overlap`);
      }
    }
  }
}
