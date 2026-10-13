import type { CampusFloor } from './types.js';

export type CampusFloorResolution =
  | { kind: 'found'; floor: CampusFloor }
  | { kind: 'missing' }
  | { kind: 'ambiguous' };

/** Serializes a location pair without relying on an escapable delimiter. */
export function campusLocationKey(siteId: string, floorId: string): string {
  return JSON.stringify([siteId, floorId]);
}

/** Resolves legacy floor-only references only while they remain unique. */
export function resolveCampusFloor(
  floors: readonly CampusFloor[], floorId: string, siteId?: string,
): CampusFloorResolution {
  const matches = floors.filter((floor) => floor.id === floorId && (siteId === undefined || floor.siteId === siteId));
  if (matches.length === 0) return { kind: 'missing' };
  if (matches.length > 1) return { kind: 'ambiguous' };
  const floor = matches[0];
  return floor ? { kind: 'found', floor } : { kind: 'missing' };
}
