import type { LocationDocument, TableShape } from '../../../entities/location-config/index.ts';
import { modelTransformToWorld, sensorPoseToWorld, type LocationWorldPoint, type LocationWorldTransform } from '../../../../../src/shared/location-view.ts';
import { projectSimpleRoomSeat, projectSimpleRoomTable, SIMPLE_ROOM_TABLE_HEIGHT_M, SIMPLE_ROOM_WALL_HEIGHT_M, type SimpleRoomTableFootprint } from '../../../../../src/shared/simple-room-geometry.ts';
import { locationRoomSource, type LocationRoomSource } from '../../location-room-source/index.ts';
import { shapeOf } from './geometry.ts';

export interface ModelSceneTable {
  id: string; name: string; kind: TableShape['type'] | 'legacy rectangle';
  footprint: SimpleRoomTableFootprint;
  seats: Array<{ id: string; position: { x: number; z: number }; side?: 'L' | 'R' | 'T' | 'B' }>;
}

export interface ModelSceneSensor {
  uid: string; label: string; position: LocationWorldPoint; direction: LocationWorldPoint; yawRad: number;
}

export interface ModelSceneDocument {
  source: LocationRoomSource; widthM: number; heightM: number; wallHeightM: number; tableHeightM: number;
  tables: ModelSceneTable[]; sensors: ModelSceneSensor[];
}

/** Builds floor-frame overlays from the private authored document, never from guessed GLB furniture. */
export function modelSceneFromDocument(document: LocationDocument, capability?: import('../../../entities/location-config/model/types.ts').AssetCapability, sensorLabels: ReadonlyMap<string, string> = new Map()): ModelSceneDocument {
  return {
    source: locationRoomSource(document, capability),
    widthM: document.widthCm / 100, heightM: document.heightCm / 100,
    wallHeightM: SIMPLE_ROOM_WALL_HEIGHT_M, tableHeightM: SIMPLE_ROOM_TABLE_HEIGHT_M,
    tables: document.tables.map((table) => ({
      id: table.id, name: table.name,
      kind: table.shape?.type ?? 'legacy rectangle',
      footprint: projectSimpleRoomTable({ shape: shapeOf(table) }),
      seats: table.seats.map((seat) => ({ id: seat.id, position: projectSimpleRoomSeat(seat), ...(seat.side ? { side: seat.side } : {}) })),
    })),
    sensors: document.sensorAssignments.map((assignment) => {
      const world = sensorPoseToWorld(assignment.pose);
      return {
        uid: assignment.uid,
        label: sensorLabels.get(assignment.uid.toLowerCase()) ?? assignment.uid,
        position: world.position,
        yawRad: world.yawRad,
        direction: { x: Math.cos(world.yawRad), y: 0, z: -Math.sin(world.yawRad) },
      };
    }),
  };
}

/** Keeps model-space alignment separate from the fixed authored floor overlays. */
export function modelRootTransform(transform: NonNullable<LocationDocument['modelTransform']>): LocationWorldTransform {
  return modelTransformToWorld(transform);
}
