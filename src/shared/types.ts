/**
 * Shapes shared by the edge, the web tier and both browser clients.
 *
 * The occupancy snapshot is the ONLY thing that leaves the edge for the web
 * tier (and later the cloud). It is deliberately free of anything a picture
 * could be rebuilt from: no pixels, no detections, no node positions -- just
 * which seats are taken. Keep it that way; it is the privacy boundary.
 */

export type Point = [number, number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SeatSide = 'L' | 'R' | 'T' | 'B';

export interface SeatState {
  id: string;
  /** Plan position, cm. */
  x: number;
  y: number;
  side: SeatSide;
  /** Position along its side, 0-based. */
  index: number;
  /** null = unknown: no working sensor covers this seat right now. */
  occupied: boolean | null;
  /** Seats you can sit next to or across from as a group. */
  neighbors: string[];
}

/**
 * ok       counted by the node that owns this table
 * fallback owner is down; a neighbouring node that also sees it is counting
 * unknown  nobody can see it -- never shown as empty
 */
export type CoverageStatus = 'ok' | 'fallback' | 'unknown';

export interface TableState {
  id: string;
  name: string;
  zoneId: string;
  rect: Rect;
  capacity: number;
  /** Seats taken; never more than capacity. null when unknown. */
  occupied: number | null;
  free: number | null;
  status: CoverageStatus;
  seats: SeatState[];
}

export interface ZoneState {
  id: string;
  name: string;
  polygon: Point[];
  /** Everyone detected in the zone, seated or not, uncapped. null when any part is unknown. */
  people: number | null;
}

export interface FloorTotals {
  seats: number;
  /** Seats known free / occupied; seats at unknown tables are in neither. */
  free: number;
  occupied: number;
  unknownSeats: number;
  tablesFullyFree: number;
}

export interface FloorState {
  id: string;
  building: string;
  name: string;
  width: number;
  height: number;
  outline: Point[];
  zones: ZoneState[];
  tables: TableState[];
  totals: FloorTotals;
}

export interface OccupancySnapshot {
  version: 1;
  edgeId: string;
  site: { id: string; name: string };
  /** Edge clock, ms since epoch. */
  generatedAt: number;
  floors: FloorState[];
}

/** What the web tier serves: every floor from every edge, with freshness. */
export interface CampusFloor extends FloorState {
  edgeId: string;
  /** When the web tier last heard from this floor's edge, ms since epoch. */
  updatedAt: number;
  /** The edge has gone quiet: every table is shown unknown. */
  stale: boolean;
}

export interface CampusView {
  generatedAt: number;
  floors: CampusFloor[];
}

/** One suggested place to sit, as returned by the seat search. */
export interface SeatSuggestion {
  floorId: string;
  floorName: string;
  building: string;
  tableIds: string[];
  tableName: string;
  /** Seats chosen for the group, adjacent to each other. */
  seatIds: string[];
  freeAtTable: number;
  capacity: number;
  /** 0..1, share of the table already taken: lower is quieter. */
  busyness: number;
}

// --- Edge debug console (admin only, never sent to the web tier) -------------

export interface NodePose {
  /** Plan position of the sensor, cm. */
  x: number;
  y: number;
  /** Mounting height above the floor, cm. */
  heightCm: number;
  /** Rotation of the sensor's +x (column) axis from the plan's +x axis, degrees. */
  yawDeg: number;
  /** True if the image is mirrored relative to the plan (sensor flipped). */
  mirror: boolean;
}

export interface ConsoleDetection {
  x: number;
  y: number;
  area: number;
  contrast: number;
  peak: number;
  heat: number;
  /** Projected plan position, cm. */
  floorX: number;
  floorY: number;
  /** Table this falls in, and whether this node's view of it is the one counted. */
  tableId: string | null;
  counted: boolean;
  persons: number;
}

export interface NodeHealth {
  uid: string;
  label: string;
  registered: boolean;
  floorId: string | null;
  owns: string[];
  pose: NodePose | null;
  online: boolean;
  address: string | null;
  lastSeen: number | null;
  firstSeen: number | null;
  signed: boolean;
  boot: number | null;
  fps: number;
  lossRate: number;
  reports: number;
  raws: number;
  rejected: number;
  lastPeople: number | null;
  backgroundReady: boolean;
  globalShift: boolean;
  sceneMin: number | null;
  sceneMax: number | null;
  ta: number | null;
  status: {
    fw: string;
    ip: string;
    rssi: number;
    channel: number;
    heap: number;
    minHeap: number;
    stackFree: number;
    wifiDrops: number;
    sensorErrors: number;
    frames: number;
    fps: number;
    vdd: number;
    lastCmd: number;
    params: Record<string, number>;
    receivedAt: number;
  } | null;
  /** Heat of a typical single person in this view, learned online. */
  refHeat: number | null;
}

export interface EdgeHealth {
  edgeId: string;
  version: string;
  startedAt: number;
  now: number;
  uptimeS: number;
  hostname: string;
  platform: string;
  node: string;
  cpuLoad1: number;
  cpus: number;
  memRssMb: number;
  memHeapMb: number;
  sysFreeMb: number;
  sysTotalMb: number;
  eventLoopLagMs: number;
  packetsPerSec: number;
  bytesPerSec: number;
  rejectedPerMin: number;
  rejectReasons: Record<string, number>;
  unknownSources: { address: string; uid: string | null; count: number; lastSeen: number; reason: string }[];
  publish: { target: string; ok: boolean; lastOkAt: number | null; lastError: string | null }[];
  recorder: { dir: string; bytesToday: number; rawEnabled: boolean };
  gateways: { id: string; remote: string; transport: 'tcp' | 'websocket'; connectedAt: number; lastSeen: number; uplink: number; downlink: number; rttMs: number | null; stats: Record<string, unknown> | null }[];
  gatewayPort: number | null;
  udp: { port: number; iface: string | null };
}

export interface RawFrameMessage {
  uid: string;
  frame: number;
  tMin: number;
  step: number;
  /** 768 levels, row-major. */
  pixels: number[];
  receivedAt: number;
}
