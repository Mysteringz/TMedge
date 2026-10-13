import type { LocationDocument, TableShape } from '../../../entities/location-config/index.ts';
import { modelTransformToWorld, planPointToWorld, sensorPoseToWorld, type LocationWorldPoint, type LocationWorldTransform } from '../../../../../src/shared/location-view.ts';
import { shapeOf } from './geometry.ts';

export interface ModelSceneTable {
  id: string; name: string; outline: LocationWorldPoint[]; seats: Array<{ id: string; position: LocationWorldPoint }>;
}

export interface ModelSceneSensor { label: string; position: LocationWorldPoint; direction: LocationWorldPoint }

export interface ModelSceneDocument {
  widthM: number; heightM: number; tables: ModelSceneTable[]; sensors: ModelSceneSensor[];
}

/** Builds floor-frame overlays from the private authored document, never from guessed GLB furniture. */
export function modelSceneFromDocument(document: LocationDocument): ModelSceneDocument {
  return {
    widthM: document.widthCm / 100, heightM: document.heightCm / 100,
    tables: document.tables.map((table) => ({
      id: table.id, name: table.name,
      outline: shapeOutline(shapeOf(table)),
      seats: table.seats.map((seat) => ({ id: seat.id, position: planPointToWorld({ x: seat.x, y: seat.y }) })),
    })),
    sensors: document.sensorAssignments.map((assignment, index) => {
      const world = sensorPoseToWorld(assignment.pose);
      return {
        label: `Sensor ${index + 1}`,
        position: world.position,
        direction: { x: Math.cos(world.yawRad), y: 0, z: -Math.sin(world.yawRad) },
      };
    }),
  };
}

/** Keeps model-space alignment separate from the fixed authored floor overlays. */
export function modelRootTransform(transform: NonNullable<LocationDocument['modelTransform']>): LocationWorldTransform {
  return modelTransformToWorld(transform);
}

function shapeOutline(shape: TableShape): LocationWorldPoint[] {
  if (shape.type === 'polygon') return shape.points.map(([x, y]) => planPointToWorld({ x, y }));
  if (shape.type === 'circle') {
    return Array.from({ length: 48 }, (_, index) => {
      const angle = (index / 48) * Math.PI * 2;
      return planPointToWorld({ x: shape.cx + Math.cos(angle) * shape.radius, y: shape.cy + Math.sin(angle) * shape.radius });
    });
  }
  return [
    { x: shape.x, y: shape.y }, { x: shape.x + shape.width, y: shape.y },
    { x: shape.x + shape.width, y: shape.y + shape.height }, { x: shape.x, y: shape.y + shape.height },
  ].map(planPointToWorld);
}
