import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = await import(pathToFileURL(require.resolve('vite', { paths: [resolve('algo-app')] })).href);
const bundle = await build({ configFile: false, root: resolve('.'), logLevel: 'silent',
  build: { lib: { entry: resolve('algo-app/src/features/location-editor/model/canvas-metrics.ts'), formats: ['es'] }, write: false, minify: false } });
const chunk = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(item => item.type === 'chunk');
const metricModule = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);

const { canvasMetrics } = metricModule;

test('metre rulers follow the SVG meet transform and keep square grid cells in a letterboxed room', () => {
  const result = canvasMetrics({ x: 0, y: 0, width: 1200, height: 1000 }, { width: 1200, height: 1000 }, { width: 900, height: 400 });
  assert.equal(result.scale, 0.4);
  assert.equal(result.xTicks.find(tick => tick.valueCm === 0).position, 210);
  assert.equal(result.yTicks[0].position, 400);
  assert.equal(result.stepCm, 200);
  assert.deepEqual(result.xTicks.map(tick => tick.label), ['-4', '-2', '0', '2', '4', '6', '8', '10', '12', '14', '16']);
  assert.equal(result.xTicks[1].position - result.xTicks[0].position, Math.abs(result.yTicks[1].position - result.yTicks[0].position));
});

test('zoom and pan retain world coordinates rather than resetting rulers to zero', () => {
  const result = canvasMetrics({ x: 300, y: 200, width: 600, height: 500 }, { width: 1200, height: 1000 }, { width: 600, height: 500 });
  assert.equal(result.stepCm, 100);
  assert.equal(result.xTicks[0].label, '3');
  assert.equal(result.xTicks[0].position, 0);
  assert.equal(result.yTicks[0].label, '3');
  assert.equal(result.xTicks.at(-1).label, '9');
});

test('metric spacing stays readable and bounded from tiny rooms to 1000 metre floors', () => {
  for (const extent of [100, 1234, 100000]) {
    const result = canvasMetrics({ x: 0, y: 0, width: extent, height: extent }, { width: extent, height: extent }, { width: 280, height: 240 });
    assert.ok(result.stepCm * result.scale >= 64);
    assert.ok(result.xTicks.length <= 8 && result.yTicks.length <= 8);
    assert.ok(result.xGrid.length < 40 && result.yGrid.length < 40);
    assert.ok(result.xTicks.every(tick => !tick.label.includes('e') && tick.position >= 0 && tick.position <= 280));
  }
});

test('zoomed letterboxing includes every grid interval visible outside the viewBox', () => {
  const result = canvasMetrics({ x: 300, y: 200, width: 600, height: 500 }, { width: 1200, height: 1000 }, { width: 900, height: 400 });
  assert.equal(result.xTicks[0].valueCm, 100, 'room remains visible to the left of the zoomed viewBox');
  assert.equal(result.xTicks.at(-1).valueCm, 1100, 'room remains visible to the right of the zoomed viewBox');
  assert.ok(result.xGrid.includes(100) && result.xGrid.includes(1100));
  assert.ok(result.xTicks.every(tick => tick.position >= 0 && tick.position <= 900));
});

test('reset view includes an equal world-space margin around every room edge', () => {
  const view = metricModule.fitCanvasView(1200, 1000);
  assert.ok(view.x < 0 && view.y < 0);
  assert.equal(view.x, view.y);
  assert.equal(view.width, 1200 - 2 * view.x);
  assert.equal(view.height, 1000 - 2 * view.y);
});

test('grid covers the entire preview including negative margins and space beyond the room', () => {
  const result = canvasMetrics(metricModule.fitCanvasView(1200, 1000), { width: 1200, height: 1000 }, { width: 900, height: 400 });
  assert.ok(result.xGrid.some(x => x < 0) && result.xGrid.some(x => x > 1200));
  assert.ok(result.yGrid.some(y => y < 0) && result.yGrid.some(y => y > 1000));
  assert.ok(result.bounds.left < 0 && result.bounds.right > 1200);
  assert.ok(result.bounds.top < 0 && result.bounds.bottom > 1000);
});
