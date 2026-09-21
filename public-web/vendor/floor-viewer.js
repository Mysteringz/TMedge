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
  function lib() {
    if (!libP) libP = Promise.all([
      import('/vendor/three/three.module.js'),
      import('/vendor/three/OrbitControls.js'),
      import('/vendor/three/GLTFLoader.js')
    ]).then(([T, oc, gl]) => ({ THREE: T, OrbitControls: oc.OrbitControls, GLTFLoader: gl.GLTFLoader }));
    return libP;
  }
  const cache = new Map();
  function loadGLB(GLTFLoader, src) {
    if (!cache.has(src)) {
      cache.set(src, new Promise((res, rej) => new GLTFLoader().load(src, (g) => res(g.scene), undefined, rej)));
    }
    return cache.get(src).then((s) => s.clone(true));
  }
  const nums = (s) => (s || '').split(',').filter(Boolean).map(Number);
  const norm = (s) => (s || '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();

  const FREE = 0x0b8b7a;     // room for your group
  const PICKED = 0x006f62;   // the table you chose
  const FULL = 0x9b9797;
  const INK = 0x201e1d;

  class FloorViewer extends HTMLElement {
    static get observedAttributes() {
      return ['src', 'room', 'labels', 'free', 'occupied', 'dark', 'selected', 'directions', 'columns', 'rows'];
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
      if (n === 'src' || n === 'room') this.refresh();
      else if (this._room) this.layoutMarkers();
    }

    disconnectedCallback() {
      // Only tear down if we are still detached on the next turn of the loop.
      this._teardown = setTimeout(() => {
        this._teardown = null;
        this._stopped = true;
        if (this._ro) this._ro.disconnect();
        if (this._renderer) this._renderer.dispose();
      }, 0);
    }

    async boot() {
      let L;
      try { L = await lib(); } catch { this._msg.textContent = '3D map unavailable'; return; }
      if (this._stopped) return;
      const { THREE, OrbitControls } = L;
      this._L = L;
      const w = this.clientWidth || 800, h = this.clientHeight || 420;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
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
        requestAnimationFrame(tick);
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
      const src = this.getAttribute('src');
      if (!src) return;
      const token = (this._token = Symbol());
      for (const k of ['_model', '_marks', '_path']) {
        if (this[k]) { scene.remove(this[k]); this[k] = null; }
      }
      this._room = null;
      let model;
      try { model = await loadGLB(this._L.GLTFLoader, src); }
      catch { this._msg.textContent = 'Could not load floor model'; return; }
      if (token !== this._token || this._stopped) return;
      this._msg.remove();

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
            const c = m.clone();
            if (c.color) c.color.setHex(0xe8ece9);
            if (c.emissive) c.emissive.setHex(0x000000);
            c.transparent = true; c.opacity = 0.95;
            return c;
          });
          o.material = Array.isArray(o.material) ? mats : mats[0];
        });
      }
      const box = new THREE.Box3().setFromObject(roomNode || model);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      this._room = { box, size, centre, spots: this.findTables(model, box) };

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
      if (this._marks) { scene.remove(this._marks); this._marks = null; }
      if (this._path) { scene.remove(this._path); this._path = null; }
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
      if (hit && hit.object && hit.object.userData.table) {
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
  }
  customElements.define('floor-viewer', FloorViewer);
})();
