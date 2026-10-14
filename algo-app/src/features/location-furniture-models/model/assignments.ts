import type { FurnitureAssignment, FurnitureSlots, FurnitureType } from '../../../entities/location-config/index.ts';

export const FURNITURE_FIT_LIMITS = {
  scale: { min: 0.01, max: 100, step: 0.01 },
  yawDeg: { min: -360, max: 360, step: 1 },
  elevationM: { min: 0, max: 10, step: 0.01 },
} as const;

export function effectiveFurniture(defaults: FurnitureSlots | undefined, overrides: FurnitureSlots | undefined, slot: FurnitureType): FurnitureAssignment | undefined {
  return overrides?.[slot] ?? defaults?.[slot];
}

export function copyFurnitureAssignment(value: FurnitureAssignment): FurnitureAssignment {
  return { assetId: value.assetId, scale: value.scale, yawDeg: value.yawDeg, elevationM: value.elevationM };
}

export function assignmentForNewOverride(inherited: FurnitureAssignment | undefined, assetId?: string): FurnitureAssignment | undefined {
  if (inherited) return copyFurnitureAssignment(inherited);
  if (!assetId) return undefined;
  return { assetId, scale: 1, yawDeg: 0, elevationM: 0 };
}

export function replaceAssignmentAsset(current: FurnitureAssignment | undefined, inherited: FurnitureAssignment | undefined, assetId: string): FurnitureAssignment {
  const base = current ?? inherited;
  return { assetId, scale: base?.scale ?? 1, yawDeg: base?.yawDeg ?? 0, elevationM: base?.elevationM ?? 0 };
}

export function updateAssignmentFit(current: FurnitureAssignment, field: 'scale' | 'yawDeg' | 'elevationM', value: number): FurnitureAssignment {
  return { ...current, [field]: value };
}
