import * as THREE from '../location-model/vendor/three/three.module.js';
import { OrbitControls } from '../location-model/vendor/three/OrbitControls.js';
import { GLTFLoader } from '../location-model/vendor/three/GLTFLoader.js';

const COLORS = { floor: 0x8995a2, table: 0x57a0e8, seat: 0xe6edf4, sensor: 0xffa600 };

/** Owns one GLB root and a separate authored-coordinate overlay scene. */
export class LocationModelScene {
  constructor(host) {
    this.host = host;
    this.disposed = false;
    this.loadId = 0;
    this.widthM = 10;
    this.heightM = 10;
    this.floor = new THREE.Group();
    this.overlay = new THREE.Group();
    this.modelRoot = new THREE.Group();
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
    this.scene.add(key, this.floor, this.modelRoot, this.overlay);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(this.widthM / 2, 0, -this.heightM / 2);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    this.frameId = requestAnimationFrame(this.render);
  }

  setFloor(value) {
    if (this.disposed) return;
    this.widthM = value.widthM;
    this.heightM = value.heightM;
    clearGroup(this.floor);
    clearGroup(this.overlay);
    this.drawFloor();
    for (const table of value.tables) this.drawTable(table);
    for (const sensor of value.sensors) this.drawSensor(sensor);
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
    const bounds = new THREE.Box3();
    bounds.expandByPoint(new THREE.Vector3(0, 0, 0));
    bounds.expandByPoint(new THREE.Vector3(this.widthM, 0, -this.heightM));
    if (this.modelRoot.children.length) bounds.union(new THREE.Box3().setFromObject(this.modelRoot));
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1);
    this.controls.target.copy(center);
    this.camera.position.set(center.x + span * 0.8, center.y + span * 0.85, center.z + span * 1.05);
    this.camera.near = Math.max(0.01, span / 10000);
    this.camera.far = Math.max(1000, span * 20);
    this.camera.updateProjectionMatrix();
    this.controls.update();
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
  }

  drawTable(table) {
    this.overlay.add(lineLoop(table.outline.map((point) => [point.x, 0.025, point.z]), COLORS.table, 1));
    for (const seat of table.seats) this.overlay.add(sphere(seat.position, 0.075, COLORS.seat));
  }

  drawSensor(sensor) {
    this.overlay.add(sphere(sensor.position, 0.14, COLORS.sensor));
    const start = new THREE.Vector3(sensor.position.x, sensor.position.y, sensor.position.z);
    const direction = new THREE.Vector3(sensor.direction.x, 0, sensor.direction.z).normalize();
    this.overlay.add(new THREE.ArrowHelper(direction, start, 0.5, COLORS.sensor, 0.16, 0.1));
  }

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
