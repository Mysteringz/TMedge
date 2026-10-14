import type { FurnitureAssignment, FurnitureSlots } from './types.js';

const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Parses a complete v3 furniture bundle into its public-safe representation. */
export function parseFurnitureSlots(value: unknown): FurnitureSlots | null {
  if (!record(value)) return null;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => key !== 'table' && key !== 'chair')) return null;
  const slots: FurnitureSlots = {};
  for (const key of keys) {
    const assignment = parseFurnitureAssignment(value[key]);
    if (!assignment) return null;
    if (key === 'table') slots.table = assignment;
    else slots.chair = assignment;
  }
  return slots;
}

function parseFurnitureAssignment(value: unknown): FurnitureAssignment | null {
  if (!record(value) || Object.keys(value).length !== 4
    || Object.keys(value).some((key) => !['assetId', 'scale', 'yawDeg', 'elevationM'].includes(key))
    || typeof value.assetId !== 'string' || !ASSET_ID_RE.test(value.assetId)
    || !finiteInRange(value.scale, 0.01, 100)
    || !finiteInRange(value.yawDeg, -360, 360)
    || !finiteInRange(value.elevationM, 0, 10)) return null;
  return { assetId: value.assetId.toLowerCase(), scale: value.scale, yawDeg: value.yawDeg, elevationM: value.elevationM };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}
