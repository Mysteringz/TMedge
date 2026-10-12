/**
 * The web flasher's core, without a browser or a board: what it sends to a
 * node's console, what it believes back, and where it will and will not
 * write flash. The node is test/fake-tmsense.ts.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bootSelector, parsePartitionTable, planFlash, tmsenseVersion, type FirmwareFiles } from '../src/shared/flasher/images.js';
import { md5Hex } from '../src/shared/flasher/md5.js';
import { FlasherError, provisionNode, type Admission, type ProvisionStage } from '../src/shared/flasher/node-console.js';
import { canonicalCloudUrl, cloudUrlProblem, EMPTY_SETTINGS, nodeIdProblems, provisioningCommands, settingsProblems, type NodeSettings } from '../src/shared/flasher/settings.js';
import { FakeTmsense, VirtualLink } from './fake-tmsense.js';

const UID = '30:ed:a0:11:22:0b';
const WIFI: NodeSettings = { ...EMPTY_SETTINGS, ssid: 'Maker Space', password: 'correct horse', gateway: '192.0.2.10', key: 'k'.repeat(40), frameRate: 2 };

function run(node: FakeTmsense, id: number, settings: NodeSettings, admit?: () => Promise<Admission>) {
  const link = new VirtualLink(node);
  const log: string[] = [];
  const stages: ProvisionStage[] = [];
  node.reset(0);
  const result = provisionNode(link, id, settings, {
    log: (line) => log.push(line), stage: (stage) => stages.push(stage), now: link.now, ...(admit ? { admit } : {}),
  });
  return { link, log, stages, result };
}

test('a fresh node is given its ID, network, key and rate, saved, read back and seen joining Wi-Fi', async () => {
  const node = new FakeTmsense(UID);
  const { result, stages } = run(node, 11, WIFI);
  const done = await result;
  assert.deepEqual(node.received.filter((line) => line !== 'show'), [
    'set id 11', 'set mode wifi', 'set ssid Maker Space', 'set pass correct horse', 'set edges 192.0.2.10',
    'set transport udp', `set key ${'k'.repeat(40)}`, 'set fps 2', 'save', 'reboot',
  ]);
  assert.equal(node.saved.node_id, '11');
  assert.equal(node.saved.ssid, 'Maker Space');
  assert.equal(node.saved.fps, '2');
  assert.equal(done.info.uid, UID);
  assert.equal(done.ip, '192.168.0.11');
  assert.equal(done.edgeAccepted, null, 'UDP has no acknowledgement, so none is claimed');
  assert.deepEqual(done.warnings, []);
  assert.deepEqual(stages, ['provisioning', 'joining-wifi']);
});

test('the Wi-Fi password and the signing key never reach the log', async () => {
  const node = new FakeTmsense(UID);
  const { result, log } = run(node, 3, WIFI);
  await result;
  const text = log.join('\n');
  assert.ok(text.includes('set pass ••••••') && text.includes('set key ••••••'), 'the commands are shown, masked');
  assert.ok(!text.includes(WIFI.password) && !text.includes(WIFI.key));

  // Even a node that echoed its input back in an error would not get a secret onto the screen.
  const rude = new FakeTmsense(UID);
  rude.handle = (line: string) => line.startsWith('set pass') ? [`invalid: ${line}`] : FakeTmsense.prototype.handle.call(rude, line, 1e9);
  const second = run(rude, 3, WIFI);
  await assert.rejects(second.result, (error: Error) => !error.message.includes(WIFI.password) || assert.fail('the refusal carried the password'));
  assert.ok(!second.log.join('\n').includes(WIFI.password));
});

test('a board that says nothing fails, and fails in bounded time, rather than hanging', async () => {
  const node = new FakeTmsense(UID);
  node.silent = true;
  const { result, link } = run(node, 3, WIFI);
  await assert.rejects(result, /no answer from TMsense firmware within 25 s/);
  assert.ok(link.time >= 25_000 && link.time < 30_000);
  assert.deepEqual(node.received, []);
});

test('a setting the node refuses stops the job before save, and one it silently dropped is caught by reading back', async () => {
  const refusing = new FakeTmsense(UID);
  refusing.refuse = 'edges';
  await assert.rejects(run(refusing, 3, WIFI).result, /node refused `set edges 192\.0\.2\.10`: invalid: edges/);
  assert.ok(!refusing.received.includes('save') && !refusing.received.includes('reboot'));
  assert.equal(refusing.saved.ssid, '(unset)', 'nothing half-applied was made permanent');

  const forgetful = new FakeTmsense(UID);
  forgetful.forget = 'ssid';
  await assert.rejects(run(forgetful, 3, WIFI).result, /verification failed: SSID was not stored/);
  assert.ok(!forgetful.received.includes('reboot'));
});

test('firmware is asked what it can do before anything is written', async () => {
  const old = new FakeTmsense(UID);
  old.directCloud = false; old.frameRateSelection = false;
  await assert.rejects(run(old, 3, { ...WIFI, frameRate: null, transport: 'wss', cloudUrl: 'wss://sense.example.com/tmnode' }).result, /tmsense-1\.1 has no direct-to-cloud transport/);
  assert.deepEqual(old.received, ['show'], 'refused before any set');

  const noRate = new FakeTmsense(UID);
  noRate.frameRateSelection = false;
  await assert.rejects(run(noRate, 3, WIFI).result, /tmsense-1\.4 has no frame-rate selection: flash TMsense 1\.6 or newer/);
  assert.deepEqual(noRate.received, ['show']);

  // The same old firmware over UDP is fine, and is never sent a command it does not know.
  const plain = new FakeTmsense(UID);
  plain.directCloud = false; plain.frameRateSelection = false;
  await run(plain, 3, { ...WIFI, frameRate: null }).result;
  assert.ok(!plain.received.some((line) => line.startsWith('set transport') || line.startsWith('set fps')));
});

test('direct cloud: Wi-Fi joined is not success, only the edge accepting a report is', async () => {
  const cloud: NodeSettings = { ...WIFI, transport: 'wss', cloudUrl: 'WSS://Sense.Example.com:443/tmnode' };
  const node = new FakeTmsense(UID);
  const ok = run(node, 3, cloud);
  const done = await ok.result;
  const sent = node.received;
  assert.ok(sent.indexOf('set cloud_url wss://sense.example.com/tmnode') < sent.indexOf('set transport wss'), 'the URL goes first, in the form the firmware stores');
  assert.equal(done.edgeAccepted, true);
  assert.deepEqual(ok.stages, ['provisioning', 'joining-wifi', 'reaching-edge']);

  const refused = new FakeTmsense(UID);
  refused.edgeAccepts = false;
  const bad = await run(refused, 3, cloud).result;
  assert.equal(bad.ip, '192.168.0.11');
  assert.equal(bad.edgeAccepted, false);
  assert.match(bad.warnings.join('\n'), /joined Wi-Fi, but TMedge did not accept a report within 90 s \(last error: tls: certificate refused\)/);
});

test('the edge is asked to admit the node after its settings are saved and before it is told to connect', async () => {
  const node = new FakeTmsense(UID);
  let askedAfter: string[] = [];
  const admitted = await run(node, 3, WIFI, async () => { askedAfter = [...node.received]; return { state: 'registered' }; }).result;
  assert.ok(askedAfter.includes('save') && !askedAfter.includes('reboot'));
  assert.deepEqual(admitted.admission, { state: 'registered' });

  await assert.rejects(run(new FakeTmsense(UID), 3, WIFI, async () => ({ state: 'denied' })).result, /TMedge turned down the request to admit 30:ed:a0:11:22:0b/);
  await assert.rejects(run(new FakeTmsense(UID), 3, WIFI, async () => ({ state: 'failed', reason: 'adoption storage is unavailable' })).result,
    /TMedge admission failed: adoption storage is unavailable/);

  // Not yet answered is not a refusal -- and there is no point waiting for an
  // acknowledgement from an edge that has not admitted the node.
  const waiting = new FakeTmsense(UID);
  const pending = run(waiting, 3, { ...WIFI, transport: 'wss', cloudUrl: 'wss://sense.example.com/tmnode' }, async () => ({ state: 'pending' }));
  const result = await pending.result;
  assert.equal(result.edgeAccepted, null);
  assert.ok(!pending.stages.includes('reaching-edge'));
  assert.match(result.warnings.join('\n'), /TMedge has not admitted 30:ed:a0:11:22:0b yet/);
});

test('blank fields keep what the node already has', async () => {
  const node = new FakeTmsense(UID);
  await run(node, 3, WIFI).result;
  node.received.length = 0;
  const again = await run(node, 4, EMPTY_SETTINGS).result;
  assert.deepEqual(node.received.filter((line) => line !== 'show'), ['set id 4', 'set mode wifi', 'set transport udp', 'save', 'reboot']);
  assert.equal(node.saved.ssid, 'Maker Space');
  assert.equal(node.saved.password, '(set)');
  assert.equal(node.saved.fps, '2');
  assert.equal(again.info.nodeId, 4);
});

test('LoRa stores its gateway, leaves direct cloud first, and says it cannot send yet', async () => {
  const node = new FakeTmsense(UID);
  await run(node, 3, { ...WIFI, transport: 'wss', cloudUrl: 'wss://sense.example.com/tmnode' }).result;
  node.received.length = 0;
  const lora = await run(node, 3, { ...EMPTY_SETTINGS, mode: 'lora', gateway: '192.0.2.20' }).result;
  assert.deepEqual(node.received.filter((line) => line !== 'show'), ['set id 3', 'set transport udp', 'set mode lora', 'set lora_gw 192.0.2.20', 'save', 'reboot']);
  assert.equal(node.saved.lora_gw, '192.0.2.20');
  assert.match(lora.warnings.join('\n'), /no LoRa uplink yet/);
});

test('settings that would not survive the console are refused before a node is touched', () => {
  const problems = (change: Partial<NodeSettings>) => settingsProblems({ ...EMPTY_SETTINGS, ...change });
  assert.deepEqual(problems(WIFI), []);
  // A line break would end the command and run the rest as another one.
  assert.match(problems({ ssid: 'cafe\nfactory' }).join(), /SSID cannot contain a line break/);
  assert.match(problems({ key: 'abc\rreboot' }).join(), /Signing key cannot contain a line break/);
  assert.match(problems({ ssid: '咖'.repeat(11) }).join(), /SSID is longer than 32 bytes/);
  assert.deepEqual(problems({ ssid: '咖'.repeat(10) }), []);
  assert.match(problems({ ssid: ' padded' }).join(), /starts or ends with a space/);
  assert.match(problems({ password: 'short' }).join(), /8–63 characters/);
  assert.match(problems({ gateway: '192.168.0.300' }).join(), /TMWAccess IP “192\.168\.0\.300” is not an IPv4 address/);
  assert.match(problems({ gateway: '192.168.0.01' }).join(), /not an IPv4 address/);
  assert.match(problems({ mode: 'lora', gateway: 'gateway.local' }).join(), /TMLAccess IP/);
  assert.match(problems({ key: 'two words' }).join(), /cannot contain spaces/);
  assert.match(problems({ mode: 'lora', transport: 'wss' }).join(), /LoRa has no direct-cloud transport/);
  assert.deepEqual(nodeIdProblems(null), ['Enter a node ID']);
  assert.deepEqual(nodeIdProblems(65535), []);
  assert.equal(nodeIdProblems(0).length + nodeIdProblems(65536).length + nodeIdProblems(1.5).length, 3);
  // The longest allowed command still fits the firmware's 160-byte line.
  const longest = provisioningCommands(65535, { ...EMPTY_SETTINGS, cloudUrl: `wss://${'a'.repeat(100)}.example/${'p'.repeat(13)}`, transport: 'wss' }, true);
  assert.ok(longest.every((command) => Buffer.byteLength(command.line) < 160));
});

test('a cloud URL is refused here for the reasons the firmware would refuse it', () => {
  assert.equal(cloudUrlProblem('wss://sense.example.com/tmnode'), null);
  assert.equal(canonicalCloudUrl(' WSS://Sense.Example.COM:443/tmnode '), 'wss://sense.example.com/tmnode');
  for (const [url, why] of [
    ['ws://sense.example.com/tmnode', /must start with wss/], ['wss://sense.example.com', /needs a path/],
    ['wss://sense.example.com:8443/tmnode', /port must be 443/], ['wss://user@sense.example.com/tmnode', /user name or password/],
    ['wss://sense.example.com/tmnode?x=1', /query or fragment/], ['wss://192.0.2.1/tmnode', /lowercase DNS name/],
    ['wss://Sense.example.com/tmnode', /lowercase DNS name/], ['wss://sense.example.com/a/../b', /path must be like/],
    ['wss://sense.example.com/tm node', /printable ASCII/], [`wss://sense.example.com/${'a'.repeat(120)}`, /1–128 characters/],
  ] as const) assert.match(cloudUrlProblem(url) ?? '', why, url);
});

// --- what is written to flash, and where ------------------------------------

const NVS = { label: 'nvs', type: 1, subtype: 2, offset: 0x9000, size: 0x5000 };
const OTADATA = { label: 'otadata', type: 1, subtype: 0, offset: 0xe000, size: 0x2000 };
const APP0 = { label: 'app0', type: 0, subtype: 0x10, offset: 0x10000, size: 0x330000 };
const APP1 = { label: 'app1', type: 0, subtype: 0x11, offset: 0x340000, size: 0x330000 };
type Entry = typeof NVS;

function table(entries: Entry[], options: { checksum?: boolean } = {}): Uint8Array {
  const out = Buffer.alloc(0xc00, 0xff);
  entries.forEach((entry, index) => {
    const at = index * 32;
    out.fill(0, at, at + 32);
    out.writeUInt16LE(0x50aa, at);
    out[at + 2] = entry.type; out[at + 3] = entry.subtype;
    out.writeUInt32LE(entry.offset, at + 4); out.writeUInt32LE(entry.size, at + 8);
    out.write(entry.label, at + 12, 'latin1');
  });
  if (options.checksum !== false) {
    const at = entries.length * 32;
    out.writeUInt16LE(0xebeb, at);
    createHash('md5').update(out.subarray(0, at)).digest().copy(out, at + 16);
  }
  return out;
}

function image(bytes: number, chip = 9, text = ''): Uint8Array {
  const out = Buffer.alloc(bytes, 0x5a);
  // Magic, then (as PlatformIO builds for this board) DIO, 8 MB at 80 MHz.
  out[0] = 0xe9; out[2] = 0x02; out[3] = 0x3f; out.writeUInt16LE(chip, 12);
  out.write(text, 0x200, 'latin1');
  return out;
}

const build = (change: Partial<FirmwareFiles> = {}): FirmwareFiles => ({
  bootloader: image(15104), partitions: table([NVS, OTADATA, APP0, APP1]), application: image(960_000, 9, '=== TMsense %s ===\0tmsense-1.6\0'), ...change,
});

test('a build becomes four writes, and none of them reaches NVS', () => {
  const plan = planFlash(build());
  assert.equal(plan.version, 'tmsense-1.6');
  assert.deepEqual(plan.segments.map((s) => [s.name, s.address, s.data.length]), [
    ['bootloader', 0x0, 15104], ['partition table', 0x8000, 0xc00], ['boot selector', 0xe000, 0x2000], ['application', 0x10000, 960_000],
  ]);
  assert.deepEqual(plan.preserved.map((p) => [p.label, p.offset, p.size]), [['nvs', 0x9000, 0x5000]]);
  for (const segment of plan.segments) {
    const erased = Math.ceil(segment.data.length / 0x1000) * 0x1000;
    assert.ok(segment.address + erased <= 0x9000 || segment.address >= 0xe000, `${segment.name} stays clear of NVS, sector rounding included`);
  }
});

test('a plan that would erase the node’s settings is refused, not trimmed', () => {
  const refuses = (files: FirmwareFiles, why: RegExp) => assert.throws(() => planFlash(files), (error: unknown) => error instanceof FlasherError && why.test(error.message), String(why));
  // NVS where the boot selector lands, where the application lands, and across the table's own sector.
  refuses(build({ partitions: table([{ ...NVS, offset: 0xd000, size: 0x2000 }, OTADATA, APP0]) }), /the boot selector would erase the “nvs” partition/);
  refuses(build({ partitions: table([NVS, OTADATA, APP0, { ...NVS, label: 'nvs_keys', subtype: 4, offset: 0x20000, size: 0x1000 }]) }), /the application would erase the “nvs_keys” partition/);
  refuses(build({ partitions: table([{ ...NVS, offset: 0x8000 }, OTADATA, APP0]) }), /outside the board's 8 MB|would erase the “nvs” partition/);
  // A bootloader that would run into the partition table, and an application bigger than its slot.
  refuses(build({ bootloader: image(0x8001) }), /bootloader \(32769 bytes\) does not fit/);
  refuses(build({ application: image(0x330001, 9, 'tmsense-1.6') }), /application \(3342337 bytes\) does not fit/);
  refuses(build({ partitions: table([NVS, OTADATA]) }), /no boot selector or no first application slot/);
  refuses(build({ partitions: table([OTADATA, APP0]) }), /no NVS partition/);
  refuses(build({ partitions: table([NVS, OTADATA, { ...APP0, size: 0x900000 }]) }), /outside the board's 8 MB/);
});

test('only TMsense firmware for this chip is accepted', () => {
  const refuses = (files: FirmwareFiles, why: RegExp) => assert.throws(() => planFlash(files), why);
  refuses(build({ application: image(960_000, 9, 'some other firmware') }), /does not identify itself as TMsense firmware/);
  refuses(build({ application: image(960_000, 0, 'tmsense-1.6') }), /built for a different chip/);
  refuses(build({ bootloader: image(15104, 5) }), /bootloader was built for a different chip/);
  const fourMegabytes = Buffer.from(image(15104));
  fourMegabytes[3] = 0x2f;
  refuses(build({ bootloader: fourMegabytes }), /bootloader was built for 4 MB of flash, not the 8 MB/);
  refuses(build({ application: Buffer.from('not an image at all, just some text that is long enough') }), /not an ESP32 image/);
  refuses(build({ partitions: table([NVS, OTADATA, APP0], { checksum: false }) }), /no checksum/);
  const damaged = Buffer.from(table([NVS, OTADATA, APP0]));
  damaged.writeUInt8(damaged.readUInt8(5) ^ 0x10, 5);   // NVS moved by a flipped bit
  refuses(build({ partitions: damaged }), /damaged \(its checksum does not match\)/);
  refuses(build({ partitions: Buffer.alloc(100) }), /wrong size/);
  assert.equal(tmsenseVersion(image(4096, 9, 'tmsense-1.10.2-rc')), 'tmsense-1.10', 'at most the 12 characters the firmware allows');
  assert.equal(tmsenseVersion(image(4096, 9, 'tmsense-')), null);
});

test('the boot selector is the one PlatformIO flashes, and MD5 is MD5', () => {
  // SHA-256 of framework-arduinoespressif32/tools/partitions/boot_app0.bin.
  assert.equal(createHash('sha256').update(bootSelector()).digest('hex'), 'f94c5d786a7a8fab06ac5d10e33bf37711a6697636dc037559ea19cc410a17f0');
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 4096, 100_003]) {
    const data = Buffer.alloc(length);
    for (let i = 0; i < length; i++) data[i] = (i * 131 + length) & 0xff;
    assert.equal(md5Hex(data), createHash('md5').update(data).digest('hex'), `${length} bytes`);
  }
});

test('nothing in the web flasher can erase a board, or its saved settings', () => {
  // The plan refuses to reach NVS; this is the other half -- that no code
  // path asks the loader for an erase, or the node to forget its settings.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sources = [...readdirSync(join(root, 'algo-app', 'src', 'console', 'flash')).map((name) => join(root, 'algo-app', 'src', 'console', 'flash', name)),
    join(root, 'algo-app', 'src', 'console', 'Flash.tsx'), ...readdirSync(join(root, 'src', 'shared', 'flasher')).map((name) => join(root, 'src', 'shared', 'flasher', name))];
  assert.ok(sources.length >= 8);
  const code = sources.map((path) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).join('\n');
  assert.match(code, /eraseAll: false/, 'the one write is told not to erase');
  for (const forbidden of [/eraseFlash/, /eraseAll:\s*true/, /erase_flash/, /['"`]factory/, /flashFinish\(true/]) assert.doesNotMatch(code, forbidden);
});

// The claim that matters most about offsets -- that a browser reading the
// partition table arrives where PlatformIO does -- checked against a real
// build when one is on this machine. CI has no toolchain and skips it.
const realBuild = join(process.env.TMSENSE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'TMsense'), '.pio', 'build', 'tmflash');
test('on a real TMsense build, the plan matches PlatformIO’s own flash metadata', { skip: !existsSync(join(realBuild, 'idedata.json')) && 'no local PlatformIO build of ../TMsense with idedata.json (pio run -e tmflash -t idedata; or set TMSENSE_DIR)' }, () => {
  const metadata = JSON.parse(readFileSync(join(realBuild, 'idedata.json'), 'utf8')) as { extra: { flash_images: { offset: string; path: string }[]; application_offset: string } };
  const plan = planFlash({
    bootloader: readFileSync(join(realBuild, 'bootloader.bin')), partitions: readFileSync(join(realBuild, 'partitions.bin')), application: readFileSync(join(realBuild, 'firmware.bin')),
  });
  const expected = [...metadata.extra.flash_images.map((entry) => ({ address: Number(entry.offset), bytes: readFileSync(entry.path) })),
    { address: Number(metadata.extra.application_offset), bytes: readFileSync(join(realBuild, 'firmware.bin')) }];
  assert.deepEqual(plan.segments.map((s) => s.address), expected.map((e) => e.address));
  plan.segments.forEach((segment, index) => assert.ok(Buffer.from(segment.data).equals(expected[index]?.bytes ?? Buffer.alloc(0)), `${segment.name} is byte-identical`));
  assert.match(plan.version, /^tmsense-\d/);
  assert.ok(parsePartitionTable(readFileSync(join(realBuild, 'partitions.bin'))).some((p) => p.label === 'nvs'));
});
