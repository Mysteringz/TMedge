/**
 * Claims about the analytics stores: what a gap means, what survives a
 * restart, and what is never written down.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BucketLog } from '../src/infrastructure/analytics/bucket-log.js';
import { CounterLog } from '../src/modules/analytics/application/counter-log.js';
import { DistinctDays } from '../src/modules/analytics/application/distinct-days.js';
import { MetricHistory } from '../src/modules/analytics/application/metric-history.js';
import { dayKey, weekHour } from '../src/shared/analytics.js';

const T0 = Date.UTC(2026, 9, 10, 4, 0, 0); // Saturday 12:00 in Hong Kong
const HK = 'Asia/Hong_Kong';
const dir = () => mkdtempSync(join(tmpdir(), 'tm-analytics-'));
const values = (h: MetricHistory, tier: 'raw' | 'minute' | 'quarter', from: number, to: number, step: number, key: string, stat?: 'avg' | 'max') =>
  h.frame(tier, from, to, step, [{ key, label: key, stat }]).series[0]?.values ?? [];

test('history: a stretch nothing was measured in is a gap, never a zero', () => {
  const h = new MetricHistory('t', new BucketLog(null), T0);
  h.record(T0, { cpu: 40 });
  h.record(T0 + 10_000, { cpu: 60 });
  // Five minutes of silence: the sampler was not running.
  h.record(T0 + 300_000, { cpu: 20 });
  const raw = values(h, 'raw', T0, T0 + 310_000, 10_000, 'cpu');
  assert.deepEqual(raw.slice(0, 3), [40, 60, null]);
  assert.equal(raw[30], 20);
  assert.ok(raw.slice(2, 30).every((v) => v === null), 'the silent minutes must not be drawn along zero');
  const minutes = values(h, 'minute', T0, T0 + 360_000, 60_000, 'cpu');
  assert.deepEqual(minutes, [50, null, null, null, null, 20]);
});

test('history: a value that could not be measured is skipped without disturbing the others', () => {
  const h = new MetricHistory('t', new BucketLog(null), T0);
  h.record(T0, { cpu: 10, steal: null, bad: NaN });
  assert.deepEqual(values(h, 'raw', T0, T0 + 10_000, 10_000, 'cpu'), [10]);
  assert.deepEqual(values(h, 'raw', T0, T0 + 10_000, 10_000, 'steal'), [null]);
  assert.deepEqual(values(h, 'raw', T0, T0 + 10_000, 10_000, 'bad'), [null]);
});

test('history: a coarser step is the mean of what exists and keeps the true peak', () => {
  const h = new MetricHistory('t', new BucketLog(null), T0);
  for (let i = 0; i < 6; i++) h.record(T0 + i * 10_000, { cpu: i === 3 ? 100 : 10 });
  h.record(T0 + 120_000, { cpu: 30 });
  assert.deepEqual(values(h, 'minute', T0, T0 + 300_000, 300_000, 'cpu'), [27.5]);
  assert.deepEqual(values(h, 'minute', T0, T0 + 300_000, 300_000, 'cpu', 'max'), [100]);
});

test('history: a restart keeps the day so far and carries on inside the minute it stopped in', async () => {
  const d = dir();
  const first = new MetricHistory('edge', new BucketLog(d), T0);
  first.record(T0, { cpu: 10 });
  first.record(T0 + 60_000, { cpu: 20 });
  first.record(T0 + 120_000, { cpu: 40 });
  await first.close();
  const second = new MetricHistory('edge', new BucketLog(d), T0 + 130_000);
  assert.deepEqual(values(second, 'minute', T0, T0 + 180_000, 60_000, 'cpu'), [10, 20, 40]);
  // Same minute as the stop: the two samples average, the earlier one is not lost.
  second.record(T0 + 130_000, { cpu: 60 });
  assert.deepEqual(values(second, 'minute', T0 + 120_000, T0 + 180_000, 60_000, 'cpu'), [50]);
  assert.equal(second.earliest, T0 - (T0 % 900_000));
  // The ten-second tier is memory only by design: an hour of it is not worth a file.
  assert.deepEqual(values(second, 'raw', T0, T0 + 10_000, 10_000, 'cpu'), [null]);
  await second.close();
});

test('history: a saved in-progress bucket is used once, so a crash cannot replay it over finished data', async () => {
  const d = dir();
  const first = new MetricHistory('edge', new BucketLog(d), T0);
  first.record(T0, { cpu: 10 });
  await first.close();
  assert.ok(readdirSync(d).some((f) => f.endsWith('.state.json')));
  const second = new MetricHistory('edge', new BucketLog(d), T0 + 5000);
  assert.ok(!readdirSync(d).some((f) => f.endsWith('.state.json')), 'state is consumed on start');
  second.record(T0 + 5000, { cpu: 30 });
  second.record(T0 + 60_000, { cpu: 99 }); // finishes the first minute, then the process dies without close()
  await new BucketLog(d).flush();
  await new Promise((r) => setTimeout(r, 50));
  const third = new MetricHistory('edge', new BucketLog(d), T0 + 70_000);
  assert.deepEqual(values(third, 'minute', T0, T0 + 60_000, 60_000, 'cpu'), [20]);
});

test('counters: an hour nobody searched in is a real zero, and adjacent ranges never count a bucket twice', () => {
  const c = new CounterLog('web', new BucketLog(null), T0);
  c.add(T0 + 60_000, 'search');
  c.add(T0 + 61_000, 'search');
  c.add(T0 + 2 * 3_600_000 + 5, 'search');
  const frame = c.frame('hour', T0, T0 + 3 * 3_600_000, 3_600_000, [{ key: 'search', label: 'Searches' }]);
  assert.deepEqual(frame.series[0]?.values, [2, 0, 1]);
  assert.equal(c.sum('hour', T0, T0 + 3_600_000, 'search') + c.sum('hour', T0 + 3_600_000, T0 + 3 * 3_600_000, 'search'), 3);
  assert.deepEqual([...c.sumByPrefix('hour', T0, T0 + 3 * 3_600_000, 'sea')], [['rch', 3]]);
});

test('counters: a day is the campus day, so an event at 01:00 Hong Kong time belongs to that date', () => {
  const lateUtc = Date.UTC(2026, 9, 9, 17, 0, 0); // 9 Oct 17:00 UTC = 10 Oct 01:00 HKT
  assert.equal(dayKey(lateUtc, HK), '2026-10-10');
  assert.deepEqual(weekHour(lateUtc, HK), { weekday: 5, hour: 1 });
  assert.deepEqual(weekHour(Date.UTC(2026, 9, 11, 16, 0, 0), HK), { weekday: 0, hour: 0 }, 'midnight is hour 0 of the next day');
  const c = new CounterLog('web', new BucketLog(null), lateUtc - 3 * 3_600_000);
  c.add(lateUtc - 2 * 3_600_000, 'search'); // 9 Oct 23:00 HKT
  c.add(lateUtc, 'search');
  const daily = c.daily(lateUtc - 3 * 3_600_000, lateUtc + 3_600_000, HK, [{ key: 'search', label: 'Searches' }]);
  assert.deepEqual(daily.series[0]?.values, [1, 1]);
  assert.equal(daily.daily, true);
});

test('counters: the open hour survives a restart and a finished hour is written once', async () => {
  const d = dir();
  const first = new CounterLog('web', new BucketLog(d), T0);
  first.add(T0 + 1000, 'search', 3);
  await first.close(T0 + 2000);
  const second = new CounterLog('web', new BucketLog(d), T0 + 3000);
  second.add(T0 + 4000, 'search');
  assert.equal(second.sum('hour', T0, T0 + 3_600_000, 'search'), 4);
  second.tick(T0 + 3_600_000 + 1); // the hour ends
  await second.close(T0 + 3_600_000 + 2);
  const third = new CounterLog('web', new BucketLog(d), T0 + 3_600_000 + 10);
  assert.equal(third.sum('hour', T0, T0 + 3_600_000, 'search'), 4);
  assert.equal(third.earliest, T0);
});

test('counters: a flood of made-up names cannot grow one bucket without bound', () => {
  const c = new CounterLog('web', new BucketLog(null), T0);
  for (let i = 0; i < 2000; i++) c.add(T0, `floor.invented-${i}`);
  const names = c.sumByPrefix('hour', T0, T0 + 3_600_000, '');
  assert.ok(names.size <= 512);
  assert.equal([...names.values()].reduce((a, b) => a + b, 0), 2000, 'the events are still counted, under "other"');
});

test('active students: the same person twice is one, and what is kept cannot name them', async () => {
  const d = dir();
  const key = Buffer.alloc(32, 7);
  const days = new DistinctDays('web', new BucketLog(d), HK, key, T0);
  days.mark(T0, 'alice@connect.hku.hk');
  days.mark(T0 + 5000, 'alice@connect.hku.hk');
  days.mark(T0 + 6000, 'bob@connect.hku.hk');
  assert.equal(days.count('2026-10-10'), 2);
  days.mark(T0 + 86_400_000, 'alice@connect.hku.hk'); // next day: finishes the first
  assert.equal(days.across(7, T0 + 86_400_000), 2, 'a returning student is still one student this week');
  assert.deepEqual(days.perDay(2, T0 + 86_400_000), [{ day: '2026-10-10', students: 2 }, { day: '2026-10-11', students: 1 }]);
  await days.close(T0 + 86_400_000);
  const written = readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')).join('\n');
  for (const secret of ['alice', 'bob', 'connect.hku.hk', '@']) assert.ok(!written.includes(secret), `"${secret}" must not reach the disk`);
  const restarted = new DistinctDays('web', new BucketLog(d), HK, key, T0 + 86_400_000 + 1000);
  assert.equal(restarted.count('2026-10-10'), 2);
  assert.equal(restarted.count('2026-10-11'), 1);
  await restarted.close(T0 + 86_400_000 + 1500);
  // A different key (another deployment's secret) cannot match these hashes to its own students.
  const stranger = new DistinctDays('web', new BucketLog(d), HK, Buffer.alloc(32, 8), T0 + 86_400_000 + 2000);
  stranger.mark(T0 + 86_400_000 + 2000, 'alice@connect.hku.hk');
  assert.equal(stranger.count('2026-10-11'), 2);
});

test('active students: stopping before midnight and starting after it still keeps the finished day', async () => {
  const d = dir();
  const key = Buffer.alloc(32, 1);
  const first = new DistinctDays('web', new BucketLog(d), HK, key, T0);
  first.mark(T0, 'alice@connect.hku.hk');
  await first.close(T0);
  const second = new DistinctDays('web', new BucketLog(d), HK, key, T0 + 86_400_000);
  await second.close(T0 + 86_400_000);
  const third = new DistinctDays('web', new BucketLog(d), HK, key, T0 + 86_400_000 + 1000);
  assert.equal(third.count('2026-10-10'), 1);
});

test('history: a directory that cannot be written costs the charts their past and nothing else', async () => {
  const d = dir();
  writeFileSync(join(d, 'blocked'), 'a file where a directory is wanted');
  const log = new BucketLog(join(d, 'blocked', 'analytics'));
  const h = new MetricHistory('edge', log, T0);
  const c = new CounterLog('web', log, T0);
  const days = new DistinctDays('web', log, HK, Buffer.alloc(32, 2), T0);
  assert.doesNotThrow(() => {
    h.record(T0, { cpu: 10 }); h.record(T0 + 60_000, { cpu: 20 });
    c.add(T0, 'search'); c.tick(T0 + 3_600_001);
    days.mark(T0, 'a@x.hk'); days.tick(T0 + 86_400_000);
  });
  await Promise.all([h.close(), c.close(T0 + 3_600_002), days.close(T0 + 86_400_001)]);
  assert.deepEqual(values(h, 'minute', T0, T0 + 120_000, 60_000, 'cpu'), [10, 20], 'what is in memory still draws');
  assert.equal(c.sum('hour', T0, T0 + 3_600_000, 'search'), 1);
  assert.ok(log.writeErrors > 0, 'and the failures are counted, not hidden');
});
