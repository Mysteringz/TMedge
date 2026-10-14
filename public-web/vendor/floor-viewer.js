/* <floor-viewer> — interactive 3D floor map for HKUMySeat.

   Attributes:
     src        GLB url                      room       node name to frame
     labels     "M1|M2|…" in table order     columns/rows  fallback marker grid
     free       "1,3,4"  tables with room    occupied   "2,5"  full tables
     dark       "7"      no sensor data      selected   1-based index, 0 = none
     directions "1" draws the walk from the way in to the selected table

   Events: `table-picked` with { index } when a table is clicked.
   Methods: resetView(), zoomToSeat(), setZoom(0..1), getZoom().

   Markers sit on the model's own tables where it gives us enough to find
   them, and fall back to a grid otherwise: a marker floating between two
   chairs helps nobody. three.js is served from /vendor (the page's CSP allows
   no CDN, and a campus network may not reach one). */
(function () {
  if (customElements.get('floor-viewer')) return;
  let libP = null;
  let gltfP = null;
  let libRetry = 0;
  let gltfRetry = 0;
  const retryQuery = (attempt) => attempt ? `?floor-viewer-retry=${attempt}` : '';
  function lib() {
    if (!libP) {
      const attempt = libRetry;
      libP = Promise.all([
        import(`./three/three.module.js${retryQuery(attempt)}`),
        import(`./three/OrbitControls.js${retryQuery(attempt)}`)
      ]).then(([T, oc]) => ({ THREE: T, OrbitControls: oc.OrbitControls })).catch((error) => {
        libP = null;
        libRetry = attempt + 1;
        throw error;
      });
    }
    return libP;
  }
  function gltfLoader() {
    if (!gltfP) {
      const attempt = gltfRetry;
      gltfP = import(`./three/GLTFLoader.js${retryQuery(attempt)}`).then((gl) => gl.GLTFLoader).catch((error) => {
        gltfP = null;
        gltfRetry = attempt + 1;
        throw error;
      });
    }
    return gltfP;
  }
  const cache = new Map();
  function loadGLB(GLTFLoader, src) {
    if (!cache.has(src)) {
      cache.set(src, new Promise((res, rej) => new GLTFLoader().load(src, (g) => res(g.scene), undefined, rej))
        .catch((err) => { cache.delete(src); throw err; }));
    }
    return cache.get(src).then((s) => {
      const clone = s.clone(true);
      clone.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
        }
      });
      return clone;
    });
  }
  function disposeObject(object, ownedGeometry = true) {
    if (!object) return;
    const geometries = new Set(), materials = new Set(), textures = new Set();
    object.traverse((o) => {
      if (ownedGeometry && o.geometry) geometries.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        materials.add(m);
        // Marker canvas textures are owned here; a model's textures and
        // geometry still belong to the shared GLB cache.
        if (ownedGeometry && m.map) textures.add(m.map);
      }
    });
    for (const t of textures) t.dispose();
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
  }
  const nums = (s) => (s || '').split(',').filter(Boolean).map(Number);
  const norm = (s) => (s || '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  const FREE = 0x0b8b7a;     // room for your group
  const PICKED = 0x006f62;   // the table you chose
  const FULL = 0x9b9797;
  const INK = 0x201e1d;
  const SIMPLE_ROOM_SOURCE = 'simple-rectangle-v1';
  const SIMPLE_ROOM_WALL_HEIGHT_M = 3;
  const SIMPLE_ROOM_TABLE_HEIGHT_M = 0.75;
  const FURNITURE_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

  function validFurnitureAssignment(value) {
    return !!value && typeof value.assetId === 'string' && FURNITURE_ID.test(value.assetId)
      && Number.isFinite(value.scale) && value.scale >= 0.01 && value.scale <= 100
      && Number.isFinite(value.yawDeg) && value.yawDeg >= -360 && value.yawDeg <= 360
      && Number.isFinite(value.elevationM) && value.elevationM >= 0 && value.elevationM <= 10;
  }

  function furnitureFootprintCentre(footprint) {
    if (!footprint) return null;
    if (footprint.type === 'circle') {
      const centre = { x: footprint.center?.x, z: footprint.center?.z };
      return Number.isFinite(centre.x) && Number.isFinite(centre.z) ? centre : null;
    }
    const points = footprint.points;
    if (!Array.isArray(points) || points.length < 3
      || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.z))) return null;
    let crossSum = 0, xSum = 0, zSum = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index], next = points[(index + 1) % points.length];
      const cross = current.x * next.z - next.x * current.z;
      crossSum += cross;
      xSum += (current.x + next.x) * cross;
      zSum += (current.z + next.z) * cross;
    }
    if (Math.abs(crossSum) < 1e-9) {
      const total = points.reduce((centre, point) => ({ x: centre.x + point.x, z: centre.z + point.z }), { x: 0, z: 0 });
      return { x: total.x / points.length, z: total.z / points.length };
    }
    return { x: xSum / (3 * crossSum), z: zSum / (3 * crossSum) };
  }

  function normalizeFurniture(THREE, scene) {
    const template = new THREE.Group();
    template.add(scene);
    template.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(template);
    if ([bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z]
      .some((value) => !Number.isFinite(value))) throw new Error('Invalid furniture bounds.');
    const centre = bounds.getCenter(new THREE.Vector3());
    template.position.set(-centre.x, -bounds.min.y, -centre.z);
    template.updateMatrixWorld(true);
    const normalized = new THREE.Box3().setFromObject(template);
    return { template, heightM: normalized.max.y };
  }

  class FloorViewer extends HTMLElement {
    static get observedAttributes() {
      return ['src', 'room', 'labels', 'free', 'occupied', 'dark', 'selected', 'directions', 'columns', 'rows', 'location-layout', 'model-transform', 'procedural-room'];
    }

    connectedCallback() {
      // The app re-renders this screen whenever the sensors report, which
      // moves the element: a disconnect immediately followed by a connect.
      clearTimeout(this._teardown);
      this._teardown = null;
      if (this._init) {
        if (this._stopped) { this._stopped = false; this._init = false; this.replaceChildren(); this.connectedCallback(); }
        return;
      }
      this._init = true;
      this.style.display = 'block';
      this.style.position = 'relative';
      this.style.width = '100%';
      this.style.height = this.style.height || '100%';
      this._msg = document.createElement('div');
      this._msg.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:600 12px/1.4 Archivo,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#7d7979;text-align:center;padding:16px';
      this._msg.textContent = 'Loading 3D floor…';
      this.appendChild(this._msg);
      this.boot();
    }

    attributeChangedCallback(n, o, v) {
      if (!this._ready || o === v) return;
      if (n === 'procedural-room') this.refresh();
      else if (n === 'src' || n === 'room') {
        if (this.getAttribute('procedural-room') !== SIMPLE_ROOM_SOURCE) this.refresh();
      }
      else if (n === 'model-transform') {
        this.applyModelTransform();
        this.updateLocationBounds();
        if (this._room) this.layoutMarkers();
      } else if (n === 'location-layout') {
        if (this.getAttribute('procedural-room') === SIMPLE_ROOM_SOURCE) {
          this.updateGeneratedRoom(this.readLocationLayout());
          return;
        }
        this.updateLocationBounds();
        if (this._room) this.layoutMarkers();
      } else if (this._room && this.getAttribute('procedural-room') === SIMPLE_ROOM_SOURCE) {
        this.updateGeneratedRoom(this.readLocationLayout());
      } else if (this._room) this.layoutMarkers();
    }

    disconnectedCallback() {
      // Only tear down if we are still detached on the next turn of the loop.
      this._teardown = setTimeout(() => {
        this._teardown = null;
        this._stopped = true;
        this._ready = false;
        this._token = Symbol();
        cancelAnimationFrame(this._animation);
        if (this._ro) this._ro.disconnect();
        if (this._three) this._three.controls.dispose();
        for (const k of ['_model', '_marks', '_path', '_generatedShell', '_generatedTables']) {
          disposeObject(this[k], k !== '_model'); this[k] = null;
        }
        this.clearFurnitureAssets();
        this._generatedTableRecords?.clear();
        this._authoredTableRecords?.clear();
        this._room = null;
        if (this._renderer) this._renderer.dispose();
      }, 0);
    }

    async boot() {
      let L;
      try { L = await lib(); } catch {
        this._msg.textContent = '3D map unavailable';
        this.dispatchEvent(new CustomEvent('viewer-error'));
        return;
      }
      if (this._stopped) return;
      const { THREE, OrbitControls } = L;
      this._L = L;
      const w = this.clientWidth || 800, h = this.clientHeight || 420;
      let renderer;
      try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); }
      catch {
        this._msg.textContent = '3D view unavailable. Use the floor map below.';
        this.dispatchEvent(new CustomEvent('viewer-error'));
        return;
      }
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.setSize(w, h);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab';
      this.appendChild(renderer.domElement);
      this._renderer = renderer;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(this.getAttribute('ground') || '#e6e4e4');
      // A long lens: a wide one blows the nearest corner of the room up and
      // pushes the camera back until the room is a stamp in the middle of the
      // building. 32 degrees keeps the floor close to flat on the screen.
      const camera = new THREE.PerspectiveCamera(32, w / h, 0.05, 2000);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.maxPolarAngle = Math.PI * 0.49;
      // Scroll and trackpad pinch both arrive as wheel events, and one notch
      // used to barely move the camera.
      controls.zoomSpeed = 2.2;
      controls.zoomToCursor = true;
      scene.add(new THREE.HemisphereLight(0xffffff, 0x9b9797, 2.1));
      const key = new THREE.DirectionalLight(0xffffff, 1.5);
      key.position.set(4, 9, 6);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xffffff, 0.6);
      fill.position.set(-6, 5, -4);
      scene.add(fill);
      this._three = { renderer, scene, camera, controls };
      this._wallVisibilityHandler = () => this.updateWallVisibility();
      controls.addEventListener('change', this._wallVisibilityHandler);
      this._ready = true;

      this._ro = new ResizeObserver(() => {
        const cw = this.clientWidth, ch = this.clientHeight;
        if (!cw || !ch) return;
        camera.aspect = cw / ch; camera.updateProjectionMatrix(); renderer.setSize(cw, ch);
        // A phone turned sideways is a different frame: re-fit, but only for
        // someone who has not moved the camera themselves.
        if (this._room && this._home && camera.position.distanceTo(this._home.pos) < 0.01) {
          this.frameRoom();
          this._home = { pos: camera.position.clone(), tgt: this._three.controls.target.clone() };
        }
      });
      this._ro.observe(this);

      renderer.domElement.addEventListener('pointerdown', (e) => { this._downAt = { x: e.clientX, y: e.clientY }; });
      renderer.domElement.addEventListener('pointerup', (e) => this.pick(e));

      const tick = () => {
        if (this._stopped) return;
        controls.update();
        this.keepInside();
        renderer.render(scene, camera);
        this._animation = requestAnimationFrame(tick);
      };
      tick();
      this.refresh();
    }

    /** Keep the camera in the building: it used to fly through the walls. */
    keepInside() {
      if (!this._room) return;
      const { camera, controls } = this._three;
      const { box } = this._room;
      const minY = box.min.y + 0.35;
      if (camera.position.y < minY) camera.position.y = minY;
      controls.target.x = Math.min(box.max.x, Math.max(box.min.x, controls.target.x));
      controls.target.z = Math.min(box.max.z, Math.max(box.min.z, controls.target.z));
    }

    async refresh() {
      const { THREE } = this._L;
      const { scene, camera, controls } = this._three;
      const token = (this._token = Symbol());
      if (this.getAttribute('procedural-room') === SIMPLE_ROOM_SOURCE) {
        this.clearSceneObjects();
        const layout = this.readLocationLayout();
        if (!layout) {
          this._msg.textContent = '3D view unavailable. Use the floor map below.';
          this.dispatchEvent(new CustomEvent('viewer-error'));
          return;
        }
        this.updateGeneratedRoom(layout, true);
        return;
      }
      const src = this.getAttribute('src');
      if (!src) { this.clearSceneObjects(); return; }
      if (this._msg && !this._msg.isConnected) this.appendChild(this._msg);
      if (this._msg) this._msg.textContent = 'Loading 3D floor…';
      this.clearSceneObjects();
      let model;
      try {
        const GLTFLoader = await gltfLoader();
        if (token !== this._token || this._stopped) return;
        model = await loadGLB(GLTFLoader, src);
      }
      catch {
        if (token !== this._token || this._stopped) return;
        this._msg.textContent = '3D view unavailable. Use the floor map below.';
        this.dispatchEvent(new CustomEvent('model-error'));
        return;
      }
      if (token !== this._token || this._stopped) { disposeObject(model, false); return; }
      this._msg.remove();

      this.applyModelTransform(model);

      model.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { if (m && m.color) { m.transparent = true; m.opacity = 0.92; } });
      });
      scene.add(model);
      this._model = model;

      // glTF sanitises node names: "Makerspace A floor" arrives as
      // "Makerspace_A_floor", so compare loosely.
      const roomName = norm(this.getAttribute('room'));
      let roomNode = null;
      model.traverse((o) => { if (!roomNode && roomName && norm(o.name) === roomName) roomNode = o; });
      // The model paints this room's floor a builder's yellow, which fights
      // every marking we put on top of it. Repaint it -- on a copy of the
      // material, because the same one is used all over the building.
      if (roomNode) {
        roomNode.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const mats = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => {
            const c = m; // loadGLB already gave this view its own material
            if (c.color) c.color.setHex(0xe8ece9);
            if (c.emissive) c.emissive.setHex(0x000000);
            c.transparent = true; c.opacity = 0.95;
            return c;
          });
          o.material = Array.isArray(o.material) ? mats : mats[0];
        });
      }
      const box = new THREE.Box3().setFromObject(this.readLocationLayout() ? model : roomNode || model);
      const locationLayout = this.readLocationLayout();
      if (locationLayout) box.union(this.authoredFloorBounds(locationLayout));
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      this._room = { box, size, centre, spots: locationLayout ? null : this.findTables(model, box) };

      this.layoutMarkers();

      const radius = Math.max(size.x, size.z, 1) * 0.5;
      // The model can arrive before the panel has been measured, and fitting
      // to a square frame that never existed is how the room ends up small in
      // the middle of the building.
      if (this.clientWidth && this.clientHeight) camera.aspect = this.clientWidth / this.clientHeight;
      camera.near = radius / 400; camera.far = radius * 80; camera.updateProjectionMatrix();
      controls.minDistance = radius * 0.25;
      controls.maxDistance = radius * 8;
      // Look down the room's short axis, so its long side runs across the
      // panel rather than diagonally through it: the map is twice as wide as
      // it is tall, and a corner-on view throws half of that width away.
      this._view = {
        dir: (size.x >= size.z
          ? new THREE.Vector3(0.24, 0.78, 0.9)
          : new THREE.Vector3(0.9, 0.78, 0.24)).normalize(),
        target: new THREE.Vector3(centre.x, box.min.y + Math.min(size.y, radius) * 0.15, centre.z),
      };
      this.frameRoom();
      this._home = { pos: camera.position.clone(), tgt: controls.target.clone() };
      this.dispatchEvent(new CustomEvent('model-ready'));
    }

    readLocationLayout() {
      try {
        const layout = JSON.parse(this.getAttribute('location-layout') || 'null');
        return layout && Number.isFinite(layout.widthM) && layout.widthM > 0
          && Number.isFinite(layout.depthM) && layout.depthM > 0 && Array.isArray(layout.tables) ? layout : null;
      } catch { return null; }
    }

    clearSceneObjects() {
      if (!this._three) return;
      const { scene } = this._three;
      for (const key of ['_model', '_marks', '_path', '_generatedShell', '_generatedTables']) {
        if (!this[key]) continue;
        scene.remove(this[key]);
        disposeObject(this[key], key !== '_model');
        this[key] = null;
      }
      this.clearFurnitureAssets();
      this._generatedTableRecords?.clear();
      this._authoredTableRecords?.clear();
      this._room = null;
      this._focus = null;
      this._seat = null;
      this._pickables = [];
      this._generatedDimensions = null;
      this._walls = null;
      this._home = null;
      this._view = null;
    }

    clearFurnitureAssets() {
      const { scene } = this._three || {};
      if (this._furnitureGroup && scene) scene.remove(this._furnitureGroup);
      this._furnitureInstances?.clear();
      this._furnitureInstances = new Map();
      for (const entry of this._furnitureLoads?.values() || []) {
        entry.controller?.abort();
        if (entry.template) disposeObject(entry.template);
      }
      this._furnitureLoads = new Map();
      this._furnitureGroup = null;
      this._furnitureAssetIds = new Set();
      this._furnitureLayout = null;
      this._furnitureGenerated = false;
      this._furnitureHadFailure = false;
    }

    loadedFurniture(assignment) {
      if (!validFurnitureAssignment(assignment)) return null;
      const entry = this._furnitureLoads?.get(assignment.assetId);
      return entry?.status === 'loaded' ? entry : null;
    }

    reconcileFurniture(layout, generated) {
      if (!this._three || !layout) return;
      if (!this._furnitureGroup) {
        this._furnitureGroup = new this._L.THREE.Group();
        this._three.scene.add(this._furnitureGroup);
      }
      if (!this._furnitureInstances) this._furnitureInstances = new Map();
      if (!this._furnitureLoads) this._furnitureLoads = new Map();
      this._furnitureLayout = layout;
      this._furnitureGenerated = generated;
      const needed = new Set();
      for (const table of layout.tables) {
        for (const assignment of [table.furniture?.table, table.furniture?.chair]) {
          if (validFurnitureAssignment(assignment)) needed.add(assignment.assetId);
        }
      }
      this._furnitureAssetIds = needed;
      const stale = [];
      for (const [assetId, entry] of this._furnitureLoads) {
        if (needed.has(assetId)) continue;
        this._furnitureLoads.delete(assetId);
        entry.controller?.abort();
        stale.push(entry);
      }
      this.reconcileFurnitureInstances(layout);
      for (const entry of stale) if (entry.template) disposeObject(entry.template);
      for (const assetId of needed) {
        if (!this._furnitureLoads.has(assetId)) this.startFurnitureLoad(assetId);
      }
      this.refreshFurniturePresentation(layout, generated);
      this.reportFurnitureRecoveryIfResolved();
    }

    startFurnitureLoad(assetId) {
      const entry = { status: 'loading', controller: new AbortController(), template: null, heightM: 0 };
      this._furnitureLoads.set(assetId, entry);
      void this.loadFurnitureAsset(assetId, entry);
    }

    async loadFurnitureAsset(assetId, entry) {
      let candidate = null;
      try {
        const response = await fetch(`/api/models/${encodeURIComponent(assetId)}`, { signal: entry.controller.signal });
        if (!response.ok) throw new Error('Furniture request failed.');
        const bytes = await response.arrayBuffer();
        const GLTFLoader = await gltfLoader();
        if (!this.isCurrentFurnitureLoad(assetId, entry)) return;
        const result = await new GLTFLoader().parseAsync(bytes, '');
        candidate = result.scene;
        if (!this.isCurrentFurnitureLoad(assetId, entry)) {
          disposeObject(candidate);
          return;
        }
        const normalized = normalizeFurniture(this._L.THREE, candidate);
        if (!Number.isFinite(normalized.heightM) || normalized.heightM < 0) throw new Error('Invalid furniture height.');
        entry.template = normalized.template;
        entry.heightM = normalized.heightM;
        entry.status = 'loaded';
        candidate = null;
        this.reconcileFurnitureInstances(this._furnitureLayout);
        this.refreshFurniturePresentation(this._furnitureLayout, this._furnitureGenerated);
        this.reportFurnitureRecoveryIfResolved();
      } catch {
        if (candidate) disposeObject(candidate);
        if (!this.isCurrentFurnitureLoad(assetId, entry)) return;
        entry.status = 'error';
        this.refreshFurniturePresentation(this._furnitureLayout, this._furnitureGenerated);
        this._furnitureHadFailure = true;
        this.dispatchEvent(new CustomEvent('model-error'));
      }
    }

    isCurrentFurnitureLoad(assetId, entry) {
      return !this._stopped && this._furnitureLoads?.get(assetId) === entry;
    }

    reconcileFurnitureInstances(layout) {
      if (!this._furnitureGroup || !layout) return;
      const desired = new Map();
      for (const table of layout.tables) {
        const tableAssignment = table.furniture?.table;
        const tableEntry = this.loadedFurniture(tableAssignment);
        const tableAnchor = tableEntry ? furnitureFootprintCentre(table.footprint) : null;
        if (tableEntry && tableAnchor) {
          desired.set(`table:${table.id}:table`, {
            assetId: tableAssignment.assetId, assignment: tableAssignment, tableId: table.id,
            slot: 'table', seatId: null, anchor: tableAnchor, canonicalYaw: 0,
          });
        }
        const chairAssignment = table.furniture?.chair;
        if (!this.loadedFurniture(chairAssignment)) continue;
        for (const seat of table.seats) {
          if (!Number.isFinite(seat.x) || !Number.isFinite(seat.z)
            || !['L', 'R', 'T', 'B'].includes(seat.side)) continue;
          const canonicalYaw = seat.side === 'L' ? Math.PI / 2 : seat.side === 'R' ? -Math.PI / 2 : seat.side === 'T' ? Math.PI : 0;
          desired.set(`table:${table.id}:chair:${seat.id}`, {
            assetId: chairAssignment.assetId, assignment: chairAssignment, tableId: table.id,
            slot: 'chair', seatId: seat.id, anchor: { x: seat.x, z: seat.z }, canonicalYaw,
          });
        }
      }
      for (const [key, instance] of this._furnitureInstances) {
        const spec = desired.get(key);
        if (spec && instance._furnitureSignature === this.furnitureInstanceSignature(spec)) continue;
        this._furnitureGroup.remove(instance);
        this._furnitureInstances.delete(key);
      }
      for (const [key, spec] of desired) {
        if (this._furnitureInstances.has(key)) continue;
        const entry = this._furnitureLoads.get(spec.assetId);
        if (!entry?.template) continue;
        const root = new this._L.THREE.Group();
        root.add(entry.template.clone(true));
        root.scale.setScalar(spec.assignment.scale);
        root.rotation.y = spec.canonicalYaw + spec.assignment.yawDeg * Math.PI / 180;
        root.position.set(spec.anchor.x, spec.assignment.elevationM, spec.anchor.z);
        root.name = `furniture-${spec.slot}-${spec.tableId}${spec.seatId ? `-${spec.seatId}` : ''}`;
        root.userData = {
          assetId: spec.assetId, tableId: spec.tableId, slot: spec.slot,
          ...(spec.seatId ? { seatId: spec.seatId } : {}),
        };
        root._furnitureSignature = this.furnitureInstanceSignature(spec);
        this._furnitureGroup.add(root);
        this._furnitureInstances.set(key, root);
      }
    }

    furnitureInstanceSignature(spec) {
      return JSON.stringify([spec.assetId, spec.assignment.scale, spec.assignment.yawDeg,
        spec.assignment.elevationM, spec.anchor.x, spec.anchor.z, spec.canonicalYaw]);
    }

    refreshFurniturePresentation(layout, generated) {
      if (!layout) return;
      this._pickables = [];
      const selectedId = typeof layout.selectedTableId === 'string' ? layout.selectedTableId : null;
      for (const table of layout.tables) {
        if (generated) {
          const record = this._generatedTableRecords?.get(table.id);
          if (!record) continue;
          this.updateGeneratedTableRecord(record, table, selectedId === table.id);
          const pickable = record.tableStatus.visible ? record.tableStatus : record.plate;
          if (pickable) this._pickables.push(pickable);
        } else {
          const record = this._authoredTableRecords?.get(table.id);
          if (!record) continue;
          this.updateAuthoredTableRecord(record, table, selectedId === table.id);
          this._pickables.push(record.plate);
        }
      }
    }

    reportFurnitureRecoveryIfResolved() {
      if (!this._furnitureHadFailure) return;
      for (const assetId of this._furnitureAssetIds || []) {
        if (this._furnitureLoads.get(assetId)?.status !== 'loaded') return;
      }
      this._furnitureHadFailure = false;
      const eventName = this._furnitureGenerated ? 'viewer-ready' : 'model-ready';
      this.dispatchEvent(new CustomEvent(eventName));
    }

    authoredFloorBounds(layout) {
      const { THREE } = this._L;
      return new THREE.Box3(
        new THREE.Vector3(0, -0.05, -layout.depthM),
        new THREE.Vector3(layout.widthM, 0.08, 0),
      );
    }

    applyModelTransform(model = this._model) {
      if (!model) return;
      let transform;
      try { transform = JSON.parse(this.getAttribute('model-transform') || 'null'); } catch { return; }
      if (!transform) return;
      const vectors = [transform.scale, transform.rotationRad, transform.positionM];
      if (vectors.some((vector) => !vector || !['x', 'y', 'z'].every((key) => Number.isFinite(vector[key])))) return;
      model.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
      model.rotation.order = 'XYZ';
      model.rotation.set(transform.rotationRad.x, transform.rotationRad.y, transform.rotationRad.z, 'XYZ');
      model.position.set(transform.positionM.x, transform.positionM.y, transform.positionM.z);
      model.updateMatrixWorld(true);
    }

    updateLocationBounds() {
      if (!this._model || !this._L || !this._three) return;
      const layout = this.readLocationLayout();
      if (!layout) return;
      const { THREE } = this._L;
      const box = new THREE.Box3().setFromObject(this._model);
      box.union(this.authoredFloorBounds(layout));
      this._room = { box, size: box.getSize(new THREE.Vector3()), centre: box.getCenter(new THREE.Vector3()), spots: null };
    }

    layoutAuthoredMarkers(layout) {
      const { THREE } = this._L;
      const { scene } = this._three;
      if (!this._marks) { this._marks = new THREE.Group(); scene.add(this._marks); }
      const previous = this._authoredTableRecords || new Map();
      const next = new Map();
      const selectedId = typeof layout.selectedTableId === 'string' ? layout.selectedTableId : null;
      this._pickables = [];
      this._focus = null;
      for (const table of layout.tables) {
        const centre = this.footprintCentre(table.footprint);
        if (!centre) continue;
        const signature = this.tableGeometrySignature(table);
        let record = previous.get(table.id);
        if (!record || record.signature !== signature) {
          if (record) { this._marks.remove(record.group); disposeObject(record.group); }
          record = this.createAuthoredTableRecord(table, centre, signature);
          this._marks.add(record.group);
        } else if (record.name !== table.name) {
          record.group.remove(record.label);
          disposeObject(record.label);
          record.label = this.createTableLabel(table.name, table.footprint, centre, 0.04);
          record.group.add(record.label);
          record.name = table.name;
        }
        this.updateAuthoredTableRecord(record, table, selectedId === table.id);
        next.set(table.id, record);
        this._pickables.push(record.plate);
        if (selectedId === table.id) this._focus = new THREE.Vector3(centre.x, 0.025, centre.z);
      }
      for (const [id, record] of previous) {
        if (next.has(id)) continue;
        this._marks.remove(record.group);
        disposeObject(record.group);
      }
      this._authoredTableRecords = next;
      this.reconcileFurniture(layout, false);
      this.clearPath();
      this._seat = (this._focus || this._room.centre).clone();
      if (this.getAttribute('directions') === '1' && this._focus) this.drawRoute(this._focus);
    }

    footprintCentre(footprint) {
      if (!footprint) return null;
      if (footprint.type === 'circle') return { x: footprint.center.x, z: footprint.center.z };
      if (!Array.isArray(footprint.points) || footprint.points.length < 3) return null;
      const xs = footprint.points.map((point) => point.x), zs = footprint.points.map((point) => point.z);
      return { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
    }

    footprintSize(footprint) {
      if (footprint.type === 'circle') return { width: footprint.radiusM * 2, depth: footprint.radiusM * 2 };
      const xs = footprint.points.map((point) => point.x), zs = footprint.points.map((point) => point.z);
      return { width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...zs) - Math.min(...zs) };
    }

    footprintShape(footprint, centre) {
      const { THREE } = this._L;
      const shape = new THREE.Shape();
      if (footprint.type === 'circle') {
        shape.absarc(0, 0, footprint.radiusM, 0, Math.PI * 2, false);
        return shape;
      }
      footprint.points.forEach((point, index) => {
        const x = point.x - centre.x;
        const y = centre.z - point.z;
        if (index === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
      });
      shape.closePath();
      return shape;
    }

    authoredShapeGeometry(footprint, centre) {
      const { THREE } = this._L;
      return new THREE.ShapeGeometry(this.footprintShape(footprint, centre)).rotateX(-Math.PI / 2);
    }

    tableGeometrySignature(table) {
      return JSON.stringify([table.footprint, table.seats.map((seat) => [seat.id, seat.x, seat.z, seat.side])]);
    }

    createTableLabel(name, footprint, centre, y) {
      const size = this.footprintSize(footprint);
      const label = this.label(name, Math.max(0.2, Math.min(size.width, size.depth) * 0.42), '#ffffff');
      label.position.set(centre.x, y, centre.z);
      label.renderOrder = 9;
      return label;
    }

    createAuthoredTableRecord(table, centre, signature) {
      const { THREE } = this._L;
      const group = new THREE.Group();
      const material = new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.48, depthTest: false, depthWrite: false });
      const plate = new THREE.Mesh(this.authoredShapeGeometry(table.footprint, centre), material);
      plate.position.set(centre.x, 0.025, centre.z);
      plate.renderOrder = 8;
      plate.userData.tableId = table.id;
      group.add(plate);
      const seats = new Map();
      for (const seat of table.seats) {
        const marker = new THREE.Mesh(new THREE.CircleGeometry(0.045, 12), new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.48, depthTest: false, depthWrite: false }));
        marker.rotation.x = -Math.PI / 2;
        marker.position.set(seat.x, 0.05, seat.z);
        marker.renderOrder = 10;
        group.add(marker);
        seats.set(seat.id, marker);
      }
      const label = this.createTableLabel(table.name, table.footprint, centre, 0.04);
      group.add(label);
      return { group, plate, label, seats, signature, name: table.name };
    }

    updateAuthoredTableRecord(record, table, picked) {
      const status = table.status;
      const color = picked ? PICKED : status === 'free' ? FREE : status === 'full' ? FULL : INK;
      const tableModel = furnitureFootprintCentre(table.footprint)
        ? this.loadedFurniture(table.furniture?.table) : null;
      record.plate.position.y = tableModel
        ? tableModel.heightM * table.furniture.table.scale + table.furniture.table.elevationM + 0.025
        : 0.025;
      record.label.position.y = tableModel
        ? tableModel.heightM * table.furniture.table.scale + table.furniture.table.elevationM + 0.04
        : 0.04;
      record.plate.material.color.setHex(color);
      record.plate.material.opacity = status === 'unknown' ? 0.38 : picked ? 0.82 : status === 'free' ? 0.62 : 0.58;
      record.label.material.color.setHex(picked || status === 'free' ? 0xffffff : INK);
      const chairModel = this.loadedFurniture(table.furniture?.chair);
      for (const seat of table.seats) {
        const marker = record.seats.get(seat.id);
        if (!marker) continue;
        const known = typeof seat.occupied === 'boolean';
        const validSeatAnchor = Number.isFinite(seat.x) && Number.isFinite(seat.z)
          && ['L', 'R', 'T', 'B'].includes(seat.side);
        marker.position.y = chairModel && validSeatAnchor
          ? chairModel.heightM * table.furniture.chair.scale + table.furniture.chair.elevationM + 0.05
          : 0.05;
        marker.material.color.setHex(known ? seat.occupied ? FULL : FREE : INK);
        marker.material.opacity = known ? 0.92 : 0.48;
      }
    }

    updateGeneratedRoom(layout, resetCamera = false) {
      if (!this._three || !this._L || !layout) return;
      const { THREE } = this._L;
      const { scene, camera, controls } = this._three;
      const dimensionsChanged = !this._generatedDimensions
        || this._generatedDimensions.widthM !== layout.widthM || this._generatedDimensions.depthM !== layout.depthM;
      if (dimensionsChanged) {
        if (this._generatedShell) { scene.remove(this._generatedShell); disposeObject(this._generatedShell); }
        this._generatedShell = this.createGeneratedShell(layout.widthM, layout.depthM);
        scene.add(this._generatedShell);
        this._generatedDimensions = { widthM: layout.widthM, depthM: layout.depthM };
        if (!this._generatedTables) { this._generatedTables = new THREE.Group(); scene.add(this._generatedTables); }
      }
      const box = new THREE.Box3(new THREE.Vector3(0, -0.05, -layout.depthM),
        new THREE.Vector3(layout.widthM, SIMPLE_ROOM_WALL_HEIGHT_M, 0));
      this._room = { box, size: box.getSize(new THREE.Vector3()), centre: box.getCenter(new THREE.Vector3()), spots: null };
      this._view = this._view || {
        dir: (layout.widthM >= layout.depthM
          ? new THREE.Vector3(0.24, 0.78, 0.9)
          : new THREE.Vector3(0.9, 0.78, 0.24)).normalize(),
        target: new THREE.Vector3(layout.widthM / 2, 0.2, -layout.depthM / 2),
      };
      this.reconcileGeneratedTables(layout);
      this.updateWallVisibility();
      if (resetCamera || !this._home) {
        const radius = Math.max(layout.widthM, layout.depthM, 1) * 0.5;
        camera.near = radius / 400; camera.far = radius * 80; camera.updateProjectionMatrix();
        controls.minDistance = radius * 0.25;
        controls.maxDistance = radius * 8;
        this.frameRoom();
        this._home = { pos: camera.position.clone(), tgt: controls.target.clone() };
      }
      if (this._msg) this._msg.remove();
      // Selection, live availability, and directions updates all refresh the
      // generated scene. Do not let one of those routine updates clear the
      // student's failure fallback while an assigned furniture asset still
      // needs an explicit retry.
      if (!this._furnitureHadFailure) this.dispatchEvent(new CustomEvent('viewer-ready'));
    }

    createGeneratedShell(widthM, depthM) {
      const { THREE } = this._L;
      const shell = new THREE.Group();
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(widthM, depthM), new THREE.MeshStandardMaterial({ color: 0xe8ece9, roughness: 0.92 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(widthM / 2, -0.01, -depthM / 2);
      floor.userData.roomPart = 'floor';
      shell.add(floor);
      const walls = new THREE.Group();
      const material = new THREE.MeshStandardMaterial({ color: 0xd5d2cf, roughness: 0.86, side: THREE.DoubleSide });
      const thickness = 0.1;
      for (const [side, x, z, wallWidth, wallDepth] of [
        ['west', 0, -depthM / 2, thickness, depthM + thickness],
        ['east', widthM, -depthM / 2, thickness, depthM + thickness],
        ['south', widthM / 2, 0, widthM + thickness, thickness],
        ['north', widthM / 2, -depthM, widthM + thickness, thickness],
      ]) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(wallWidth, SIMPLE_ROOM_WALL_HEIGHT_M, wallDepth), material);
        wall.position.set(x, SIMPLE_ROOM_WALL_HEIGHT_M / 2, z);
        wall.userData.roomWall = side;
        walls.add(wall);
      }
      shell.add(walls);
      this._walls = Object.fromEntries(walls.children.map((wall) => [wall.userData.roomWall, wall]));
      return shell;
    }

    updateWallVisibility() {
      if (!this._walls || !this._three || !this._room) return;
      const { camera } = this._three;
      const centreX = (this._room.box.min.x + this._room.box.max.x) / 2;
      const centreZ = (this._room.box.min.z + this._room.box.max.z) / 2;
      const dx = camera.position.x - centreX, dz = camera.position.z - centreZ;
      const magnitude = Math.hypot(dx, dz) || 1;
      const xFacing = Math.abs(dx / magnitude) > 0.45;
      const zFacing = Math.abs(dz / magnitude) > 0.45;
      if (this._walls.east) this._walls.east.visible = !(xFacing && dx > 0);
      if (this._walls.west) this._walls.west.visible = !(xFacing && dx < 0);
      if (this._walls.south) this._walls.south.visible = !(zFacing && dz > 0);
      if (this._walls.north) this._walls.north.visible = !(zFacing && dz < 0);
    }

    reconcileGeneratedTables(layout) {
      const { THREE } = this._L;
      const previous = this._generatedTableRecords || new Map();
      const next = new Map();
      this._pickables = [];
      this._focus = null;
      const selectedId = typeof layout.selectedTableId === 'string' ? layout.selectedTableId : null;
      for (const table of layout.tables) {
        const centre = this.footprintCentre(table.footprint);
        if (!centre) continue;
        const signature = this.tableGeometrySignature(table);
        let record = previous.get(table.id);
        if (!record || record.signature !== signature) {
          if (record) { this._generatedTables.remove(record.group); disposeObject(record.group); }
          record = this.createGeneratedTableRecord(table, centre, signature);
          this._generatedTables.add(record.group);
        } else if (record.name !== table.name) {
          record.group.remove(record.label);
          disposeObject(record.label);
          record.label = this.createTableLabel(table.name, table.footprint, centre, SIMPLE_ROOM_TABLE_HEIGHT_M + 0.015);
          record.group.add(record.label);
          record.name = table.name;
        }
        this.updateGeneratedTableRecord(record, table, selectedId === table.id);
        next.set(table.id, record);
        const pickable = record.tableStatus.visible ? record.tableStatus : record.plate;
        if (pickable) this._pickables.push(pickable);
        if (selectedId === table.id) this._focus = new THREE.Vector3(centre.x, SIMPLE_ROOM_TABLE_HEIGHT_M, centre.z);
      }
      for (const [id, record] of previous) {
        if (next.has(id)) continue;
        this._generatedTables.remove(record.group);
        disposeObject(record.group);
      }
      this._generatedTableRecords = next;
      this.reconcileFurniture(layout, true);
      this.clearPath();
      this._seat = (this._focus || this._room.centre).clone();
      if (this.getAttribute('directions') === '1' && this._focus) this.drawRoute(this._focus);
    }

    createGeneratedTableRecord(table, centre, signature) {
      const { THREE } = this._L;
      const group = new THREE.Group();
      const tableFallback = new THREE.Group();
      tableFallback.userData = { tableId: table.id, slot: 'table' };
      const chairFallback = new THREE.Group();
      chairFallback.userData = { tableId: table.id, slot: 'chair' };
      const geometry = new THREE.ExtrudeGeometry(this.footprintShape(table.footprint, centre), { depth: SIMPLE_ROOM_TABLE_HEIGHT_M, bevelEnabled: false, curveSegments: 32 });
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshStandardMaterial({ color: INK, roughness: 0.78, transparent: true, opacity: 0.68 });
      const plate = new THREE.Mesh(geometry, material);
      plate.position.set(centre.x, 0, centre.z);
      plate.userData.tableId = table.id;
      tableFallback.add(plate);
      const tableStatus = new THREE.Mesh(this.authoredShapeGeometry(table.footprint, centre),
        new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.28, depthTest: false, depthWrite: false }));
      tableStatus.position.set(centre.x, SIMPLE_ROOM_TABLE_HEIGHT_M + 0.012, centre.z);
      tableStatus.renderOrder = 8;
      tableStatus.userData.tableId = table.id;
      tableStatus.visible = false;
      const seats = new Map();
      const seatIndicators = new Map();
      for (const seat of table.seats) {
        const shape = table.footprint.type === 'circle' ? new THREE.CylinderGeometry(0.105, 0.105, 0.2, 16) : new THREE.BoxGeometry(0.24, 0.2, 0.2);
        const seatMaterial = new THREE.MeshStandardMaterial({ color: INK, roughness: 0.82, transparent: true, opacity: 0.52 });
        const chair = new THREE.Mesh(shape, seatMaterial);
        chair.position.set(seat.x, 0.1, seat.z);
        chair.rotation.y = seat.side === 'L' ? Math.PI / 2 : seat.side === 'R' ? -Math.PI / 2 : seat.side === 'T' ? Math.PI : 0;
        chair.userData.seatId = seat.id;
        chairFallback.add(chair);
        seats.set(seat.id, chair);
        const indicator = new THREE.Mesh(new THREE.RingGeometry(0.105, 0.14, 16),
          new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
        indicator.rotation.x = -Math.PI / 2;
        indicator.position.set(seat.x, 0.022, seat.z);
        indicator.renderOrder = 7;
        indicator.userData.seatId = seat.id;
        indicator.visible = false;
        group.add(indicator);
        seatIndicators.set(seat.id, indicator);
      }
      const label = this.createTableLabel(table.name, table.footprint, centre, SIMPLE_ROOM_TABLE_HEIGHT_M + 0.015);
      group.add(tableFallback, chairFallback, tableStatus);
      group.add(label);
      return { group, tableFallback, chairFallback, plate, tableStatus, label, seats, seatIndicators, signature, name: table.name };
    }

    updateGeneratedTableRecord(record, table, picked) {
      const { THREE } = this._L;
      const status = table.status;
      const color = picked ? PICKED : status === 'free' ? FREE : status === 'full' ? FULL : INK;
      const tableModel = furnitureFootprintCentre(table.footprint)
        ? this.loadedFurniture(table.furniture?.table) : null;
      if (tableModel && record.plate) {
        record.tableFallback.remove(record.plate);
        disposeObject(record.plate);
        record.plate = null;
      } else if (!tableModel && !record.plate) {
        const centre = this.footprintCentre(table.footprint);
        const geometry = new THREE.ExtrudeGeometry(this.footprintShape(table.footprint, centre), { depth: SIMPLE_ROOM_TABLE_HEIGHT_M, bevelEnabled: false, curveSegments: 32 });
        geometry.rotateX(-Math.PI / 2);
        record.plate = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: INK, roughness: 0.78, transparent: true, opacity: 0.68 }));
        record.plate.position.set(centre.x, 0, centre.z);
        record.plate.userData.tableId = table.id;
        record.tableFallback.add(record.plate);
      }
      record.tableStatus.visible = !!tableModel;
      if (tableModel) {
        record.tableStatus.position.y = tableModel.heightM * table.furniture.table.scale + table.furniture.table.elevationM + 0.012;
        record.tableStatus.material.color.setHex(color);
        record.tableStatus.material.opacity = status === 'unknown' ? 0.18 : picked ? 0.4 : status === 'free' ? 0.32 : 0.28;
        record.label.position.y = record.tableStatus.position.y + 0.012;
      } else if (record.plate) {
        record.plate.material.color.setHex(color);
        record.plate.material.opacity = status === 'unknown' ? 0.62 : picked ? 0.96 : status === 'free' ? 0.9 : 0.82;
        record.label.position.y = SIMPLE_ROOM_TABLE_HEIGHT_M + 0.015;
      }
      record.label.material.color.setHex(picked || status === 'free' ? 0xffffff : INK);
      const chairModel = this.loadedFurniture(table.furniture?.chair);
      for (const seat of table.seats) {
        const validSeatAnchor = Number.isFinite(seat.x) && Number.isFinite(seat.z)
          && ['L', 'R', 'T', 'B'].includes(seat.side);
        const seatModel = validSeatAnchor ? chairModel : null;
        const chair = record.seats.get(seat.id);
        if (seatModel && chair) {
          record.chairFallback.remove(chair);
          disposeObject(chair);
          record.seats.delete(seat.id);
        } else if (!seatModel && !chair) {
          const shape = table.footprint.type === 'circle' ? new THREE.CylinderGeometry(0.105, 0.105, 0.2, 16) : new THREE.BoxGeometry(0.24, 0.2, 0.2);
          const proxy = new THREE.Mesh(shape, new THREE.MeshStandardMaterial({ color: INK, roughness: 0.82, transparent: true, opacity: 0.52 }));
          proxy.position.set(seat.x, 0.1, seat.z);
          proxy.rotation.y = seat.side === 'L' ? Math.PI / 2 : seat.side === 'R' ? -Math.PI / 2 : seat.side === 'T' ? Math.PI : 0;
          proxy.userData.seatId = seat.id;
          record.chairFallback.add(proxy);
          record.seats.set(seat.id, proxy);
        }
        const currentChair = record.seats.get(seat.id);
        const indicator = record.seatIndicators.get(seat.id);
        indicator.visible = !!seatModel;
        indicator.position.y = seatModel
          ? seatModel.heightM * table.furniture.chair.scale + table.furniture.chair.elevationM + 0.04
          : 0.022;
        const known = typeof seat.occupied === 'boolean';
        const seatColor = known ? seat.occupied ? FULL : FREE : INK;
        if (currentChair) {
          currentChair.material.color.setHex(seatColor);
          currentChair.material.opacity = known ? 0.98 : 0.58;
        }
        indicator.material.color.setHex(seatColor);
        indicator.material.opacity = known ? 0.98 : 0.58;
      }
    }

    clearPath() {
      if (!this._path || !this._three) return;
      this._three.scene.remove(this._path);
      disposeObject(this._path);
      this._path = null;
    }

    /**
     * Fit the room to this viewport, rather than to a guessed radius. The map
     * is a wide, short panel, so a distance chosen for a square frame leaves
     * the room a postage stamp in the middle of the rest of the building --
     * which is what the first version did. Project the room's corners into the
     * camera's own axes and take the distance that just contains them.
     */
    frameRoom() {
      const { THREE } = this._L;
      const { camera, controls } = this._three;
      const { box } = this._room;
      const tanV = Math.tan((camera.fov * Math.PI) / 360);
      const tanH = tanV * camera.aspect;
      const target = this._view.target;
      const back = this._view.dir.clone();        // target -> camera
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), back).normalize();
      const up = new THREE.Vector3().crossVectors(back, right).normalize();
      const c = new THREE.Vector3();
      let dist = 0;
      for (let i = 0; i < 8; i++) {
        c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(target);
        const z = c.dot(back);
        dist = Math.max(dist, Math.abs(c.dot(right)) / tanH + z, Math.abs(c.dot(up)) / tanV + z);
      }
      controls.target.copy(target);
      camera.position.copy(target.clone().add(back.multiplyScalar(Math.max(dist * 1.06, controls.minDistance))));
      controls.update();
    }

    /**
     * The tables themselves, from the model's own fit-out: meshes inside the
     * room, at desk height, desk-sized. Returns null when the model does not
     * give a clean answer, and the grid is used instead.
     */
    findTables(model, box) {
      const { THREE } = this._L;
      const want = Math.max(1, (Number(this.getAttribute('columns')) || 5) * (Number(this.getAttribute('rows')) || 2));
      const floorY = box.min.y;
      const candidates = [];
      model.traverse((o) => {
        if (!o.isMesh) return;
        const b = new THREE.Box3().setFromObject(o);
        const c = b.getCenter(new THREE.Vector3());
        if (c.x < box.min.x || c.x > box.max.x || c.z < box.min.z || c.z > box.max.z) return;
        const s = b.getSize(new THREE.Vector3());
        const height = c.y - floorY;
        if (height < 0.25 || height > 1.4) return;              // waist high
        const long = Math.max(s.x, s.z), short = Math.min(s.x, s.z);
        if (long < 0.6 || long > 3.5 || short < 0.35 || s.y > 1.2) return;   // desk-sized and flat
        candidates.push({ c, area: s.x * s.z, top: b.max.y, w: s.x, d: s.z });
      });
      if (candidates.length < want) return null;
      // A table is several meshes (top, legs); keep the biggest of each cluster.
      const spots = [];
      for (const cand of candidates.sort((a, b) => b.area - a.area)) {
        if (spots.some((s) => Math.hypot(s.c.x - cand.c.x, s.c.z - cand.c.z) < 0.9)) continue;
        spots.push(cand);
      }
      if (spots.length !== want) return null;
      // Reading order, the way the floor plan lists them.
      const alongX = box.max.x - box.min.x >= box.max.z - box.min.z;
      const rows = Math.max(1, Number(this.getAttribute('rows')) || 2);
      const across = spots.map((s) => (alongX ? s.c.z : s.c.x));
      const lo = Math.min(...across), hi = Math.max(...across);
      const band = (v) => Math.min(rows - 1, Math.floor(((v - lo) / ((hi - lo) || 1)) * rows));
      return spots
        .map((s) => ({ s, row: band(alongX ? s.c.z : s.c.x), col: alongX ? s.c.x : s.c.z }))
        .sort((a, b) => a.row - b.row || a.col - b.col)
        .map(({ s }) => ({ x: s.c.x, z: s.c.z, top: s.top, w: s.w, d: s.d }));
    }

    /**
     * Where each table's marking goes. When the model has real furniture the
     * marking lies on the table top, the size of the table: a dot on the floor
     * disappears under the desk it is meant to point at, which is why the pin
     * used to look as though it were floating between chairs.
     */
    positions() {
      const { THREE } = this._L;
      const { box, size, centre, spots } = this._room;
      const cols = Math.max(1, Number(this.getAttribute('columns')) || 5);
      const rows = Math.max(1, Number(this.getAttribute('rows')) || 2);
      if (spots) {
        return {
          points: spots.map((s) => ({ p: new THREE.Vector3(s.x, s.top + 0.012, s.z), w: s.w, d: s.d })),
          onFloor: false,
        };
      }
      const y = box.min.y + Math.max(size.y * 0.004, 0.01);
      const alongX = size.x >= size.z;
      const spanA = (alongX ? size.x : size.z) * 0.78;
      const spanB = (alongX ? size.z : size.x) * 0.5;
      const cell = Math.min(spanA / cols, spanB / rows) * 0.8;
      const points = [];
      for (let i = 0; i < cols * rows; i++) {
        const c = i % cols, r = Math.floor(i / cols);
        const a = (c - (cols - 1) / 2) * (spanA / cols);
        const b = (r - (rows - 1) / 2) * (spanB / rows);
        points.push({
          p: new THREE.Vector3(centre.x + (alongX ? a : b), y, centre.z + (alongX ? b : a)),
          w: cell, d: cell,
        });
      }
      return { points, onFloor: true };
    }

    /** A table's name, drawn on a canvas and laid flat on its top. */
    label(text, size, colour = '#201e1d') {
      const { THREE } = this._L;
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 128;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = colour;
      let px = 76;
      ctx.font = `800 ${px}px Archivo, system-ui, sans-serif`;
      // Long words (the entrance marker) must shrink rather than run off the
      // edge of their canvas.
      const wide = ctx.measureText(text).width;
      if (wide > canvas.width * 0.88) {
        px = Math.max(18, Math.floor((px * canvas.width * 0.88) / wide));
        ctx.font = `800 ${px}px Archivo, system-ui, sans-serif`;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 128, 66);
      const tex = new THREE.CanvasTexture(canvas);
      tex.anisotropy = 4;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size * 0.5),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
      );
      mesh.rotation.x = -Math.PI / 2;
      return mesh;
    }

    layoutMarkers() {
      const { THREE } = this._L;
      const { scene } = this._three;
      const authoredLayout = this.readLocationLayout();
      if (authoredLayout) { this.layoutAuthoredMarkers(authoredLayout); return; }

      this.clearFurnitureAssets();
      if (this._marks) { scene.remove(this._marks); disposeObject(this._marks); this._marks = null; }
      this._authoredTableRecords = null;
      this.clearPath();
      this._focus = null;
      this._pickables = [];

      const free = nums(this.getAttribute('free'));
      const occupied = nums(this.getAttribute('occupied'));
      const dark = nums(this.getAttribute('dark'));
      const selected = Number(this.getAttribute('selected')) || 0;
      const labels = (this.getAttribute('labels') || '').split('|');
      const { points } = this.positions();
      const marks = new THREE.Group();

      points.forEach(({ p, w, d }, i) => {
        const n = i + 1;
        const isPicked = selected === n;
        const isFree = free.includes(n);
        const isFull = occupied.includes(n);
        const isDark = dark.includes(n);
        const colour = isPicked ? PICKED : isFree ? FREE : isFull ? FULL : INK;
        const opacity = isPicked ? 0.92 : isFree ? 0.68 : isFull ? 0.62 : isDark ? 0.12 : 0.2;
        const r = Math.max(0.18, Math.min(w, d) * 0.5);

        // The whole table top is the marking, so "that one is free" is read at
        // a glance and from any angle, and the student picks their own seat.
        const plate = new THREE.Mesh(
          new THREE.PlaneGeometry(w * 0.96, d * 0.96),
          new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false }),
        );
        plate.rotation.x = -Math.PI / 2;
        plate.position.copy(p);
        plate.renderOrder = 2;
        plate.userData.table = n;
        marks.add(plate);
        this._pickables.push(plate);

        const half = [w * 0.48, d * 0.48];
        const edge = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-half[0], 0, -half[1]), new THREE.Vector3(half[0], 0, -half[1]),
            new THREE.Vector3(half[0], 0, half[1]), new THREE.Vector3(-half[0], 0, half[1]),
          ]),
          new THREE.LineBasicMaterial({
            color: isPicked ? 0x00332c : isFree ? 0x00463d : INK,
            transparent: true, opacity: isPicked ? 1 : isFree ? 0.85 : 0.3,
          }),
        );
        edge.position.set(p.x, p.y + 0.004, p.z);
        edge.renderOrder = 3;
        marks.add(edge);

        // The name, laid on the table top: M1 and M5 look alike otherwise.
        if (labels[i]) {
          const text = this.label(labels[i], Math.min(w, d) * 0.9, isPicked || isFree ? '#ffffff' : '#201e1d');
          text.position.set(p.x, p.y + 0.008, p.z);
          text.renderOrder = 4;
          marks.add(text);
        }

        if (isPicked) {
          const pinH = Math.max(0.9, r * 2.6);
          const pin = new THREE.Mesh(
            new THREE.ConeGeometry(r * 0.3, pinH * 0.45, 18),
            new THREE.MeshStandardMaterial({ color: PICKED, roughness: 0.4 }),
          );
          pin.rotation.x = Math.PI;
          pin.position.set(p.x, p.y + pinH * 0.75, p.z);
          marks.add(pin);
          const ball = new THREE.Mesh(
            new THREE.SphereGeometry(r * 0.3, 20, 16),
            new THREE.MeshStandardMaterial({ color: PICKED, roughness: 0.4 }),
          );
          ball.position.set(p.x, p.y + pinH * 1.02, p.z);
          marks.add(ball);
          this._focus = new THREE.Vector3(p.x, p.y, p.z);
        }
      });

      scene.add(marks);
      this._marks = marks;
      this._seat = (this._focus || this._room.centre).clone();
      if (this.getAttribute('directions') === '1' && this._focus) this.drawRoute(this._focus);
    }

    /**
     * The walk from the way in to the table you picked, dotted on the floor:
     * the same idea as the "you are here" maps in a mall. The way in is the
     * middle of the room's near edge, which is the end the plan is drawn from.
     */
    drawRoute(target) {
      const { THREE } = this._L;
      const { scene } = this._three;
      const { box, size } = this._room;
      const y = box.min.y + 0.03;
      const alongX = size.x >= size.z;
      const door = alongX
        ? new THREE.Vector3((box.min.x + box.max.x) / 2, y, box.min.z)
        : new THREE.Vector3(box.min.x, y, (box.min.z + box.max.z) / 2);
      // An L-shaped walk rather than a diagonal through the furniture.
      const corner = alongX ? new THREE.Vector3(door.x, y, target.z) : new THREE.Vector3(target.x, y, door.z);
      const end = new THREE.Vector3(target.x, y, target.z);
      const group = new THREE.Group();

      // Painted footprints rather than a hairline: WebGL will not draw a line
      // thicker than one pixel, and one pixel is invisible on a floor plan.
      const step = 0.55;
      const dot = new THREE.CircleGeometry(0.1, 16);
      const paint = new THREE.MeshBasicMaterial({ color: PICKED, transparent: true, opacity: 0.9 });
      for (const [a, b] of [[door, corner], [corner, end]]) {
        const span = a.distanceTo(b);
        for (let t = step; t < span; t += step) {
          const m = new THREE.Mesh(dot, paint);
          m.rotation.x = -Math.PI / 2;
          m.position.lerpVectors(a, b, t / span);
          m.renderOrder = 5;
          group.add(m);
        }
      }
      const start = new THREE.Mesh(
        new THREE.CircleGeometry(Math.min(0.35, Math.max(0.22, size.x * 0.02)), 24),
        new THREE.MeshBasicMaterial({ color: PICKED, transparent: true, opacity: 0.9 }),
      );
      start.rotation.x = -Math.PI / 2;
      start.position.copy(door);
      start.renderOrder = 5;
      group.add(start);
      const here = this.label('YOU ARE HERE', 1.6, '#006f62');
      here.position.set(door.x, y + 0.01, door.z + (alongX ? -0.9 : 0));
      here.renderOrder = 5;
      group.add(here);
      scene.add(group);
      this._path = group;
    }

    /** Click a table to pick it. A drag is not a click. */
    pick(e) {
      if (!this._pickables || !this._downAt) return;
      if (Math.hypot(e.clientX - this._downAt.x, e.clientY - this._downAt.y) > 6) return;
      const { THREE } = this._L;
      const { camera, renderer } = this._three;
      const rect = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ), camera);
      const hit = ray.intersectObjects(this._pickables, false)[0];
      if (hit && hit.object && typeof hit.object.userData.tableId === 'string') {
        this.dispatchEvent(new CustomEvent('table-picked', { detail: { tableId: hit.object.userData.tableId } }));
      } else if (hit && hit.object && hit.object.userData.table) {
        this.dispatchEvent(new CustomEvent('table-picked', { detail: { index: hit.object.userData.table } }));
      }
    }

    resetView() {
      if (!this._home) return;
      this._three.camera.position.copy(this._home.pos);
      this._three.controls.target.copy(this._home.tgt);
      this._three.controls.update();
    }

    zoomToSeat() {
      if (!this._seat) return;
      const { camera, controls } = this._three;
      const d = Math.max(controls.minDistance * 1.2, controls.maxDistance * 0.12) / Math.sqrt(3);
      controls.target.copy(this._seat);
      camera.position.set(this._seat.x + d, this._seat.y + d * 0.9, this._seat.z + d);
      controls.update();
    }

    /** 0 = as far out as the room allows, 1 = right above the table. */
    setZoom(t) {
      if (!this._three) return;
      const { camera, controls } = this._three;
      const want = controls.maxDistance - (controls.maxDistance - controls.minDistance) * Math.min(1, Math.max(0, t));
      const dir = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target.clone().add(dir.multiplyScalar(want)));
      controls.update();
    }

    getZoom() {
      if (!this._three) return 0;
      const { camera, controls } = this._three;
      const d = camera.position.distanceTo(controls.target);
      return 1 - (d - controls.minDistance) / ((controls.maxDistance - controls.minDistance) || 1);
    }

    retryLoad() {
      if (!this._three || !this._L) return;
      if (this._furnitureHadFailure) {
        for (const assetId of this._furnitureAssetIds || []) {
          if (this._furnitureLoads.get(assetId)?.status === 'error') this.startFurnitureLoad(assetId);
        }
        this.reportFurnitureRecoveryIfResolved();
        return;
      }
      this._token = Symbol();
      void this.refresh();
    }
  }
  customElements.define('floor-viewer', FloorViewer);
})();
