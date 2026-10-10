/** Claims about reading the machine: what the numbers mean, and what may be asked of the host. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadEdgeConfig } from '../src/edge/config.js';
import { scanDirectoryUsage } from '../src/infrastructure/analytics/directory-usage.js';
import { cpuShares, diskUsage, HostProbe, parseMeminfo, parseNetDev, parseProcStat } from '../src/infrastructure/analytics/host-probe.js';
import { DEFAULT_UNITS, isUnitName, parseSystemctlShow, SystemdProbe } from '../src/infrastructure/analytics/systemd-probe.js';

const STAT_A = 'cpu  1000 0 500 8000 300 0 100 100 0 0\ncpu0 1000 0 500 8000 300 0 100 100 0 0\nintr 1\n';
const STAT_B = 'cpu  1400 0 700 8500 400 0 100 300 0 0\ncpu0 1400 0 700 8500 400 0 100 300 0 0\nintr 2\n';
const MEMINFO = 'MemTotal:         949000 kB\nMemFree:           60000 kB\nMemAvailable:     410000 kB\nBuffers: 1 kB\nSwapTotal:       2097148 kB\nSwapFree:        1572864 kB\n';
const NETDEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9000000   100    0    0    0     0          0         0  9000000   100    0    0    0     0       0          0
  ens5: 1000000  2000    0    0    0     0          0         0   400000  1500    0    0    0     0       0          0
tailscale0: 50000 10 0 0 0 0 0 0 20000 10 0 0 0 0 0 0
`;

test('host: busy time excludes waiting on disk, and time stolen by the host is its own figure', () => {
  const a = parseProcStat(STAT_A), b = parseProcStat(STAT_B);
  assert.ok(a && b);
  const shares = cpuShares(a, b);
  assert.ok(shares);
  // 1400 ticks passed: 500 idle, 100 iowait, 200 stolen.
  assert.equal(Math.round(shares.busy * 10) / 10, 57.1);
  assert.equal(Math.round(shares.iowait * 10) / 10, 7.1);
  assert.equal(Math.round(shares.steal * 10) / 10, 14.3);
  assert.equal(cpuShares(b, b), null, 'no time passed: no figure, rather than a division by zero');
  assert.equal(parseProcStat('garbage'), null);
});

test('host: memory in use is what is not available, so page cache does not look like a leak', () => {
  const m = parseMeminfo(MEMINFO);
  assert.deepEqual(m, { totalBytes: 949000 * 1024, availableBytes: 410000 * 1024, swapTotalBytes: 2097148 * 1024, swapFreeBytes: 1572864 * 1024 });
  assert.equal(parseMeminfo('MemTotal: 5 kB\n'), null);
});

test('host: network totals leave loopback out', () => {
  assert.deepEqual(parseNetDev(NETDEV), { rxBytes: 1_050_000, txBytes: 420_000 });
  assert.equal(parseNetDev('nothing here'), null);
});

test('host: the first sample has no processor or network figure, because both are differences', () => {
  const files: Record<string, string> = { '/proc/stat': STAT_A, '/proc/meminfo': MEMINFO, '/proc/net/dev': NETDEV };
  const probe = new HostProbe((path) => files[path] ?? null);
  const first = probe.sample(1_000_000);
  assert.equal(first.cpuBusyPercent, null);
  assert.equal(first.netRxBytesPerSec, null);
  assert.equal(first.memory.availableBytes, 410000 * 1024);
  files['/proc/stat'] = STAT_B;
  files['/proc/net/dev'] = NETDEV.replace('1000000  2000', '1200000  2000');
  const second = probe.sample(1_010_000);
  assert.equal(Math.round(second.cpuBusyPercent ?? 0), 57);
  assert.equal(Math.round(second.cpuStealPercent ?? 0), 14);
  assert.equal(second.netRxBytesPerSec, 20_000);
  assert.equal(second.netTxBytesPerSec, 0);
});

test('host: where /proc is absent the unmeasurable figures are unknown, not zero', () => {
  const probe = new HostProbe(() => null);
  probe.sample(1000);
  const sample = probe.sample(2000);
  assert.equal(sample.cpuStealPercent, null);
  assert.equal(sample.cpuIowaitPercent, null);
  assert.equal(sample.netRxBytesPerSec, null);
  assert.equal(sample.memory.swapTotalBytes, null);
  assert.ok(sample.memory.totalBytes > 0);
});

test('host: one volume is reported once, and its figures add up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-disk-'));
  const disks = await diskUsage(dir, dir);
  assert.equal(disks.length, 1);
  assert.equal(disks[0]?.label, 'System and data volume');
  assert.ok((disks[0]?.usedPercent ?? -1) >= 0 && (disks[0]?.usedPercent ?? 101) <= 100);
  assert.deepEqual(await diskUsage(join(dir, 'missing'), join(dir, 'also-missing')), [], 'an unreadable volume is absent, never reported as empty');
});

test('storage: the breakdown counts by top-level directory, does not follow links, and admits when it stopped early', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-usage-'));
  const outside = mkdtempSync(join(tmpdir(), 'tm-outside-'));
  writeFileSync(join(outside, 'huge'), Buffer.alloc(512 * 1024));
  mkdirSync(join(root, 'recordings', '2026-10-10'), { recursive: true });
  mkdirSync(join(root, 'firmware'));
  writeFileSync(join(root, 'recordings', '2026-10-10', 'a.jsonl'), Buffer.alloc(64 * 1024, 1));
  writeFileSync(join(root, 'recordings', 'b.jsonl'), Buffer.alloc(32 * 1024, 1));
  writeFileSync(join(root, 'firmware', 'image.bin'), Buffer.alloc(8 * 1024, 1));
  writeFileSync(join(root, 'users.json'), '[]');
  symlinkSync(outside, join(root, 'recordings', 'link-out'));
  const scan = await scanDirectoryUsage(root);
  assert.equal(scan.truncated, false);
  assert.deepEqual(scan.entries.map((e) => e.name), ['recordings', 'firmware', '(files)']);
  const recordings = scan.entries[0];
  assert.equal(recordings?.files, 2);
  assert.ok((recordings?.bytes ?? 0) >= 96 * 1024 && (recordings?.bytes ?? 0) < 400 * 1024, 'the linked 512 KB outside the directory is not counted');
  const cut = await scanDirectoryUsage(root, { maxEntries: 2, maxMs: 60_000, yieldEvery: 1 });
  assert.equal(cut.truncated, true);
  assert.deepEqual((await scanDirectoryUsage(join(root, 'nope'))).entries, []);
});

test('units: only units that exist are listed, and "became active" needs no date parsing', () => {
  const text = [
    'Id=tmedge-edge.service\nDescription=TMedge edge\nLoadState=loaded\nActiveState=active\nSubState=running\nActiveEnterTimestampMonotonic=7200000000\nNRestarts=2\nMemoryCurrent=152043520',
    'Id=tmedge-sim.service\nDescription=tmedge-sim.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nActiveEnterTimestampMonotonic=0\nNRestarts=0\nMemoryCurrent=[not set]',
    'Id=tmedge-prune.timer\nDescription=Prune\nLoadState=loaded\nActiveState=failed\nSubState=failed\nActiveEnterTimestampMonotonic=0\nNRestarts=0\nMemoryCurrent=18446744073709551615',
  ].join('\n\n');
  const units = parseSystemctlShow(text, 10_000, 1_000_000_000);
  assert.deepEqual(units.map((u) => u.unit), ['tmedge-edge.service', 'tmedge-prune.timer'], 'a unit this machine does not have is not shown as stopped');
  // Up 10 000 s, active since 7 200 s after boot: 2 800 s ago.
  assert.equal(units[0]?.activeSince, 1_000_000_000 - 2_800_000);
  assert.equal(units[0]?.memoryBytes, 152043520);
  assert.equal(units[0]?.restarts, 2);
  assert.equal(units[1]?.activeSince, null);
  assert.equal(units[1]?.memoryBytes, null, 'systemd\'s "not tracked" value is not a memory figure');
});

test('units: a name is a plain unit name or it is refused, before anything is run', () => {
  for (const good of [...DEFAULT_UNITS, 'postgresql@17-main.service']) assert.ok(isUnitName(good), good);
  for (const bad of ['', '--user', '-H=evil', 'a b', 'x;reboot', '$(id)', '../etc/passwd', 'a'.repeat(129)]) assert.ok(!isUnitName(bad), bad);
  assert.deepEqual(new SystemdProbe(['ok.service', '--help', 'x y']).units, ['ok.service']);
  const env = { TM_KEY: 'k', WEB_PUSH_URLS: '' };
  assert.throws(() => loadEdgeConfig({ ...env, ANALYTICS_UNITS: 'tmedge-edge.service,--now' }), /ANALYTICS_UNITS/);
  assert.throws(() => loadEdgeConfig({ ...env, ANALYTICS_TIMEZONE: 'Mars/Olympus' }), /ANALYTICS_TIMEZONE/);
  assert.deepEqual(loadEdgeConfig({ ...env, ANALYTICS_UNITS: 'a.service, b.timer' }).analytics, { timeZone: 'Asia/Hong_Kong', units: ['a.service', 'b.timer'] });
  assert.deepEqual(loadEdgeConfig(env).analytics?.units, [...DEFAULT_UNITS]);
});
