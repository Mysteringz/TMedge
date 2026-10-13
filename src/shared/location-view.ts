/** Coordinates at the shared boundary between authored centimetres and 3D world metres. */
export interface LocationWorldPoint { x: number; y: number; z: number }

export interface LocationWorldTransform {
  scale: { x: number; y: number; z: number };
  rotationRad: { x: number; y: number; z: number };
  positionM: { x: number; y: number; z: number };
}

export interface LocationModelTransformInput {
  scale: { x: number; y: number; z: number };
  rotationDeg: { x: number; y: number; z: number };
  positionM: { x: number; y: number; z: number };
}

export interface LocationSensorPoseInput { x: number; y: number; heightCm: number; yawDeg: number }

/** Maps top-left plan coordinates to a Y-up world without rounding away centimetre precision. */
export function planPointToWorld(point: { x: number; y: number }): LocationWorldPoint {
  const planY = finite(point.y);
  return { x: finite(point.x) / 100, y: 0, z: planY === 0 ? 0 : -planY / 100 };
}

/** Maps an authored sensor pose to the same floor frame and keeps yaw about world +Y. */
export function sensorPoseToWorld(pose: LocationSensorPoseInput): { position: LocationWorldPoint; yawRad: number } {
  return {
    position: { ...planPointToWorld(pose), y: finite(pose.heightCm) / 100 },
    yawRad: degreesToRadians(pose.yawDeg),
  };
}

/** Converts the persisted model transform for a Three.js root with explicit XYZ Euler order. */
export function modelTransformToWorld(transform: LocationModelTransformInput): LocationWorldTransform {
  return {
    scale: vector(transform.scale),
    rotationRad: {
      x: degreesToRadians(transform.rotationDeg.x),
      y: degreesToRadians(transform.rotationDeg.y),
      z: degreesToRadians(transform.rotationDeg.z),
    },
    positionM: vector(transform.positionM),
  };
}

/** Converts degrees to radians without display rounding. */
export function degreesToRadians(value: number): number { return finite(value) * Math.PI / 180; }

function vector(value: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: finite(value.x), y: finite(value.y), z: finite(value.z) };
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Location view coordinates must be finite.');
  return value;
}
