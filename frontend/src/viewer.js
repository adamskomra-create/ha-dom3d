import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import {
  FURN, LIGHT_KINDS, SENSOR_KINDS, FLOOR_FINISH, normalize, floorById, wallLen, wallAngle,
  polyCentroid, kelvinToHex, sunPosition, lightState, sensorActive,
} from "./model.js";

const D2R = Math.PI / 180;
const LAMP_SCALE = 0.05; // lm -> cd (artystycznie dobrane do słońca)

const STYLE = `
.d3-wrap{position:relative;width:100%;height:100%;overflow:hidden;background:#11151c;touch-action:none}
.d3-wrap canvas{display:block}
.d3-labels{position:absolute;inset:0;pointer-events:none}
.d3-room{font:600 12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2329;text-align:center;
  background:rgba(255,255,255,.72);padding:3px 7px;border-radius:8px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.d3-room small{display:block;font-weight:500;color:#4b5563}
.d3-night .d3-room{background:rgba(20,24,32,.72);color:#f3f4f6}
.d3-night .d3-room small{color:#cbd5e1}
.d3-tag{font:600 11px system-ui,sans-serif;color:#fff;background:rgba(17,24,39,.8);padding:2px 6px;border-radius:6px;white-space:nowrap}
`;

let _woodTex = null;
function woodTexture() {
  if (_woodTex) return _woodTex;
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    const y = rnd() * c.height, amp = 2 + rnd() * 6, f = 0.002 + rnd() * 0.006, ph = rnd() * 6.28;
    g.strokeStyle = `rgba(150,100,50,${0.03 + rnd() * 0.07})`;
    g.lineWidth = 0.5 + rnd() * 1.6;
    g.beginPath();
    for (let x = 0; x <= c.width; x += 8) g.lineTo(x, y + Math.sin(x * f + ph) * amp);
    g.stroke();
  }
  for (let i = 0; i < 18; i++) { // promienie rdzeniowe dębu
    g.fillStyle = `rgba(255,240,210,${0.05 + rnd() * 0.08})`;
    g.fillRect(rnd() * c.width, rnd() * c.height, 20 + rnd() * 60, 1.5);
  }
  _woodTex = new THREE.CanvasTexture(c);
  _woodTex.colorSpace = THREE.SRGBColorSpace;
  _woodTex.wrapS = _woodTex.wrapT = THREE.RepeatWrapping;
  _woodTex.repeat.set(0.45, 0.9); // ~2.2 m słojów na teksturę
  _woodTex.anisotropy = 8;
  return _woodTex;
}

function mat(color, rough = 0.8, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, ...extra });
}

export class Dom3DViewer {
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = { quality: "high", labels: true, fileUrl: (n) => "files/" + n, rotate: 0, ...opts };
    this.dom = normalize(opts.dom);
    this.states = {};
    this.floorId = this.dom.floors[this.dom.floors.length - 1].id;
    this.mode = opts.mode || "top";
    this.timeOverride = null;
    this.showBackgrounds = false;
    this.selectedId = null;
    this.objects = new Map(); // id -> Object3D
    this.lights = []; // {def, light, fixture}
    this.sensors = []; // {def, mesh}
    this.openingsBound = []; // {def, wallDef, frame, leaf}
    this.roomLabels = []; // {def, el}
    this.gltfCache = new Map();
    this.needsRender = true;
    this.onClick = opts.onClick || null;

    if (!document.getElementById("d3-style") && !opts.shadowRoot) {
      const s = document.createElement("style");
      s.id = "d3-style";
      s.textContent = STYLE;
      document.head.appendChild(s);
    } else if (opts.shadowRoot) {
      const s = document.createElement("style");
      s.textContent = STYLE;
      opts.shadowRoot.appendChild(s);
    }

    this.wrap = document.createElement("div");
    this.wrap.className = "d3-wrap";
    container.appendChild(this.wrap);

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.opts.quality === "low" ? 1 : 2));
    r.shadowMap.enabled = this.opts.quality !== "low";
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    this.wrap.appendChild(r.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = "d3-labels";
    this.wrap.appendChild(this.labelRenderer.domElement);

    this.scene = new THREE.Scene();
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.hemi = new THREE.HemisphereLight(0xdbe8ff, 0x8a7a66, 0.8);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff3e0, 3);
    this.sun.castShadow = this.opts.quality !== "low";
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);

    this.orthoCam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 200);
    this.perspCam = new THREE.PerspectiveCamera(38, 1, 0.05, 300);
    this.camera = this.orthoCam;
    this._makeControls();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._bindPointer();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.build();
    this.fit();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  // ------------------------------------------------------------ public API
  setDom(dom, keepCamera = true) {
    this.dom = normalize(dom);
    if (!this.dom.floors.find((f) => f.id === this.floorId)) this.floorId = this.dom.floors[0].id;
    this.build();
    if (!keepCamera) this.fit();
  }

  setStates(states) {
    this.states = states || {};
    this.applyStates();
  }

  updateState(eid, st) {
    if (st) this.states[eid] = st;
    else delete this.states[eid];
    this.applyStates(eid);
  }

  setFloor(id) {
    this.floorId = id;
    this._applyVisibility();
    this.fit();
  }

  setMode(mode) {
    this.mode = mode;
    this._makeControls();
    this._applyVisibility();
    this.fit();
  }

  setTime(date) {
    this.timeOverride = date;
    this._applySun();
  }

  setSelected(id) {
    this.selectedId = id;
    this.root.traverse((o) => {
      if (o.userData.selHelper) o.visible = o.userData.selHelper === id;
    });
    this.needsRender = true;
  }

  render() {
    this.needsRender = true;
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.wrap.remove();
  }

  floor() {
    return floorById(this.dom, this.floorId);
  }

  // punkt na płaszczyźnie aktywnego piętra (współrzędne planu)
  planPoint(ev) {
    this._setPointer(ev);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.floor().elev);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, p)) return null;
    return { x: p.x, y: -p.z };
  }

  pick(ev, filter) {
    this._setPointer(ev);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.root.children, true);
    for (const h of hits) {
      let o = h.object;
      if (!o.visible) continue;
      while (o && !o.userData.pick) o = o.parent;
      if (o && o.userData.pick && this._visibleChain(o) && (!filter || filter(o.userData.pick))) {
        return { ...o.userData.pick, point: { x: h.point.x, y: -h.point.z } };
      }
    }
    return null;
  }

  // ------------------------------------------------------------ build
  build() {
    for (const c of [...this.root.children]) {
      this.root.remove(c);
      c.traverse((o) => {
        if (o.isCSS2DObject) o.element.remove();
        if (o.geometry && !o.userData.sharedGeo) o.geometry.dispose();
      });
    }
    this.objects.clear();
    this.lights = [];
    this.sensors = [];
    this.openingsBound = [];
    this.roomLabels = [];
    this.floorGroups = {};
    const d = this.dom;
    for (const f of d.floors) {
      const g = new THREE.Group();
      g.name = "floor:" + f.id;
      g.userData.floor = f;
      this.floorGroups[f.id] = g;
      this.root.add(g);
    }
    const fg = (o) => this.floorGroups[o.floor] || this.floorGroups[d.floors[0].id];
    for (const f of d.floors) this._buildSlab(f);
    for (const w of d.walls) fg(w).add(this._reg(w.id, this._buildWall(w, floorById(d, w.floor))));
    for (const r of d.rooms) fg(r).add(this._reg(r.id, this._buildRoom(r, floorById(d, r.floor))));
    for (const s of d.stairs) fg(s).add(this._reg(s.id, this._buildStairs(s, floorById(d, s.floor))));
    for (const it of d.items) fg(it).add(this._reg(it.id, this._buildItem(it, floorById(d, it.floor))));
    for (const l of d.lights) fg(l).add(this._reg(l.id, this._buildLight(l, floorById(d, l.floor))));
    for (const s of d.sensors) fg(s).add(this._reg(s.id, this._buildSensor(s, floorById(d, s.floor))));
    for (const m of d.models) fg(m).add(this._reg(m.id, this._buildModel(m, floorById(d, m.floor))));
    for (const b of d.backgrounds) fg(b).add(this._reg(b.id, this._buildBackground(b, floorById(d, b.floor))));
    this._applyVisibility();
    this.applyStates();
    this.setSelected(this.selectedId);
  }

  _reg(id, obj) {
    this.objects.set(id, obj);
    return obj;
  }

  _footprint(f) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const w of this.dom.walls) {
      if (w.floor !== f.id) continue;
      const L = wallLen(w) || 1e-6, h = w.t / 2;
      const nx = (-(w.y2 - w.y1) / L) * h, ny = ((w.x2 - w.x1) / L) * h;
      for (const [x, y] of [[w.x1 + nx, w.y1 + ny], [w.x1 - nx, w.y1 - ny], [w.x2 + nx, w.y2 + ny], [w.x2 - nx, w.y2 - ny]]) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    return x0 === Infinity ? null : { x0, x1, y0, y1 };
  }

  _buildSlab(f) {
    const fp = this._footprint(f);
    if (!fp) return;
    const shape = new THREE.Shape();
    shape.moveTo(fp.x0, fp.y0); shape.lineTo(fp.x1, fp.y0); shape.lineTo(fp.x1, fp.y1); shape.lineTo(fp.x0, fp.y1); shape.closePath();
    const below = this.dom.floors.filter((g) => g.level === f.level - 1).map((g) => g.id);
    const rects = Array.isArray(f.holes) && f.holes.length ? f.holes.map((h) => ({ x0: h[0], y0: h[1], x1: h[2], y1: h[3] }))
      : this.dom.stairs.filter((s) => below.includes(s.floor));
    for (const s of rects) {
      const a = Math.min(s.x0, s.x1), b = Math.max(s.x0, s.x1), c = Math.min(s.y0, s.y1), e = Math.max(s.y0, s.y1);
      const hole = new THREE.Path();
      hole.moveTo(a, c); hole.lineTo(a, e); hole.lineTo(b, e); hole.lineTo(b, c); hole.closePath();
      shape.holes.push(hole);
    }
    const t = f.slab ?? 0.22;
    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat(0x8b8d91, 0.95));
    m.position.y = f.elev - 0.021 - t;
    m.receiveShadow = true;
    m.castShadow = true;
    m.userData.slab = true;
    this.floorGroups[f.id].add(m);
  }

  _buildWall(w, f) {
    const g = new THREE.Group();
    const L = wallLen(w), t = w.t, H = w.h || f.height;
    g.position.set(w.x1, f.elev, -w.y1);
    g.rotation.y = wallAngle(w);
    const side = mat(w.color || 0xf1efea, 0.92);
    const cap = mat(0x30343b, 0.9);
    const mats = [side, side, cap, side, side, side];
    const piece = (x0, x1, z0, z1) => {
      if (x1 - x0 < 0.005 || z1 - z0 < 0.005) return;
      const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, z1 - z0, t), mats);
      m.position.set((x0 + x1) / 2, (z0 + z1) / 2, 0);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    };
    const ops = [...(w.openings || [])].sort((a, b) => a.offset - b.offset);
    let cur = 0;
    for (const op of ops) {
      const a = Math.max(cur, op.offset), b = Math.min(L, op.offset + op.width);
      piece(cur, a, 0, H);
      const sill = op.sill || 0, top = Math.min(H, sill + op.height);
      piece(a, b, 0, sill);
      piece(a, b, top, H);
      g.add(this._buildOpening(op, w, t, H));
      cur = Math.max(cur, b);
    }
    piece(cur, L, 0, H);
    g.userData.pick = { kind: "wall", id: w.id };
    // obrys zaznaczenia
    const sel = new THREE.Mesh(new THREE.BoxGeometry(L + 0.04, H + 0.04, t + 0.04),
      new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.25, depthWrite: false }));
    sel.position.set(L / 2, H / 2, 0);
    sel.userData.selHelper = w.id;
    sel.visible = false;
    sel.raycast = () => {};
    g.add(sel);
    return g;
  }

  _buildOpening(op, w, t, H) {
    const g = new THREE.Group();
    const sill = op.sill || 0, h = Math.min(op.height, H - sill), W = op.width;
    g.position.set(op.offset, sill, 0);
    g.userData.pick = { kind: "opening", id: op.id, wall: w.id, entity: op.entity };
    const frameMat = mat(op.frameColor || 0x2b2d31, 0.45); // osobny materiał na otwór (kolor stanu kontaktronu)
    const f = 0.06;
    const box = (sx, sy, sz, x, y, z, m) => {
      const me = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
      me.position.set(x, y, z);
      me.castShadow = true;
      g.add(me);
      return me;
    };
    const frames = [];
    if (op.type === "window" || op.type === "door") {
      const fd = op.type === "window" ? Math.min(0.09, t) : t;
      frames.push(box(W, f, fd, W / 2, f / 2, 0, frameMat));
      frames.push(box(W, f, fd, W / 2, h - f / 2, 0, frameMat));
      frames.push(box(f, h, fd, f / 2, h / 2, 0, frameMat));
      frames.push(box(f, h, fd, W - f / 2, h / 2, 0, frameMat));
    }
    let leaf = null;
    if (op.type === "window") {
      const glass = new THREE.Mesh(new THREE.BoxGeometry(W - 2 * f, h - 2 * f, 0.012),
        new THREE.MeshStandardMaterial({ color: 0xbfdbfe, roughness: 0.05, transparent: true, opacity: 0.16, depthWrite: false }));
      glass.position.set(W / 2, h / 2, 0);
      glass.castShadow = false;
      g.add(glass);
      if (sill > 0.05) box(W + 0.04, 0.03, t / 2 + 0.03, W / 2, -0.015, -(t / 4 + 0.015) * (op.side || 1), mat(0xf5f5f4, 0.4));
    } else if (op.type === "door") {
      const lw = W - 2 * f, lh = h - f;
      const piv = new THREE.Group();
      const hingeR = op.hinge === "R";
      piv.position.set(hingeR ? W - f : f, 0, 0);
      const lm = new THREE.Mesh(new THREE.BoxGeometry(lw, lh, 0.04), mat(op.color || 0xeeeeec, 0.5));
      lm.position.set(hingeR ? -lw / 2 : lw / 2, lh / 2, 0);
      lm.castShadow = lm.receiveShadow = true;
      piv.add(lm);
      g.add(piv);
      leaf = piv;
      leaf.userData.openAngle = (op.side || 1) * (hingeR ? -1 : 1) * 88 * D2R;
      leaf.rotation.y = op.entity ? 0 : leaf.userData.openAngle * (op.open ?? 1);
    }
    if (op.entity) this.openingsBound.push({ def: op, frames, leaf });
    return g;
  }

  _buildRoom(r, f) {
    const g = new THREE.Group();
    const poly = r.poly || [];
    if (poly.length < 3) return g;
    const shape = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const color = r.color || (FLOOR_FINISH[r.finish] || FLOOR_FINISH.DREWNO).color;
    const m = new THREE.Mesh(geo, mat(color, r.finish && r.finish.startsWith("PLYTKI") ? 0.35 : 0.6));
    m.position.y = f.elev - 0.02;
    m.receiveShadow = true;
    m.userData.pick = { kind: "room", id: r.id };
    g.add(m);
    const sel = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.25, depthWrite: false }));
    sel.position.y = f.elev + 0.002;
    sel.userData.selHelper = r.id;
    sel.userData.sharedGeo = true;
    sel.visible = false;
    sel.raycast = () => {};
    g.add(sel);
    if (this.opts.labels && r.label !== false) {
      const el = document.createElement("div");
      el.className = "d3-room";
      const lab = new CSS2DObject(el);
      const [cx, cy] = r.labelPos || polyCentroid(poly);
      lab.position.set(cx, f.elev + 0.05, -cy);
      g.add(lab);
      this.roomLabels.push({ def: r, el });
    }
    return g;
  }

  _buildStairs(s, f) {
    const g = new THREE.Group();
    const n = Math.max(1, s.steps || 7);
    const x0 = Math.min(s.x0, s.x1), x1 = Math.max(s.x0, s.x1), y0 = Math.min(s.y0, s.y1), y1 = Math.max(s.y0, s.y1);
    const dir = s.dir || "x+";
    const along = dir[0] === "x" ? x1 - x0 : y1 - y0;
    const run = along / n;
    const z0 = s.z0 ?? 0, z1 = s.z1 ?? f.height;
    const rise = (z1 - z0) / n;
    const m = mat(s.color || 0xb08d68, 0.55);
    for (let i = 0; i < n; i++) {
      const top = z0 + rise * (i + 1);
      const k = dir[1] === "+" ? i : n - 1 - i;
      let cx, cy, sx, sy;
      if (dir[0] === "x") { cx = x0 + run * (k + 0.5); cy = (y0 + y1) / 2; sx = run; sy = y1 - y0; }
      else { cy = y0 + run * (k + 0.5); cx = (x0 + x1) / 2; sy = run; sx = x1 - x0; }
      const st = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.05, sy), m);
      st.position.set(cx, f.elev + top - 0.025, -cy);
      st.castShadow = st.receiveShadow = true;
      g.add(st);
      const riser = new THREE.Mesh(new THREE.BoxGeometry(dir[0] === "x" ? 0.02 : sx, rise, dir[0] === "x" ? sy : 0.02), mat(0xe7e5e4, 0.8));
      const off = dir[1] === "+" ? -run / 2 : run / 2;
      riser.position.set(dir[0] === "x" ? cx + off : cx, f.elev + top - rise / 2 - 0.05, dir[0] === "x" ? -cy : -(cy + off));
      g.add(riser);
    }
    g.userData.pick = { kind: "stairs", id: s.id };
    return g;
  }

  // ------------------------------------------------------------ meble
  _buildItem(it, f) {
    const g = new THREE.Group();
    g.position.set(it.x, f.elev + (it.z || 0), -it.y);
    g.rotation.y = (it.rot || 0) * D2R;
    g.userData.pick = { kind: "item", id: it.id };
    const pre = FURN[it.type] || FURN.INNY;
    const w = it.w || pre.w, d = it.d || pre.d, h = it.h || pre.h;
    if (it.glb) {
      this._loadGLB(it.glb).then((scene) => {
        const s = scene.clone(true);
        const box = new THREE.Box3().setFromObject(s);
        const size = box.getSize(new THREE.Vector3());
        const k = it.fit === "stretch" ? null : Math.min(w / (size.x || 1), h / (size.y || 1), d / (size.z || 1));
        if (k) s.scale.setScalar(k);
        else s.scale.set(w / (size.x || 1), h / (size.y || 1), d / (size.z || 1));
        const b2 = new THREE.Box3().setFromObject(s);
        const c = b2.getCenter(new THREE.Vector3());
        s.position.set(-c.x, -b2.min.y, -c.z);
        s.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } if (o.isLight) o.visible = false; });
        g.add(s);
        this.needsRender = true;
      }).catch(() => this._furnSketch(g, it.type, w, d, h, it.color || pre.color, it));
    } else {
      this._furnSketch(g, it.type, w, d, h, it.color || pre.color, it);
    }
    const sel = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, h + 0.04, d + 0.04),
      new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.3, depthWrite: false }));
    sel.position.y = h / 2;
    sel.userData.selHelper = it.id;
    sel.visible = false;
    sel.raycast = () => {};
    g.add(sel);
    return g;
  }

  _furnSketch(g, type, w, d, h, color, it = {}) {
    // lokalnie: x = szerokość, z = głębokość (front po stronie +z = plan -y), y = wysokość
    const add = (geo, m, x, y, z) => {
      const me = new THREE.Mesh(geo, m);
      me.position.set(x, y, z);
      me.castShadow = me.receiveShadow = true;
      g.add(me);
      return me;
    };
    const rb = (sx, sy, sz, r = 0.02) => new RoundedBoxGeometry(sx, Math.max(sy, 0.004), sz, 2, Math.min(r, sx / 2, sy / 2, sz / 2));
    const base = mat(color, 0.75);
    const white = mat(0xf8f8f6, 0.6);
    const dark = mat(0x3a3d42, 0.6);
    const back = -d / 2; // tył (strona -z lokalnie = plan +y)
    switch (type) {
      case "LOZKO_1":
      case "LOZKO_2": {
        add(rb(w, h * 0.55, d, 0.03), base, 0, h * 0.275, 0);
        add(rb(w - 0.06, 0.2, d - 0.12, 0.06), white, 0, h * 0.55 + 0.1, 0.03);
        add(rb(w, 0.95, 0.08, 0.03), base, 0, 0.475, back + 0.04);
        const np = type === "LOZKO_2" ? 2 : 1;
        for (let i = 0; i < np; i++) {
          const px = np === 1 ? 0 : (i - 0.5) * (w / 2);
          add(rb(Math.min(0.6, w / np - 0.1), 0.12, 0.38, 0.05), mat(0xffffff, 0.7), px, h * 0.55 + 0.25, back + 0.32);
        }
        add(rb(w - 0.02, 0.06, d * 0.6, 0.03), mat(color === "#d9d2c5" ? "#a9b4bf" : color, 0.85), 0, h * 0.55 + 0.23, d * 0.18);
        break;
      }
      case "SOFA":
      case "FOTEL": {
        add(rb(w, 0.42, d, 0.06), base, 0, 0.21, 0);
        add(rb(w, h - 0.1, 0.22, 0.08), base, 0, (h - 0.1) / 2 + 0.1, back + 0.11);
        add(rb(0.18, 0.62, d, 0.07), base, -w / 2 + 0.09, 0.31, 0);
        add(rb(0.18, 0.62, d, 0.07), base, w / 2 - 0.09, 0.31, 0);
        add(rb(w - 0.4, 0.14, d - 0.3, 0.06), mat(new THREE.Color(color).offsetHSL(0, 0, 0.06), 0.9), 0, 0.49, 0.08);
        break;
      }
      case "SOFA_L": {
        // kanapa narożna: główne siedzisko wzdłuż szerokości, szezlong po stronie it.chaise ("L" | "R")
        const sd = 0.95, side = it.chaise === "R" ? 1 : -1;
        add(rb(w, 0.42, sd, 0.06), base, 0, 0.21, back + sd / 2);
        add(rb(w, h - 0.1, 0.22, 0.08), base, 0, (h - 0.1) / 2 + 0.1, back + 0.11);
        const cw = 0.95;
        add(rb(cw, 0.42, d - sd, 0.06), base, side * (w / 2 - cw / 2), 0.21, back + sd + (d - sd) / 2);
        add(rb(0.18, 0.62, sd, 0.07), base, -side * (w / 2 - 0.09), 0.31, back + sd / 2);
        add(rb(0.2, 0.62, d, 0.07), base, side * (w / 2 - 0.1), 0.31, 0);
        const cush = mat(new THREE.Color(color).offsetHSL(0, 0, 0.06), 0.9);
        add(rb(w - 0.5, 0.14, sd - 0.3, 0.06), cush, -side * 0.06, 0.49, back + sd / 2 + 0.08);
        add(rb(cw - 0.3, 0.14, d - sd - 0.1, 0.06), cush, side * (w / 2 - cw / 2 - 0.05), 0.49, back + sd + (d - sd) / 2);
        break;
      }
      case "STOL":
      case "BIURKO": {
        if (it.shape === "stadium" || it.shape === "soft") {
          // stadium: półokrągłe końce; soft: końce superelipsa (bardziej płaski łuk, zaokrąglone narożniki)
          const topT = it.topT || 0.04, R = d / 2, bev = 0.003;
          const e = it.shape === "soft" ? (it.endD || d * 0.42) : R;
          const n = it.shape === "soft" ? (it.endN || 2.6) : 2;
          const L = Math.max(0, w - 2 * e);
          const sh = new THREE.Shape();
          const pts = [];
          const sp = (v, k) => Math.sign(v) * Math.abs(v) ** (2 / k);
          for (let i = 0; i <= 64; i++) { const t = -Math.PI / 2 + (Math.PI * i) / 64; pts.push([L / 2 + (e - bev) * sp(Math.cos(t), n), (R - bev) * sp(Math.sin(t), n)]); }
          for (let i = 0; i <= 64; i++) { const t = Math.PI / 2 + (Math.PI * i) / 64; pts.push([-L / 2 + (e - bev) * sp(Math.cos(t), n), (R - bev) * sp(Math.sin(t), n)]); }
          sh.moveTo(pts[0][0], pts[0][1]);
          for (const [x, y] of pts.slice(1)) sh.lineTo(x, y);
          sh.closePath();
          const geo = new THREE.ExtrudeGeometry(sh, { depth: topT - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2, curveSegments: 12 });
          geo.rotateX(-Math.PI / 2);
          const wood = mat(color, 0.55, { map: woodTexture() });
          add(geo, wood, 0, h - topT + bev, 0);
          const lr = it.legR || 0.03;
          const lx = (it.legDx || w * 0.76) / 2 - lr, lz = (it.legDz || d * 0.64) / 2 - lr;
          const lg = new THREE.CylinderGeometry(lr, lr, h - topT, 32);
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(lg, mat(color, 0.55), sx * lx, (h - topT) / 2, sz * lz);
          break;
        }
        if (it.shape === "oval" || it.shape === "round") {
          const top = new THREE.CylinderGeometry(0.5, 0.5, 0.035, 64);
          top.scale(w, 1, it.shape === "round" ? w : d);
          add(top, base, 0, h - 0.0175, 0);
          const lg = new THREE.CylinderGeometry(0.03, 0.022, h - 0.035, 12);
          const lx = w / 2 - Math.min(0.32, w * 0.2), lz = (it.shape === "round" ? w : d) / 2 - 0.16;
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
            const m = add(lg, base, sx * lx, (h - 0.035) / 2, sz * lz);
            m.rotation.z = sx * 0.06; m.rotation.x = -sz * 0.06;
          }
          break;
        }
        add(rb(w, 0.04, d, 0.01), base, 0, h - 0.02, 0);
        const lg = new THREE.BoxGeometry(0.05, h - 0.04, 0.05);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(lg, dark, sx * (w / 2 - 0.06), (h - 0.04) / 2, sz * (d / 2 - 0.06));
        break;
      }
      case "KRZESLO_J": {
        // JANINGE: smukłe nogi o zaokrąglonym przekroju, cienkie siedzisko, płaskie oparcie na przedłużonych tylnych nogach
        const m = mat(color, 0.45);
        const seatH = 0.45, lt = 0.03;
        const leg = (x0, z0, x1, z1, y0, y1) => {
          const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
          const me = add(rb(lt, len, lt, 0.012), m, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
          me.rotation.z = Math.atan2(x0 - x1, y1 - y0);
          me.rotation.x = Math.atan2(z1 - z0, y1 - y0);
          return me;
        };
        const fx = w / 2 - 0.045, fz = d / 2 - 0.045;
        for (const sx of [-1, 1]) {
          leg(sx * (fx + 0.02), fz + 0.02, sx * (fx - 0.01), fz - 0.03, 0, seatH - 0.02); // przednie, lekko rozstawione
          leg(sx * (fx + 0.015), -fz - 0.02, sx * (fx - 0.005), -fz - 0.01, 0, h - 0.02); // tylna noga = słupek oparcia (jeden element)
        }
        const seat = add(rb(w - 0.05, 0.022, d - 0.07, 0.01), m, 0, seatH, 0.01);
        seat.rotation.x = -0.03;
        const backrest = add(rb(w - 0.03, 0.16, 0.022, 0.01), m, 0, h - 0.08, -fz - 0.025);
        backrest.rotation.x = -0.1;
        break;
      }
      case "KRZESLO": {
        add(rb(w, 0.05, d * 0.9, 0.02), base, 0, 0.46, 0.02);
        add(rb(w, 0.42, 0.04, 0.02), base, 0, 0.7, back + 0.03);
        const lg = new THREE.BoxGeometry(0.03, 0.44, 0.03);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(lg, dark, sx * (w / 2 - 0.04), 0.22, sz * (d / 2 - 0.05));
        break;
      }
      case "WANNA": {
        add(rb(w, h, d, 0.05), white, 0, h / 2, 0);
        add(rb(w - 0.14, 0.02, d - 0.14, 0.08), mat(0xdbeafe, 0.1), 0, h - 0.005, 0);
        break;
      }
      case "UMYWALKA": {
        add(rb(w, h - 0.12, d, 0.01), base === white ? white : mat(color, 0.6), 0, (h - 0.12) / 2, 0);
        add(rb(w, 0.12, d, 0.03), white, 0, h - 0.06, 0);
        add(rb(w * 0.6, 0.02, d * 0.55, 0.06), mat(0xe5e7eb, 0.15), 0, h - 0.002, 0.03);
        break;
      }
      case "WC": {
        add(new THREE.CylinderGeometry(w / 2, w / 2.4, h, 20).scale(1, 1, d / w * 0.8), white, 0, h / 2, 0.05);
        add(rb(w, 0.35, 0.16, 0.03), white, 0, h + 0.05, back + 0.08);
        break;
      }
      case "PRYSZNIC": {
        add(rb(w, h, d, 0.02), white, 0, h / 2, 0);
        const gl = new THREE.Mesh(new THREE.BoxGeometry(0.01, 2.0, d), new THREE.MeshStandardMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.22, depthWrite: false }));
        gl.position.set(w / 2 - 0.01, 1.0, 0);
        g.add(gl);
        add(new THREE.CylinderGeometry(0.03, 0.03, 0.01, 16), dark, 0, h + 0.003, 0);
        break;
      }
      case "ROSLINA": {
        add(new THREE.CylinderGeometry(w * 0.32, w * 0.25, 0.35, 20), mat(0xd6d3d1, 0.8), 0, 0.175, 0);
        const leaf = mat(color, 0.85);
        for (let i = 0; i < 6; i++) {
          const a = i * 1.1;
          add(new THREE.SphereGeometry(w * (0.22 + (i % 3) * 0.04), 12, 10), leaf,
            Math.cos(a) * w * 0.18, 0.45 + (h - 0.5) * (i / 6), Math.sin(a) * w * 0.18);
        }
        break;
      }
      case "DYWAN":
        add(rb(w, Math.max(h, 0.01), d, 0.004), base, 0, h / 2, 0);
        break;
      case "TV":
        add(rb(w, h, d, 0.01), dark, 0, h / 2 + 0.5, 0);
        break;
      default: {
        add(rb(w, h, d, 0.015), base, 0, h / 2, 0);
        if (["SZAFA", "KOMODA", "NOCNA", "REGAL", "SZAFKA_RTV"].includes(type) && h > 0.3) {
          const seams = type === "SZAFA" ? Math.max(1, Math.round(w / 0.5)) : type === "KOMODA" ? 0 : 0;
          const lineM = mat(0x9ca3af, 0.6);
          for (let i = 1; i < seams; i++) add(new THREE.BoxGeometry(0.004, h - 0.04, 0.004), lineM, -w / 2 + (w * i) / seams, h / 2, d / 2 + 0.001);
          if (type === "KOMODA" || type === "NOCNA") {
            const n = type === "KOMODA" ? 3 : 2;
            for (let i = 1; i < n; i++) add(new THREE.BoxGeometry(w - 0.04, 0.004, 0.004), lineM, 0, (h * i) / n, d / 2 + 0.001);
          }
        }
      }
    }
    // znacznik frontu (cienki pasek na górze z przodu - widoczny z góry)
    if (h > 0.2 && !["ROSLINA", "DYWAN", "WC", "TV", "KRZESLO", "KRZESLO_J", "STOL", "BIURKO", "FOTEL", "SOFA", "SOFA_L"].includes(type)) {
      add(new THREE.BoxGeometry(w * 0.6, 0.004, 0.02), mat(0x6b7280, 0.5), 0, h + 0.003, d / 2 - 0.02);
    }
  }

  // ------------------------------------------------------------ lampy
  _buildLight(l, f) {
    const kind = LIGHT_KINDS[l.kind] || LIGHT_KINDS.SUFIT;
    const g = new THREE.Group();
    let z = l.z ?? kind.z;
    if (z == null) z = f.height - 0.03;
    else if (z < 0) z = f.height + z;
    g.position.set(l.x, f.elev + z, -l.y);
    g.userData.pick = { kind: "light", id: l.id, entity: l.entity };
    const glowMat = new THREE.MeshStandardMaterial({ color: 0xfff7e6, emissive: 0x000000, emissiveIntensity: 1, roughness: 0.4 });
    const shadeMat = mat(l.color || 0xf5f5f4, 0.6);
    let fixture;
    let light;
    const k = l.kind || "SUFIT";
    if (k === "OCZKO") {
      fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 20), glowMat);
      fixture.position.y = -0.01;
      light = new THREE.SpotLight(0xffffff, 0, 0, 52 * D2R, 0.55, 2);
      light.position.set(0, -0.03, 0);
      light.target.position.set(0, -3, 0);
      g.add(light.target);
    } else if (k === "SUFIT") {
      fixture = new THREE.Mesh(new THREE.CylinderGeometry(l.size || 0.2, l.size || 0.2, 0.05, 32), glowMat);
      fixture.position.y = -0.025;
      light = new THREE.PointLight(0xffffff, 0, 0, 2);
      light.position.y = -0.12;
    } else if (k === "ZWIS") {
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, f.elev + f.height - (f.elev + z), 6), mat(0x222222));
      cord.position.y = (f.height - z) / 2;
      g.add(cord);
      fixture = new THREE.Mesh(new THREE.ConeGeometry(l.size || 0.2, 0.22, 32, 1, true), shadeMat);
      fixture.material.side = THREE.DoubleSide;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), glowMat);
      bulb.position.y = -0.05;
      g.add(bulb);
      light = new THREE.PointLight(0xffffff, 0, 0, 2);
      light.position.y = -0.12;
    } else if (k === "STOJACA" || k === "NOCNA") {
      const H = z;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, H, 8), mat(0x2b2b2b, 0.4));
      pole.position.y = -H / 2;
      g.add(pole);
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(k === "NOCNA" ? 0.07 : 0.15, k === "NOCNA" ? 0.07 : 0.15, 0.02, 20), mat(0x2b2b2b, 0.4));
      foot.position.y = -H + 0.01;
      g.add(foot);
      fixture = new THREE.Mesh(new THREE.CylinderGeometry(k === "NOCNA" ? 0.09 : 0.18, k === "NOCNA" ? 0.12 : 0.22, k === "NOCNA" ? 0.16 : 0.26, 28, 1, true), shadeMat);
      fixture.material.side = THREE.DoubleSide;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), glowMat);
      g.add(bulb);
      light = new THREE.PointLight(0xffffff, 0, 0, 2);
    } else if (k === "LED") {
      const len = l.len || 1.0;
      fixture = new THREE.Mesh(new THREE.BoxGeometry(len, 0.012, 0.03), glowMat);
      fixture.rotation.y = (l.rot || 0) * D2R;
      light = new THREE.PointLight(0xffffff, 0, 0, 2);
    } else {
      fixture = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.08), glowMat);
      light = new THREE.PointLight(0xffffff, 0, 0, 2);
    }
    g.add(fixture);
    g.add(light);
    light.castShadow = false;
    if (l.shadow && this.opts.quality === "high") {
      light.castShadow = true;
      light.shadow.mapSize.set(512, 512);
      light.shadow.bias = -0.002;
      light.shadow.camera.near = 0.05;
    }
    const sel = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.35, depthWrite: false }));
    sel.userData.selHelper = l.id;
    sel.visible = false;
    sel.raycast = () => {};
    g.add(sel);
    // większy niewidoczny cel kliknięcia
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    g.add(hit);
    this.lights.push({ def: l, light, glowMat, kind });
    return g;
  }

  _buildSensor(s, f) {
    const kind = SENSOR_KINDS[s.kind] || SENSOR_KINDS.INNY;
    const g = new THREE.Group();
    let z = s.z ?? kind.z;
    if (z == null) z = f.height - 0.06;
    g.position.set(s.x, f.elev + z, -s.y);
    g.userData.pick = { kind: "sensor", id: s.id, entity: s.entity };
    const m = new THREE.MeshStandardMaterial({ color: kind.color, emissive: kind.color, emissiveIntensity: 0.6, roughness: 0.4 });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 14), m);
    g.add(mesh);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.13, 32), new THREE.MeshBasicMaterial({ color: kind.color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    g.add(ring);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    g.add(hit);
    const sel = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.35, depthWrite: false }));
    sel.userData.selHelper = s.id;
    sel.visible = false;
    sel.raycast = () => {};
    g.add(sel);
    let tag = null;
    if (this.opts.labels && (s.kind === "TEMP" || s.kind === "WILG" || s.showValue)) {
      const el = document.createElement("div");
      el.className = "d3-tag";
      tag = new CSS2DObject(el);
      tag.position.set(0, 0.18, 0);
      g.add(tag);
    }
    this.sensors.push({ def: s, mesh, mat: m, ring, tag, kind });
    return g;
  }

  // ------------------------------------------------------------ modele i podkłady
  _loadGLB(name) {
    if (!this.gltfCache.has(name)) {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      this.gltfCache.set(name, new Promise((res, rej) => loader.load(this.opts.fileUrl(name), (g) => res(g.scene), undefined, rej)));
    }
    return this.gltfCache.get(name);
  }

  _buildModel(m, f) {
    const g = new THREE.Group();
    g.position.set(m.x || 0, f.elev + (m.z || 0), -(m.y || 0));
    g.rotation.y = (m.rot || 0) * D2R;
    const sc = m.scale || 1;
    g.scale.set(sc * (m.mirror ? -1 : 1), sc, sc);
    g.userData.pick = { kind: "model", id: m.id };
    if (m.file) {
      this._loadGLB(m.file).then((scene) => {
        const s = scene.clone(true);
        // Blender eksportuje Z-up -> glTF Y-up, a plan Blendera (x, y) -> three (x, -z). Zgodne z naszym układem.
        s.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = o.receiveShadow = true;
            if (m.hide && m.hide.some((p) => o.name.startsWith(p))) o.visible = false;
            if (!m.emissive) for (const mm of Array.isArray(o.material) ? o.material : [o.material]) if (mm && mm.emissive) mm.emissiveIntensity = 0;
          }
          if (o.isLight) {
            o.visible = !!m.keepLights;
            o.intensity *= 0.01;
          }
        });
        g.add(s);
        this.needsRender = true;
      }).catch((e) => console.warn("Dom3D: nie wczytano modelu", m.file, e));
    }
    return g;
  }

  _buildBackground(b, f) {
    const g = new THREE.Group();
    if (!b.file) return g;
    new THREE.TextureLoader().load(this.opts.fileUrl(b.file), (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const w = b.width || 10, h = w * (tex.image.height / tex.image.width);
      const geo = new THREE.PlaneGeometry(w, h);
      geo.translate(w / 2, h / 2, 0);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: b.opacity ?? 0.6, depthWrite: false, toneMapped: false }));
      mesh.position.set(b.x || 0, f.elev + 0.03, -(b.y || 0));
      mesh.rotation.y = (b.rot || 0) * D2R;
      mesh.renderOrder = 5;
      mesh.userData.pick = { kind: "background", id: b.id };
      g.add(mesh);
      this.needsRender = true;
    });
    g.userData.isBackground = true;
    return g;
  }

  // ------------------------------------------------------------ stany
  applyStates() {
    const S = this.states;
    let night = this._sunElevation() < -2;
    for (const L of this.lights) {
      const d = L.def;
      let on = false, level = 1, color = kelvinToHex(d.kelvin || 2700);
      if (d.entity) {
        const ls = lightState(S[d.entity]);
        if (ls) {
          on = ls.on;
          level = ls.level;
          if (ls.rgb) color = (ls.rgb[0] << 16) | (ls.rgb[1] << 8) | ls.rgb[2];
          else if (ls.kelvin) color = kelvinToHex(ls.kelvin);
        }
      } else if (d.preview) on = true;
      const curFloor = d.floor === this.floorId || (!d.floor && this.dom.floors[0].id === this.floorId);
      const lm = d.lm || L.kind.lm;
      L.light.color.setHex(color);
      L.light.intensity = on && curFloor ? (lm / (4 * Math.PI)) * LAMP_SCALE * level * (L.light.isSpotLight ? 2.2 : 1) * 1.6 : 0;
      L.glowMat.emissive.setHex(on ? color : 0x000000);
      L.glowMat.emissiveIntensity = on ? 1.2 + level * 2 : 0;
    }
    for (const s of this.sensors) {
      const st = S[s.def.entity];
      const active = sensorActive(st);
      s.active = active && (s.def.kind === "RUCH" || s.def.kind === "KONTAKTRON" || s.def.kind === "DYM" || s.def.kind === "ZALANIE");
      s.mat.emissiveIntensity = active ? 2.5 : st && st.state === "unavailable" ? 0 : 0.5;
      s.mat.color.set(st && st.state === "unavailable" ? 0x6b7280 : s.kind.color);
      if (s.tag) {
        const v = st ? `${st.state}${st.attributes && st.attributes.unit_of_measurement ? " " + st.attributes.unit_of_measurement : ""}` : "-";
        s.tag.element.textContent = v;
      }
    }
    for (const o of this.openingsBound) {
      const st = S[o.def.entity];
      const open = sensorActive(st);
      if (o.frames[0]) o.frames[0].material.color.set(open ? 0xef4444 : o.def.frameColor || 0x2b2d31);
      if (o.leaf) o.leaf.rotation.y = open ? o.leaf.userData.openAngle : 0;
    }
    for (const r of this.roomLabels) {
      const d = r.def;
      const lines = [];
      const t = d.temp_entity && S[d.temp_entity];
      const h = d.hum_entity && S[d.hum_entity];
      if (t && !isNaN(parseFloat(t.state))) lines.push(`${parseFloat(t.state).toFixed(1)}°C`);
      if (h && !isNaN(parseFloat(h.state))) lines.push(`${Math.round(parseFloat(h.state))}%`);
      r.el.innerHTML = `${escapeHtml(d.name || "")}${lines.length ? `<small>${lines.join(" · ")}</small>` : ""}`;
    }
    this._applySun();
    this.wrap.classList.toggle("d3-night", night);
    this.needsRender = true;
  }

  _sunPos() {
    if (this.editLight && !this.timeOverride) return { az: 200, el: 38 };
    const s = this.states["sun.sun"];
    if (!this.timeOverride && s && s.attributes && s.attributes.azimuth != null) {
      return { az: +s.attributes.azimuth, el: +s.attributes.elevation };
    }
    return sunPosition(this.timeOverride || new Date(), this.dom.lat || 52.4, this.dom.lon || 16.9);
  }

  _sunElevation() {
    return this._sunPos().el;
  }

  _applySun() {
    const { az, el } = this._sunPos();
    const ang = (az + (this.dom.north || 0)) * D2R;
    const e = Math.max(el, 0.5) * D2R;
    const dir = new THREE.Vector3(Math.sin(ang) * Math.cos(e), Math.sin(e), -Math.cos(ang) * Math.cos(e));
    const c = this._center();
    const R = c.radius;
    this.sun.position.copy(c.v).addScaledVector(dir, R * 3 + 10);
    this.sun.target.position.copy(c.v);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -R * 1.3;
    cam.right = cam.top = R * 1.3;
    cam.near = 0.5;
    cam.far = R * 6 + 30;
    cam.updateProjectionMatrix();
    const day = THREE.MathUtils.smoothstep(el, -6, 10);
    const warm = THREE.MathUtils.smoothstep(el, 0, 25);
    this.sun.intensity = el > 0 ? 3.6 * THREE.MathUtils.smoothstep(el, 0, 15) : 0;
    this.sun.color.setRGB(1, 0.78 + 0.2 * warm, 0.6 + 0.35 * warm);
    this.hemi.intensity = 0.04 + 1.1 * day;
    this.renderer.toneMappingExposure = 1.0 + (1 - day) * 0.35;
    const bg = new THREE.Color(0x0b1020).lerp(new THREE.Color(0x9fb7cc), day);
    this.scene.background = bg;
    this.wrap.classList.toggle("d3-night", el < -2);
    this.needsRender = true;
  }

  _center() {
    const box = new THREE.Box3();
    for (const w of this.dom.walls) {
      const f = floorById(this.dom, w.floor);
      box.expandByPoint(new THREE.Vector3(w.x1, f.elev, -w.y1));
      box.expandByPoint(new THREE.Vector3(w.x2, f.elev + f.height, -w.y2));
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5));
    const v = box.getCenter(new THREE.Vector3());
    return { v, radius: box.getSize(new THREE.Vector3()).length() / 2, box };
  }

  // ------------------------------------------------------------ widoczność, kamera
  _applyVisibility() {
    const cur = this.floor();
    for (const f of this.dom.floors) {
      const g = this.floorGroups[f.id];
      if (!g) continue;
      g.visible = this.mode === "top" ? f.id === cur.id || f.level === cur.level - 1 : f.level <= cur.level;
      g.traverse((o) => {
        if (o.isCSS2DObject) o.element.style.visibility = f.id === cur.id || this.mode !== "top" ? "" : "hidden";
      });
    }
    this.applyStates();
    this.root.traverse((o) => {
      if (o.userData.isBackground) o.visible = this.showBackgrounds;
    });
    this.needsRender = true;
  }

  _visibleChain(o) {
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  }

  _makeControls() {
    if (this.controls) this.controls.dispose();
    this.camera = this.mode === "top" ? this.orthoCam : this.perspCam;
    const rot = (this.opts.rotate || 0) * D2R;
    if (this.mode === "top") this.camera.up.set(Math.sin(rot), 0, -Math.cos(rot));
    else this.camera.up.set(0, 1, 0);
    const c = (this.controls = new OrbitControls(this.camera, this.renderer.domElement));
    c.enableDamping = false;
    c.screenSpacePanning = true;
    c.zoomToCursor = true;
    if (this.mode === "top") {
      c.enableRotate = false;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      c.maxPolarAngle = Math.PI / 2 - 0.02;
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    }
    c.addEventListener("change", () => (this.needsRender = true));
    this._userControls = c;
  }

  setPanOnLeft(enabled) {
    // edytor przejmuje lewy przycisk
    const c = this.controls;
    if (this.mode === "top") c.mouseButtons.LEFT = enabled ? THREE.MOUSE.PAN : null;
    else c.mouseButtons.LEFT = enabled ? THREE.MOUSE.ROTATE : null;
    c.touches.ONE = enabled ? (this.mode === "top" ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE) : null;
  }

  fit() {
    const f = this.floor();
    const fp = this._footprint(f) || { x0: -5, x1: 5, y0: -5, y1: 5 };
    const cx = (fp.x0 + fp.x1) / 2, cy = (fp.y0 + fp.y1) / 2;
    const w = fp.x1 - fp.x0 + 1.0, h = fp.y1 - fp.y0 + 1.0;
    const aspect = this._aspect();
    const rot = (this.opts.rotate || 0) * D2R;
    const rw = Math.abs(w * Math.cos(rot)) + Math.abs(h * Math.sin(rot));
    const rh = Math.abs(w * Math.sin(rot)) + Math.abs(h * Math.cos(rot));
    if (this.mode === "top") {
      const halfH = Math.max(rh / 2, rw / 2 / aspect);
      const cam = this.orthoCam;
      cam.left = -halfH * aspect; cam.right = halfH * aspect; cam.top = halfH; cam.bottom = -halfH;
      cam.zoom = 1;
      cam.position.set(cx, f.elev + 40, -cy);
      cam.near = 0.1; cam.far = 100;
      cam.updateProjectionMatrix();
      this.controls.target.set(cx, f.elev, -cy);
    } else {
      const cam = this.perspCam;
      const dist = Math.max(w, h) * 1.25 + 4;
      cam.position.set(cx + dist * 0.55, f.elev + dist * 0.75, -cy + dist * 0.75);
      this.controls.target.set(cx, f.elev + 0.8, -cy);
    }
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.needsRender = true;
  }

  _aspect() {
    const r = this.container.getBoundingClientRect();
    return Math.max(0.2, (r.width || 800) / (r.height || 600));
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const w = Math.max(50, r.width), h = Math.max(50, r.height);
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.perspCam.aspect = w / h;
    this.perspCam.updateProjectionMatrix();
    const oc = this.orthoCam;
    const halfH = (oc.top - oc.bottom) / 2;
    oc.left = -halfH * (w / h); oc.right = halfH * (w / h);
    oc.updateProjectionMatrix();
    this.needsRender = true;
  }

  _setPointer(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  _bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY, t: Date.now() }));
    el.addEventListener("pointerup", (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 6 || !this.onClick || this.editing) return;
      const hit = this.pick(e, (p) => p.kind === "light" || p.kind === "sensor" || p.kind === "opening" || p.kind === "room");
      if (hit) this.onClick(hit, e);
    });
  }

  _loop(t) {
    this._raf = requestAnimationFrame(this._loop);
    let anim = false;
    for (const s of this.sensors) {
      if (s.active) {
        const k = (Math.sin(t / 220) + 1) / 2;
        s.ring.material.opacity = 0.25 + 0.6 * k;
        s.ring.scale.setScalar(1 + k * 1.2);
        anim = true;
      } else if (s.ring.material.opacity !== 0) {
        s.ring.material.opacity = 0;
        this.needsRender = true;
      }
    }
    if (!this.needsRender && !anim) return;
    this.needsRender = false;
    this.renderer.render(this.scene, this.camera);
    if (this.opts.labels) this.labelRenderer.render(this.scene, this.camera);
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
