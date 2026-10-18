import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
const require = createRequire(import.meta.url);
const viteEntry = require.resolve('vite', { paths: [resolve('algo-app')] });
const { build } = await import(pathToFileURL(viteEntry).href);
const bundle = await build({
  configFile: false,
  root: resolve('.'),
  logLevel: 'silent',
  build: {
    lib: { entry: resolve('algo-app/src/features/location-editor/model/geometry.ts'), formats: ['es'], fileName: 'location-editor-model.js' },
    write: false,
    minify: false,
  },
});
const output = (Array.isArray(bundle) ? bundle[0] : bundle)?.output.find((item) => item.type === 'chunk');
assert.ok(output && output.type === 'chunk', 'Vite compiles the real editor model without writing a bundle');
const model = await import(`data:text/javascript;base64,${Buffer.from(output.code).toString('base64')}`);

const floor = () => ({
  name: 'Model test', building: 'Test', widthCm: 1200, heightCm: 800,
  outline: [[0, 0], [1200, 0], [1200, 800], [0, 800]],
  zones: [{ id: 'ZONE_A', name: 'Main area', polygon: [[0, 0], [1200, 0], [1200, 800], [0, 800]] }],
  tables: [], sensorAssignments: [],
});
const issueFields = (document, base = null) => model.validateEditorDocument(document, base).map(({ field }) => field);

test('new tables use realistic dimensions and keep generated seats inside small rooms', () => {
  const rectangle = model.createTable(floor(), 'rect');
  assert.equal(rectangle.shape.width, 120);
  assert.equal(rectangle.shape.height, 80);
  for (const [widthCm, heightCm] of [[100, 100], [100, 800], [1200, 100], [1000, 800]]) {
    const room = { ...floor(), widthCm, heightCm, outline: [[0, 0], [widthCm, 0], [widthCm, heightCm], [0, heightCm]] };
    room.zones[0].polygon = room.outline;
    for (const kind of ['rect', 'circle', 'polygon']) {
      const table = model.createTable(room, kind);
      assert.deepEqual(issueFields({ ...room, tables: [table] }), [], `${kind} fits ${widthCm} by ${heightCm} cm with its seats`);
    }
  }
});

test('table translation carries custom seats without regenerating identities or changing the original', () => {
  for (const kind of ['rect', 'circle', 'polygon']) {
    const table = model.createTable(floor(), kind);
    table.seats[0].x += 3.5;
    const original = structuredClone(table);
    const moved = model.translateTable(table, 125, -50);
    assert.deepEqual(table, original, 'the original document remains available to drag and undo callers');
    assert.deepEqual(moved.seats, original.seats.map(seat => ({ ...seat, x: seat.x + 125, y: seat.y - 50 })));
    const shape = original.shape;
    const expectedShape = kind === 'rect' ? { ...shape, x: shape.x + 125, y: shape.y - 50 }
      : kind === 'circle' ? { ...shape, cx: shape.cx + 125, cy: shape.cy - 50 }
        : { ...shape, points: shape.points.map(([x, y]) => [x + 125, y - 50]) };
    assert.deepEqual(moved.shape, expectedShape);
  }
});

test('editor model generates table seats for each shape and preserves exact metre/centimetre conversion', () => {
  const document = floor();
  assert.equal(model.cmToMetres(1234), 12.34);
  assert.equal(model.metresToCm(2.5), 250);
  for (const kind of ['rect', 'circle', 'polygon']) {
    const table = model.createTable(document, kind);
    assert.ok(table);
    assert.equal(table.shape.type, kind);
    assert.equal(table.seats.length, table.capacity);
    assert.equal(new Set(table.seats.map((seat) => seat.id)).size, table.capacity);
    for (const seat of table.seats) {
      assert.ok(seat.neighbors.every((id) => table.seats.find((other) => other.id === id)?.neighbors.includes(seat.id)));
    }
    assert.deepEqual(issueFields({ ...document, tables: [table] }), [], `${kind} table is a valid model candidate`);
  }
  assert.equal(model.createTable({ ...document, zones: [] }, 'rect'), null);
});

test('editor model reports field-addressable floor, shape, seat, capacity and polygon errors', () => {
  const document = floor();
  const rect = {
    id: 'TABLE_RECT', name: 'Rectangle', zoneId: 'ZONE_A', capacity: 1,
    shape: { type: 'rect', x: -1, y: 10, width: 100, height: 80 },
    seats: [{ id: 'SEAT_RECT', x: -5, y: 20, neighbors: [] }],
  };
  const circle = {
    id: 'TABLE_CIRCLE', name: 'Circle', zoneId: 'ZONE_A', capacity: 1,
    shape: { type: 'circle', cx: 100, cy: 100, radius: 1000 },
    seats: [{ id: 'SEAT_CIRCLE', x: 100, y: 100, neighbors: [] }],
  };
  const polygon = {
    id: 'TABLE_POLYGON', name: 'Polygon', zoneId: 'ZONE_A', capacity: 2,
    shape: { type: 'polygon', points: [[100, 100], [200, 200], [100, 200], [200, 100]] },
    seats: [{ id: 'SEAT_POLYGON', x: 150, y: 150, neighbors: [] }],
  };
  const withTables = { ...document, widthCm: 99, tables: [rect, circle, polygon] };
  const fields = issueFields(withTables);
  for (const expected of [
    'floor.width', 'table.TABLE_RECT.shape.x', 'seat.SEAT_RECT.x',
    'table.TABLE_CIRCLE.shape.radius', 'table.TABLE_POLYGON.capacity', 'table.TABLE_POLYGON.shape.vertex.0.x',
  ]) assert.ok(fields.includes(expected), `validation points to ${expected}; got ${fields.join(', ')}`);
  assert.ok(fields.includes('zones.list') === false, 'valid zone identity remains unaffected');
});

test('editor model preserves unchanged exact-base legacy geometry and rejects changed or resized legacy geometry', () => {
  const legacy = {
    ...floor(),
    outline: [[-10, -10], [1210, -10], [1200, 800]],
    zones: [{ id: 'ZONE_LEGACY', name: 'Legacy zone', polygon: [[-10, -10], [1210, -10], [1200, 800]] }],
    tables: [{
      id: 'TABLE_LEGACY', name: 'Legacy table', zoneId: 'ZONE_LEGACY', capacity: 1,
      rect: { x: 0, y: 100, width: 40, height: 60 },
      seats: [{ id: 'SEAT_LEGACY', x: -35, y: 130, neighbors: [] }],
    }],
  };
  const renamed = structuredClone(legacy); renamed.name = 'Legacy room renamed';
  assert.deepEqual(issueFields(renamed, legacy), [], 'untouched legacy shape-less geometry stays compatible');
  assert.deepEqual(renamed, { ...legacy, name: 'Legacy room renamed' }, 'validation does not mutate candidate or base');

  const changed = structuredClone(legacy); changed.zones[0].polygon[0][0] = -11;
  assert.ok(issueFields(changed, legacy).includes('zone.ZONE_LEGACY.vertex.0.x'));
  const movedSeat = structuredClone(legacy); movedSeat.tables[0].seats[0].x = -36;
  assert.ok(issueFields(movedSeat, legacy).includes('seat.SEAT_LEGACY.x'));
  const resized = structuredClone(legacy); resized.widthCm += 1;
  const resizedFields = issueFields(resized, legacy);
  assert.ok(resizedFields.includes('floor.outline'));
  assert.ok(resizedFields.some((field) => field.startsWith('zone.ZONE_LEGACY.')));
  assert.ok(resizedFields.includes('table.TABLE_LEGACY.shape'));
  assert.ok(resizedFields.includes('seat.SEAT_LEGACY.x'));
});
