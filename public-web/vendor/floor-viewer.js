/* <floor-viewer> — interactive 3D floor map for HKUMySeat.
   Attributes: src, room, highlight ("2,3"), occupied ("1,6"), dark ("7"),
               columns, rows, accent, ground.

   From the HKUMySeat design handoff, with two changes for production:
   three.js is loaded from /vendor/three (the page's CSP allows no CDN, and a
   campus network may not reach one), and the marker grid is sized by the
   `columns`/`rows` attributes instead of a fixed 5x2, so a space with another
   table layout works. Markers are floor decals, not furniture: the model
   already carries the real fit-out. */
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

  class FloorViewer extends HTMLElement {
    static get observedAttributes() { return ['src', 'room', 'highlight', 'occupied', 'dark', 'columns', 'rows']; }
    connectedCallback() {
      // The app re-renders the live screen whenever the sensors report, which
      // moves this element: a disconnect immediately followed by a connect.
      clearTimeout(this._teardown);
      this._teardown = null;
      if (this._init) {
        if (this._stopped) {   // a real teardown had already run: start over
          this._stopped = false;
          this._init = false;
          this.replaceChildren();
          this.connectedCallback();
        }
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
      // Occupancy changes every time the sensors report. Re-laying the floor
      // markers is cheap; reloading the model and re-framing the camera is
      // not, and it would yank the view back while someone is looking around.
      if (n === 'src' || n === 'room') this.refresh();
      else if (this._room) this.layoutMarkers();
    }
    disconnectedCallback() {
      // Only tear down if we are still detached on the next turn of the event
      // loop -- otherwise a move would dispose a live WebGL context.
      this._teardown = setTimeout(() => {
        this._teardown = null;
        this._stopped = true;
        if (this._ro) this._ro.disconnect();
        if (this._renderer) this._renderer.dispose();
      }, 0);
    }

    async boot() {
      let L;
      try { L = await lib(); } catch (e) { this._msg.textContent = '3D map unavailable'; return; }
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
      const camera = new THREE.PerspectiveCamera(45, w / h, 0.05, 2000);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.maxPolarAngle = Math.PI * 0.49;
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
      });
      this._ro.observe(this);
      const tick = () => { if (this._stopped) return; controls.update(); renderer.render(scene, camera); requestAnimationFrame(tick); };
      tick();
      this.refresh();
    }

    async refresh() {
      const { THREE } = this._L;
      const { scene, camera, controls } = this._three;
      const src = this.getAttribute('src');
      if (!src) return;
      const token = (this._token = Symbol());
      if (this._model) { scene.remove(this._model); this._model = null; }
      if (this._marks) { scene.remove(this._marks); this._marks = null; }
      this._focus = null;
      this._room = null;
      let model;
      try { model = await loadGLB(this._L.GLTFLoader, src); }
      catch (e) { this._msg.textContent = 'Could not load floor model'; return; }
      if (token !== this._token || this._stopped) return;
      this._msg.remove();

      model.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { if (m && m.color) { m.transparent = true; m.opacity = 0.92; } });
      });
      scene.add(model);
      this._model = model;

      // locate the room the search is about. glTF sanitises node names, so
      // "Makerspace A floor" arrives as "Makerspace_A_floor": compare loosely.
      const norm = (s) => (s || '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
      const roomName = norm(this.getAttribute('room'));
      let roomNode = null;
      model.traverse((o) => { if (!roomNode && roomName && norm(o.name) === roomName) roomNode = o; });
      const box = new THREE.Box3().setFromObject(roomNode || model);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());

      this._room = { box, size, centre };
      this.layoutMarkers();

      const radius = Math.max(size.x, size.z) * 1.15 + 0.001;
      controls.target.copy(new THREE.Vector3(centre.x, box.min.y + size.y * 0.3, centre.z));
      camera.position.set(centre.x + radius * 0.8, box.min.y + radius * 0.85, centre.z + radius * 0.9);
      camera.near = radius / 200; camera.far = radius * 40; camera.updateProjectionMatrix();
      controls.minDistance = radius * 0.2;
      controls.maxDistance = radius * 6;
      controls.update();
      this._home = { pos: camera.position.clone(), tgt: controls.target.clone() };
    }

    /** Floor discs and the pin, from the current attributes. */
    layoutMarkers() {
      const { THREE } = this._L;
      const { scene } = this._three;
      const { box, size, centre } = this._room;
      if (this._marks) { scene.remove(this._marks); this._marks = null; }
      this._focus = null;
      const accent = new THREE.Color(this.getAttribute('accent') || '#006F62');
      const marks = new THREE.Group();
      const highlight = nums(this.getAttribute('highlight'));
      const occupied = nums(this.getAttribute('occupied'));
      const dark = nums(this.getAttribute('dark'));
      const cols = Math.max(1, Number(this.getAttribute('columns')) || 5);
      const rows = Math.max(1, Number(this.getAttribute('rows')) || 2);
      const alongX = size.x >= size.z;
      const spanA = (alongX ? size.x : size.z) * 0.78;
      const spanB = (alongX ? size.z : size.x) * 0.5;
      const tw = Math.min(spanA / cols * 0.62, spanB / rows * 0.72);
      const th = tw * 0.55;
      const y = box.min.y + Math.max(size.y * 0.004, 0.01);
      for (let i = 0; i < cols * rows; i++) {
        const c = i % cols, r = Math.floor(i / cols);
        const a = (c - (cols - 1) / 2) * (spanA / cols);
        const b = (r - (rows - 1) / 2) * (spanB / rows);
        const x = centre.x + (alongX ? a : b);
        const z = centre.z + (alongX ? b : a);
        const n = i + 1;
        const isMine = highlight.indexOf(n) >= 0;
        const isFull = occupied.indexOf(n) >= 0;
        const isDark = dark.indexOf(n) >= 0;
        const pad = new THREE.Mesh(
          new THREE.CircleGeometry(Math.min(tw, th) * 0.42, 28),
          new THREE.MeshBasicMaterial({
            color: isMine ? accent : (isFull ? 0x9b9797 : 0x201e1d),
            transparent: true, opacity: isMine ? 0.9 : (isFull ? 0.45 : (isDark ? 0.06 : 0.18))
          })
        );
        pad.rotation.x = -Math.PI / 2;
        pad.position.set(x, y, z);
        marks.add(pad);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(Math.min(tw, th) * 0.42, Math.min(tw, th) * 0.5, 32),
          new THREE.MeshBasicMaterial({ color: isMine ? 0x00332c : 0x201e1d, transparent: true, opacity: isMine ? 1 : (isDark ? 0.18 : 0.5) })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(x, y + 0.001, z);
        marks.add(ring);
        if (isMine) {
          const pinH = th * 2.4;
          const pin = new THREE.Mesh(
            new THREE.ConeGeometry(tw * 0.18, pinH * 0.45, 16),
            new THREE.MeshStandardMaterial({ color: accent, roughness: 0.4 })
          );
          pin.rotation.x = Math.PI;
          pin.position.set(x, y + th * 0.9 + pinH * 0.45, z);
          marks.add(pin);
          const ball = new THREE.Mesh(
            new THREE.SphereGeometry(tw * 0.18, 20, 16),
            new THREE.MeshStandardMaterial({ color: accent, roughness: 0.4 })
          );
          ball.position.set(x, y + th * 0.9 + pinH * 0.72, z);
          marks.add(ball);
          if (!this._focus) this._focus = new THREE.Vector3(x, y + th, z);
        }
      }
      scene.add(marks);
      this._marks = marks;
      this._seat = (this._focus || centre).clone();
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
      const d = Math.max(controls.minDistance * 1.1, controls.maxDistance * 0.055) / Math.sqrt(3);
      controls.target.copy(this._seat);
      camera.position.set(this._seat.x + d, this._seat.y + d * 0.9, this._seat.z + d);
      controls.update();
    }
  }
  customElements.define('floor-viewer', FloorViewer);
})();
