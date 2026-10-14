import type { ModelSceneDocument } from '../../features/location-editor/index.ts';
import type { LocationWorldTransform } from '../../../../src/shared/location-view.ts';

export interface LocationModelViewerElement extends HTMLElement {
  setFloor(value: ModelSceneDocument): void;
  setTransform(value: LocationWorldTransform): void;
  loadModel(value: ArrayBuffer): Promise<void> | undefined;
  /** Provides private assigned GLB buffers for scene-local parsing and rendering. */
  setFurnitureAssets(items: Array<{ assetId: string; buffer: ArrayBuffer }>): void;
  resetCamera(): void;
  zoomIn(): void;
  zoomOut(): void;
}

declare global {
  interface HTMLElementTagNameMap { 'tm-location-model-viewer': LocationModelViewerElement }
}

let viewerModule: Promise<void> | null = null;
let viewerModuleAttempt = 0;

interface LocationModelViewerConstructor extends CustomElementConstructor {
  validateBuffer(buffer: ArrayBuffer): Promise<void>;
}

/** Loads the edge-hosted, signed-in viewer module once per console document. */
export function ensureLocationModelViewer(): Promise<void> {
  if (customElements.get('tm-location-model-viewer')) return Promise.resolve();
  if (viewerModule) return viewerModule;
  const pending = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    // A failed module URL is cached in the document's module map. Give an
    // explicit retry a fresh URL so a transient edge read can recover.
    script.src = `/location-model-viewer.js?attempt=${++viewerModuleAttempt}`;
    script.dataset.locationModelViewer = 'true';
    script.onload = () => void customElements.whenDefined('tm-location-model-viewer').then(() => resolve());
    script.onerror = () => {
      script.remove();
      reject(new Error('The edge model viewer module could not be loaded.'));
    };
    document.head.append(script);
  });
  viewerModule = pending.catch((error: unknown) => {
    viewerModule = null;
    throw error;
  });
  return viewerModule;
}

/** Parses a local GLB through the same bounded edge-hosted viewer before attachment. */
export async function validateLocationModelBuffer(buffer: ArrayBuffer): Promise<void> {
  await ensureLocationModelViewer();
  const viewer = customElements.get('tm-location-model-viewer') as LocationModelViewerConstructor | undefined;
  if (!viewer) throw new Error('The location model parser is unavailable.');
  await viewer.validateBuffer(buffer);
}
