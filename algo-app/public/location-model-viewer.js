import { LocationModelScene, disposeObject } from './location-model-viewer/scene.js';
import { GLTFLoader } from './location-model/vendor/three/GLTFLoader.js';
import { LoadingManager } from './location-model/vendor/three/three.module.js';

function assertSelfContainedGlbUris(buffer) {
  if (buffer.byteLength < 20) throw new Error('The GLB container is incomplete.');
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2
    || header.getUint32(8, true) !== buffer.byteLength) {
    throw new Error('The GLB container header is invalid.');
  }
  const jsonLength = header.getUint32(12, true);
  if (header.getUint32(16, true) !== 0x4e4f534a || jsonLength < 2 || 20 + jsonLength > buffer.byteLength) {
    throw new Error('The GLB JSON chunk is invalid.');
  }
  const text = new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)).replace(/\0+$/g, '').trim();
  const document = JSON.parse(text);
  for (const resource of [...(Array.isArray(document.buffers) ? document.buffers : []),
    ...(Array.isArray(document.images) ? document.images : [])]) {
    if (resource?.uri !== undefined && (typeof resource.uri !== 'string' || !/^data:/i.test(resource.uri))) {
      throw new Error('External GLB resources are not allowed.');
    }
  }
}

class LocationModelViewer extends HTMLElement {
  static async validateBuffer(buffer) {
    if (!(buffer instanceof ArrayBuffer)) throw new TypeError('A GLB byte buffer is required.');
    // Inspect the self-contained JSON references before GLTFLoader can attempt
    // to resolve any resource URI. Server-side GLB validation remains authoritative.
    assertSelfContainedGlbUris(buffer);
    const failedResources = [];
    const manager = new LoadingManager();
    manager.onError = (url) => failedResources.push(url);
    manager.setURLModifier((url) => {
      if (/^(?:data:|blob:)/i.test(url)) return url;
      failedResources.push(url);
      throw new Error('External GLB resources are not allowed.');
    });
    const parsed = await new GLTFLoader(manager).parseAsync(buffer.slice(0), '');
    try {
      if (failedResources.length) throw new Error('A GLB embedded resource could not be decoded.');
    } finally {
      disposeObject(parsed.scene);
    }
  }

  constructor() {
    super();
    this.scene = null;
  }

  connectedCallback() {
    if (this.scene) return;
    try {
      this.scene = new LocationModelScene(this);
    } catch {
      this.dispatchEvent(new CustomEvent('location-model-state', { detail: { state: 'error', message: 'The 3D preview could not be started in this browser.' } }));
    }
  }

  setFloor(value) { this.scene?.setFloor(value); }
  setTransform(value) { this.scene?.setTransform(value); }
  loadModel(value) { return this.scene?.loadModel(value); }
  resetCamera() { this.scene?.resetCamera(); }
  zoomIn() { this.scene?.zoom(1.25); }
  zoomOut() { this.scene?.zoom(0.8); }

  disconnectedCallback() {
    this.scene?.dispose();
    this.scene = null;
  }
}

if (!customElements.get('tm-location-model-viewer')) customElements.define('tm-location-model-viewer', LocationModelViewer);
