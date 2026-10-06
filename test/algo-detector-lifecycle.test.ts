import assert from 'node:assert/strict';
import { spawn, type SpawnOptions } from 'node:child_process';
import test from 'node:test';
import { DetectorHost, type DetectorParams } from '../src/algo/detector.js';

const params: DetectorParams = {
  min_contrast: 0.6, min_peak: 1.2, noise_k: 4, min_area: 1, max_area: 60,
  bg_tau: 90, bg_frames: 20, split_sep: 1.9,
};

test('detector shutdown terminates an active preview process', async () => {
  let started!: () => void;
  const launched = new Promise<void>((resolve) => { started = resolve; });
  const launch = (_binary: string, _args: string[], options: SpawnOptions) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    started();
    return child;
  };
  const detector = new DetectorHost({ binary: process.execPath, spawnProcess: launch as typeof spawn });
  const running = detector.run([{
    frame: 1, uid: 'test', receivedAt: Date.now(), temps: new Float32Array(768),
    tMin: 0, step: 1, deviceDetections: null, deviceFlags: null,
  }], params, false);
  await launched;
  await detector.dispose();
  await assert.rejects(running, /cancelled during shutdown/);
  await assert.rejects(detector.run([], params, false), /disposed/);
});
