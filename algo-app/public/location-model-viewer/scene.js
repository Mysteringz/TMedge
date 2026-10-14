import * as THREE from '../location-model/vendor/three/three.module.js';
import { OrbitControls } from '../location-model/vendor/three/OrbitControls.js';
import { GLTFLoader } from '../location-model/vendor/three/GLTFLoader.js';

const COLORS = { floor: 0x8995a2, table: 0x57a0e8, seat: 0xe6edf4, sensor: 0xffa600, wall: 0x65717e };

/** Owns one GLB root and a separate authored-coordinate overlay scene. */
export class LocationModelScene {
  constructor(host) {
    this.host = host;
    this.disposed = false;
    this.loadId = 0;
    this.source = '2d';
    this.initialFloorDrawn = false;
    this.widthM = 10;
    this.heightM = 10;
    this.walls = new Map();
    this.floor = new THREE.Group();
    this.overlay = new THREE.Group();
    this.furnitureFallback = new THREE.Group();
    this.furnitureGroup = new THREE.Group();
    this.modelRoot = new THREE.Group();
    this.furnitureBuffers = new Map();
    this.furnitureModels = new Map();
    this.furnitureStates = new Map();
    this.assignedFurnitureIds = new Set();
    this.tables = [];
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x171d24);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.host.replaceChildren(this.renderer.domElement);
    this.host.addEventListener('location-model-camera-reset', this.onCameraReset);
    this.scene.add(new THREE.HemisphereLight(0xdce8f4, 0x2b3139, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.3);
    key.position.set(6, 10, 8);
    this.scene.add(key, this.floor, this.modelRoot, this.overlay, this.furnitureFallback, this.furnitureGroup);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', this.updateWallVisibility);
    this.controls.target.set(this.widthM / 2, 0, -this.heightM / 2);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    this.frameId = requestAnimationFrame(this.render);
  }

  setFloor(value) {
    if (this.disposed) return;
    if (value.source !== this.source) {
      this.source = value.source;
      if (value.source !== 'custom') {
        this.loadId += 1;
        clearGroup(this.modelRoot);
      }
    }
    this.widthM = value.widthM;
    this.heightM = value.heightM;
    this.wallHeightM = value.wallHeightM;
    this.tableHeightM = value.tableHeightM;
    this.tables = value.tables;
    this.updateFurnitureAssignments(value.tables);
    clearGroup(this.floor);
    clearGroup(this.overlay);
    this.walls.clear();
    this.drawFloor();
    if (this.source === 'generated') this.drawRoomWalls();
    for (const table of value.tables) this.drawTable(table);
    for (const sensor of value.sensors) this.drawSensor(sensor);
    this.syncFurnitureAssets(false);
    this.refreshFurnitureRendering();
    if (!this.initialFloorDrawn) {
      this.initialFloorDrawn = true;
      this.resetCamera();
    }
    this.updateWallVisibility();
  }

  /** Supplies the currently assigned private furniture buffers; calling again retries failed parses. */
  setFurnitureAssets(items) {
    if (this.disposed || !Array.isArray(items)) return;
    this.furnitureBuffers = new Map(items
      .filter((item) => item && typeof item.assetId === 'string' && item.assetId && item.buffer instanceof ArrayBuffer)
      .map((item) => [item.assetId, item.buffer]));
    this.syncFurnitureAssets(true);
    this.refreshFurnitureRendering();
  }

  setTransform(value) {
    if (!value || this.disposed) return;
    this.modelRoot.scale.set(value.scale.x, value.scale.y, value.scale.z);
    this.modelRoot.rotation.order = 'XYZ';
    this.modelRoot.rotation.set(value.rotationRad.x, value.rotationRad.y, value.rotationRad.z, 'XYZ');
    this.modelRoot.position.set(value.positionM.x, value.positionM.y, value.positionM.z);
  }

  async loadModel(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer) || this.disposed) return;
    const loadId = ++this.loadId;
    this.state('loading', 'Loading validated GLB preview.');
    let candidate;
    try {
      const result = await new GLTFLoader().parseAsync(arrayBuffer.slice(0), '');
      candidate = result.scene;
      if (this.disposed || loadId !== this.loadId) { disposeObject(candidate); return; }
      clearGroup(this.modelRoot);
      this.modelRoot.add(candidate);
      this.resetCamera();
      this.state('loaded', 'GLB preview loaded.');
    } catch {
      if (candidate) disposeObject(candidate);
      if (!this.disposed && loadId === this.loadId) this.state('error', 'The validated GLB could not be rendered. Retry preview or choose another file.');
    }
  }

  resetCamera = () => {
    if (this.disposed) return;
    const bounds = new THREE.Box3().setFromObject(this.floor);
    bounds.union(new THREE.Box3().setFromObject(this.overlay));
    if (this.modelRoot.children.length) bounds.union(new THREE.Box3().setFromObject(this.modelRoot));
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1);
    this.controls.target.copy(center);
    this.camera.position.set(center.x, center.y + span * 0.85, center.z + span * 1.05);
    this.camera.near = Math.max(0.01, span / 10000);
    this.camera.far = Math.max(1000, span * 20);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.updateWallVisibility();
  };

  zoom(factor) {
    if (this.disposed || !Number.isFinite(factor) || factor <= 0) return;
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const distance = offset.length();
    if (!Number.isFinite(distance) || distance <= 0) return;
    const minimum = Math.max(0.01, this.controls.minDistance);
    const nextDistance = Math.min(this.controls.maxDistance, Math.max(minimum, distance / factor));
    offset.multiplyScalar(nextDistance / distance);
    this.camera.position.copy(target).add(offset);
    this.controls.update();
  }

  drawFloor() {
    const corners = [[0, 0, 0], [this.widthM, 0, 0], [this.widthM, 0, -this.heightM], [0, 0, -this.heightM]];
    this.floor.add(lineLoop(corners, COLORS.floor, 0.9));
    const step = Math.max(0.5, Math.ceil(Math.max(this.widthM, this.heightM) / 40));
    const positions = [];
    for (let x = 0; x <= this.widthM + 1e-6; x += step) positions.push(x, -0.002, 0, x, -0.002, -this.heightM);
    for (let z = 0; z >= -this.heightM - 1e-6; z -= step) positions.push(0, -0.002, z, this.widthM, -0.002, z);
    this.floor.add(lineSegments(positions, 0x59636e, 0.45));
    if (this.source === 'generated') {
      const material = new THREE.MeshStandardMaterial({ color: 0x252d36, roughness: 0.95, side: THREE.DoubleSide });
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(this.widthM, this.heightM), material);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(this.widthM / 2, -0.015, -this.heightM / 2);
      floor.name = 'generated-floor';
      this.floor.add(floor);
    }
  }

  drawTable(table) {
    if (this.source === 'generated') return;
    this.overlay.add(lineLoop(footprintOutline(table.footprint).map((point) => [point.x, 0.025, point.z]), COLORS.table, 1));
    for (const seat of table.seats) this.overlay.add(sphere({ ...seat.position, y: 0 }, 0.075, COLORS.seat));
  }

  drawGeneratedFurnitureFallbacks() {
    clearGroup(this.furnitureFallback);
    if (this.source !== 'generated') return;
    for (const table of this.tables) {
      if (!this.hasLoadedFurniture(table.furniture?.table)) {
        this.furnitureFallback.add(raisedTable(table, this.tableHeightM));
      }
      if (!this.hasLoadedFurniture(table.furniture?.chair)) {
        for (const seat of table.seats) this.furnitureFallback.add(chair(seat, table.kind));
      }
    }
  }

  updateFurnitureAssignments(tables) {
    const assigned = new Set();
    for (const table of tables) {
      for (const assignment of [table.furniture?.table, table.furniture?.chair]) {
        if (assignment && typeof assignment.assetId === 'string' && assignment.assetId) assigned.add(assignment.assetId);
      }
    }
    this.assignedFurnitureIds = assigned;
    const removed = [...this.furnitureModels].filter(([assetId]) => !assigned.has(assetId));
    if (removed.some(([, entry]) => entry.template)) this.clearFurnitureInstances();
    for (const [assetId, entry] of removed) {
      if (entry.template) disposeObject(entry.template);
      this.furnitureModels.delete(assetId);
      this.furnitureStates.delete(assetId);
    }
    for (const assetId of this.furnitureBuffers.keys()) {
      if (!assigned.has(assetId)) this.furnitureBuffers.delete(assetId);
    }
    for (const assetId of this.furnitureStates.keys()) {
      if (!assigned.has(assetId)) this.furnitureStates.delete(assetId);
    }
  }

  syncFurnitureAssets(retryErrors) {
    for (const assetId of this.assignedFurnitureIds) {
      const entry = this.furnitureModels.get(assetId);
      if (entry?.status === 'loaded') {
        this.furnitureState(assetId, 'loaded', 'Assigned furniture model loaded.');
        continue;
      }
      if (entry?.status === 'loading' || entry?.status === 'error' && !retryErrors) continue;
      const buffer = this.furnitureBuffers.get(assetId);
      if (buffer) this.loadFurnitureAsset(assetId, buffer);
    }
  }

  loadFurnitureAsset(assetId, buffer) {
    const entry = { status: 'loading', template: null };
    this.furnitureModels.set(assetId, entry);
    this.furnitureState(assetId, 'loading', 'Loading assigned furniture model.');
    let candidate = null;
    void new GLTFLoader().parseAsync(buffer.slice(0), '').then((result) => {
      candidate = result.scene;
      if (!this.isCurrentFurnitureRequest(assetId, entry)) {
        disposeObject(candidate);
        return;
      }
      const template = normalizeFurniture(candidate);
      entry.status = 'loaded';
      entry.template = template;
      candidate = null;
      this.furnitureBuffers.delete(assetId);
      this.furnitureState(assetId, 'loaded', 'Assigned furniture model loaded.');
      this.refreshFurnitureRendering();
    }).catch(() => {
      if (candidate) disposeObject(candidate);
      if (!this.isCurrentFurnitureRequest(assetId, entry)) return;
      if (entry.template) {
        this.clearFurnitureInstances();
        disposeObject(entry.template);
        entry.template = null;
      }
      entry.status = 'error';
      this.furnitureState(assetId, 'error', 'The assigned furniture model could not be rendered. Retry preview.');
      this.refreshFurnitureRendering();
    });
  }

  isCurrentFurnitureRequest(assetId, entry) {
    return !this.disposed && this.assignedFurnitureIds.has(assetId) && this.furnitureModels.get(assetId) === entry;
  }

  hasLoadedFurniture(assignment) {
    return isValidFurnitureAssignment(assignment) && this.furnitureModels.get(assignment.assetId)?.status === 'loaded';
  }

  drawFurnitureInstances() {
    this.clearFurnitureInstances();
    for (const table of this.tables) {
      const tableAssignment = table.furniture?.table;
      if (this.hasLoadedFurniture(tableAssignment)) {
        const center = footprintCenter(table.footprint);
        const instance = furnitureInstance(this.furnitureModels.get(tableAssignment.assetId).template, tableAssignment, center, 0);
        if (instance) this.furnitureGroup.add(instance);
      }
      const chairAssignment = table.furniture?.chair;
      if (!this.hasLoadedFurniture(chairAssignment)) continue;
      const template = this.furnitureModels.get(chairAssignment.assetId).template;
      for (const seat of table.seats) {
        const instance = furnitureInstance(template, chairAssignment, seat.position, chairYaw(seat.side));
        if (instance) this.furnitureGroup.add(instance);
      }
    }
  }

  refreshFurnitureRendering() {
    this.drawGeneratedFurnitureFallbacks();
    this.drawFurnitureInstances();
  }

  clearFurnitureInstances() {
    for (const child of [...this.furnitureGroup.children]) this.furnitureGroup.remove(child);
  }

  furnitureState(assetId, state, message) {
    if (this.furnitureStates.get(assetId) === state) return;
    this.furnitureStates.set(assetId, state);
    this.host.dispatchEvent(new CustomEvent('location-model-furniture-state', {
      bubbles: true, detail: { assetId, state, message },
    }));
  }

  drawSensor(sensor) {
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), new THREE.MeshStandardMaterial({ color: COLORS.sensor }));
    marker.position.set(sensor.position.x, sensor.position.y, sensor.position.z);
    marker.name = `draft-sensor-${safeName(sensor.uid)}`;
    this.overlay.add(marker);
    const start = new THREE.Vector3(sensor.position.x, sensor.position.y, sensor.position.z);
    const direction = new THREE.Vector3(sensor.direction.x, 0, sensor.direction.z).normalize();
    const arrow = new THREE.ArrowHelper(direction, start, 0.5, COLORS.sensor, 0.16, 0.1);
    arrow.name = `draft-sensor-yaw-${safeName(sensor.uid)}`;
    this.overlay.add(arrow);
  }

  drawRoomWalls() {
    const thickness = 0.08;
    const material = new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.82, transparent: true, opacity: 0.86 });
    const wallHeight = this.wallHeightM;
    const definitions = [
      ['north', this.widthM + thickness, wallHeight, thickness, this.widthM / 2, wallHeight / 2, 0],
      ['south', this.widthM + thickness, wallHeight, thickness, this.widthM / 2, wallHeight / 2, -this.heightM],
      ['west', thickness, wallHeight, this.heightM + thickness, 0, wallHeight / 2, -this.heightM / 2],
      ['east', thickness, wallHeight, this.heightM + thickness, this.widthM, wallHeight / 2, -this.heightM / 2],
    ];
    for (const [name, width, height, depth, x, y, z] of definitions) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
      wall.position.set(x, y, z);
      wall.name = `generated-wall-${name}`;
      this.walls.set(name, wall);
      this.floor.add(wall);
    }
  }

  updateWallVisibility = () => {
    if (this.source !== 'generated' || this.walls.size !== 4) return;
    const centerX = this.widthM / 2;
    const centerZ = -this.heightM / 2;
    this.walls.get('north').visible = !(this.camera.position.z > centerZ + 0.001);
    this.walls.get('south').visible = !(this.camera.position.z < centerZ - 0.001);
    this.walls.get('west').visible = !(this.camera.position.x < centerX - 0.001);
    this.walls.get('east').visible = !(this.camera.position.x > centerX + 0.001);
  };

  resize() {
    if (this.disposed) return;
    const bounds = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(bounds.width));
    const height = Math.max(1, Math.floor(bounds.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render = () => {
    if (this.disposed) return;
    this.controls.update();
    this.updateWallVisibility();
    this.renderer.render(this.scene, this.camera);
    this.frameId = requestAnimationFrame(this.render);
  };

  state(state, message) {
    this.host.dispatchEvent(new CustomEvent('location-model-state', { bubbles: true, detail: { state, message } }));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadId += 1;
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.controls.removeEventListener('change', this.updateWallVisibility);
    clearGroup(this.furnitureFallback);
    this.clearFurnitureInstances();
    for (const entry of this.furnitureModels.values()) {
      if (entry.template) disposeObject(entry.template);
    }
    this.furnitureModels.clear();
    this.furnitureBuffers.clear();
    this.furnitureStates.clear();
    disposeObject(this.modelRoot);
    disposeObject(this.floor);
    disposeObject(this.overlay);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.host.removeEventListener('location-model-camera-reset', this.onCameraReset);
  }

  onCameraReset = () => this.resetCamera();
}

function lineLoop(points, color, opacity) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map((point) => new THREE.Vector3(...point)));
  return new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}

function isValidFurnitureAssignment(value) {
  return !!value && typeof value.assetId === 'string' && value.assetId.length > 0
    && Number.isFinite(value.scale) && value.scale >= 0.01 && value.scale <= 100
    && Number.isFinite(value.yawDeg) && value.yawDeg >= -360 && value.yawDeg <= 360
    && Number.isFinite(value.elevationM) && value.elevationM >= 0 && value.elevationM <= 10;
}

function normalizeFurniture(scene) {
  const template = new THREE.Group();
  template.add(scene);
  template.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(template);
  if ([bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z].some((value) => !Number.isFinite(value))) {
    throw new Error('The furniture model has no finite renderable bounds.');
  }
  const center = bounds.getCenter(new THREE.Vector3());
  template.position.set(-center.x, -bounds.min.y, -center.z);
  return template;
}

function furnitureInstance(template, assignment, anchor, canonicalYaw) {
  if (!template || !isValidFurnitureAssignment(assignment)) return null;
  const instance = new THREE.Group();
  instance.add(template.clone(true));
  instance.scale.set(assignment.scale, assignment.scale, assignment.scale);
  instance.rotation.y = canonicalYaw + assignment.yawDeg * Math.PI / 180;
  instance.position.set(anchor.x, assignment.elevationM, anchor.z);
  instance.name = `furniture-${safeName(assignment.assetId)}`;
  return instance;
}

function footprintCenter(footprint) {
  if (footprint.type === 'circle') return footprint.center;
  const points = footprint.points;
  let crossSum = 0;
  let centerX = 0;
  let centerZ = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.z - next.x * current.z;
    crossSum += cross;
    centerX += (current.x + next.x) * cross;
    centerZ += (current.z + next.z) * cross;
  }
  if (Math.abs(crossSum) < 1e-9) {
    const total = points.reduce((center, point) => ({ x: center.x + point.x, z: center.z + point.z }), { x: 0, z: 0 });
    return points.length ? { x: total.x / points.length, z: total.z / points.length } : { x: 0, z: 0 };
  }
  return { x: centerX / (3 * crossSum), z: centerZ / (3 * crossSum) };
}

function lineSegments(positions, color, opacity) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

function sphere(point, radius, color) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), new THREE.MeshStandardMaterial({ color }));
  mesh.position.set(point.x, point.y + 0.035, point.z);
  return mesh;
}

function raisedTable(table, tableHeightM) {
  const shape = new THREE.Shape();
  if (table.footprint.type === 'circle') {
    const { center, radiusM } = table.footprint;
    shape.absarc(center.x, center.z, radiusM, 0, Math.PI * 2, false);
    shape.closePath();
  } else {
    const points = table.footprint.points;
    const first = points[0];
    if (!first) return new THREE.Group();
    shape.moveTo(first.x, first.z);
    for (const point of points.slice(1)) shape.lineTo(point.x, point.z);
    shape.closePath();
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false, curveSegments: 32 });
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: COLORS.table, roughness: 0.8 }));
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = tableHeightM;
  mesh.name = `generated-table-${safeName(table.id)}`;
  return mesh;
}

function chair(seat, tableKind) {
  const geometry = tableKind === 'circle'
    ? new THREE.CylinderGeometry(0.11, 0.11, 0.2, 16)
    : new THREE.BoxGeometry(0.22, 0.2, 0.22);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: COLORS.seat, roughness: 0.85 }));
  mesh.position.set(seat.position.x, 0.1, seat.position.z);
  mesh.rotation.y = chairYaw(seat.side);
  mesh.name = `generated-seat-${safeName(seat.id)}`;
  return mesh;
}

function chairYaw(side) {
  if (side === 'L') return Math.PI / 2;
  if (side === 'R') return -Math.PI / 2;
  if (side === 'T') return Math.PI;
  return 0;
}

function footprintOutline(footprint) {
  if (footprint.type !== 'circle') return footprint.points;
  return Array.from({ length: 48 }, (_, index) => {
    const angle = index / 48 * Math.PI * 2;
    return { x: footprint.center.x + Math.cos(angle) * footprint.radiusM, z: footprint.center.z + Math.sin(angle) * footprint.radiusM };
  });
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function clearGroup(group) {
  const children = [...group.children];
  // GLTFLoader may share a cached material, geometry, texture, or ImageBitmap
  // across sibling objects. Dispose once over the entire owner group, then detach.
  disposeObject(group);
  for (const child of children) group.remove(child);
}

export function disposeObject(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const imageBitmaps = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const material of list) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) {
        textures.add(value);
        if (typeof value.image?.close === 'function') imageBitmaps.add(value.image);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const image of imageBitmaps) image.close();
  for (const material of materials) material.dispose();
}
