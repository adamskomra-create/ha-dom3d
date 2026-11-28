import * as THREE from "three";
import {
  FURN, LIGHT_KINDS, SENSOR_KINDS, uid, wallLen, wallAngle, projectOnWall, rectPoly, round, floorById,
} from "./model.js";

const SNAP_END = 0.22;

export class Editor {
  constructor(viewer, store, ui) {
    this.v = viewer;
    this.store = store; // {dom, commit(fn, opts), select(id)}
    this.ui = ui; // {status(text), options()}
    this.tool = "select";
    this.grid = 0.05;
    this.wallT = 0.12;
    this.furnType = "SOFA";
    this.lightKind = "SUFIT";
    this.sensorKind = "RUCH";
    this.modelFile = "";
    this.stairDir = "x+";
    this.chain = null;
    this.keyBuf = "";
    this.drag = null;
    this.overlay = new THREE.Group();
    this.overlay.renderOrder = 10;
    viewer.scene.add(this.overlay);
    this.handles = [];
    const wrap = viewer.wrap;
    wrap.addEventListener("pointerdown", (e) => this._down(e), true);
    wrap.addEventListener("pointermove", (e) => this._move(e), true);
    window.addEventListener("pointerup", (e) => this._up(e), true);
    wrap.addEventListener("dblclick", (e) => this._dbl(e));
    wrap.addEventListener("contextmenu", (e) => { if (this.tool !== "select" && this.tool !== "view") e.preventDefault(); });
    window.addEventListener("keydown", (e) => this._key(e));
    this.setTool("select");
  }

  get dom() { return this.store.dom; }
  get floor() { return this.v.floor(); }

  setTool(t) {
    this.tool = t;
    this.chain = null;
    this.keyBuf = "";
    this.calib = null;
    this._clearPreview();
    this.v.editing = t !== "view";
    this.v.renderer.domElement.style.cursor = t === "select" || t === "view" ? "default" : "crosshair";
    this._hint();
    this.refreshHandles();
  }

  _hint(extra = "") {
    const H = {
      view: "Podgląd: kliknij lampę, żeby ją przełączyć. Przeciągaj, żeby przesuwać widok.",
      select: "Klik = zaznacz, przeciągnij = przesuń. Obrót: przeciągnij pomarańczowy uchwyt (co 15°, z Shift co 1°), Q/E ±15° (Shift ±1°), R 90°. Del usuń, Ctrl+D duplikuj. Puste tło = przesuwanie widoku.",
      wall: "Klikaj kolejne narożniki. Wpisz długość (np. 3.45) i Enter. Shift = dowolny kąt. Esc/prawy = koniec.",
      room: "Przeciągnij prostokąt pokoju.",
      window: "Kliknij na ścianę, żeby wstawić okno.",
      door: "Kliknij na ścianę, żeby wstawić drzwi.",
      passage: "Kliknij na ścianę, żeby wstawić przejście bez drzwi.",
      item: "Kliknij, żeby postawić mebel. Rodzaj wybierasz na pasku.",
      light: "Kliknij, żeby dodać lampę. Encję przypiszesz po prawej.",
      sensor: "Kliknij, żeby dodać czujkę / punkt.",
      stairs: "Przeciągnij prostokąt biegu schodów (kierunek wejścia na pasku).",
      model: "Kliknij, żeby wstawić model .glb (wybierz plik na pasku).",
      calib: "Kalibracja podkładu: kliknij 2 punkty o znanej odległości.",
    };
    this.ui.status((H[this.tool] || "") + (extra ? "   " + extra : ""));
  }

  // ------------------------------------------------------------ snapping
  _snapGrid(p) {
    const g = this.grid;
    return { x: round(Math.round(p.x / g) * g, 3), y: round(Math.round(p.y / g) * g, 3) };
  }

  _endpoints(excludeId) {
    const out = [];
    for (const w of this.dom.walls) {
      if (w.floor !== this.floor.id || w.id === excludeId) continue;
      out.push({ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 });
    }
    return out;
  }

  _snap(p, from, e, excludeId) {
    if (!p) return p;
    if (e && e.altKey) return { x: round(p.x), y: round(p.y) };
    let best = null, bd = SNAP_END;
    for (const q of this._endpoints(excludeId)) {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = { x: q.x, y: q.y, snapped: "punkt" }; }
    }
    if (best) return best;
    if (from && !(e && e.shiftKey)) {
      const dx = p.x - from.x, dy = p.y - from.y;
      const L = Math.hypot(dx, dy);
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const Ls = Math.round(L / this.grid) * this.grid;
      let q = { x: from.x + Math.cos(a) * Ls, y: from.y + Math.sin(a) * Ls };
      // wyrównanie do punktów innych ścian w osi
      for (const ep of this._endpoints(excludeId)) {
        if (Math.abs(Math.cos(a)) > 0.99 && Math.abs(ep.x - q.x) < 0.12) q.x = ep.x;
        if (Math.abs(Math.sin(a)) > 0.99 && Math.abs(ep.y - q.y) < 0.12) q.y = ep.y;
      }
      return { x: round(q.x), y: round(q.y) };
    }
    return this._snapGrid(p);
  }

  // ------------------------------------------------------------ pointer
  _down(e) {
    if (e.button !== 0 || this.tool === "view") return;
    const p = this.v.planPoint(e);
    if (!p) return;
    if (this.tool === "select") {
      const h = this._pickHandle(e);
      if (h) {
        this._noPan();
        this.drag = { type: "handle", h, start: p, snapshot: this.store.snapshot() };
        return;
      }
      const hit = this.v.pick(e, (k) => !["background"].includes(k.kind) || this.v.showBackgrounds);
      if (hit) {
        this._noPan();
        const id = hit.kind === "opening" ? hit.id : hit.id;
        this.store.select(id, hit.kind, hit.wall);
        this.drag = { type: "move", hit, start: p, last: p, snapshot: this.store.snapshot(), moved: false };
      } else {
        this.store.select(null);
      }
      return;
    }
    this._noPan();
    const sp = this._snap(p, this.chain && this.chain.start, e);
    switch (this.tool) {
      case "wall":
        if (!this.chain) this.chain = { start: sp };
        else this._addWall(this.chain.start, sp);
        break;
      case "room":
      case "stairs":
        this.drag = { type: this.tool, a: this._snapGrid(p) };
        break;
      case "window":
      case "door":
      case "passage":
        this._addOpening(p);
        break;
      case "item":
        this._addAt("items", {
          type: this.furnType, name: FURN[this.furnType].name, x: sp.x, y: sp.y, rot: 0,
          w: FURN[this.furnType].w, d: FURN[this.furnType].d, h: FURN[this.furnType].h,
        });
        break;
      case "light":
        this._addAt("lights", { kind: this.lightKind, name: LIGHT_KINDS[this.lightKind].name, entity: "", x: sp.x, y: sp.y, kelvin: 2700, lm: LIGHT_KINDS[this.lightKind].lm });
        break;
      case "sensor":
        this._addAt("sensors", { kind: this.sensorKind, name: SENSOR_KINDS[this.sensorKind].name, entity: "", x: sp.x, y: sp.y });
        break;
      case "model":
        if (!this.modelFile) { this.ui.status("Najpierw wybierz albo wgraj plik .glb na pasku."); return; }
        this._addAt("models", { name: this.modelFile.replace(/\.glb$/i, ""), file: this.modelFile, x: sp.x, y: sp.y, z: 0, rot: 0, scale: 1 });
        break;
      case "calib":
        this._calibClick(p);
        break;
    }
  }

  _move(e) {
    const p = this.v.planPoint(e);
    if (!p) return;
    const coord = `x ${p.x.toFixed(2)}  y ${p.y.toFixed(2)}`;
    if (this.drag) {
      e.stopPropagation();
      if (this.drag.type === "move") return this._dragMove(p, e);
      if (this.drag.type === "handle") return this._dragHandle(p, e);
      if (this.drag.type === "room" || this.drag.type === "stairs") {
        const b = this._snapGrid(p);
        this.drag.b = b;
        this._previewRect(this.drag.a, b);
        this._hint(`${Math.abs(b.x - this.drag.a.x).toFixed(2)} × ${Math.abs(b.y - this.drag.a.y).toFixed(2)} m`);
      }
      return;
    }
    if (this.tool === "wall" && this.chain) {
      const sp = this._snap(p, this.chain.start, e);
      this.chain.cur = sp;
      this._previewWall(this.chain.start, sp);
      const L = Math.hypot(sp.x - this.chain.start.x, sp.y - this.chain.start.y);
      this._hint(`długość ${L.toFixed(2)} m${this.keyBuf ? "  wpisano: " + this.keyBuf : ""}${sp.snapped ? "  [przyciąganie]" : ""}`);
    } else if (this.tool === "wall") {
      const sp = this._snap(p, null, e);
      this._previewDot(sp);
      this._hint(coord);
    } else if (["window", "door", "passage"].includes(this.tool)) {
      const w = this._nearestWall(p);
      this.v.setSelected(w ? w.id : null);
    } else if (this.tool !== "select" && this.tool !== "view") {
      this._hint(coord);
    }
  }

  _up(e) {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    this._yesPan();
    if (d.type === "move" || d.type === "handle") {
      if (d.moved) this.store.commit(null, { snapshot: d.snapshot });
      this.refreshHandles();
      return;
    }
    if ((d.type === "room" || d.type === "stairs") && d.b) {
      this._clearPreview();
      const { a, b } = d;
      if (Math.abs(b.x - a.x) < 0.2 || Math.abs(b.y - a.y) < 0.2) return;
      if (d.type === "room") {
        const n = this.dom.rooms.filter((r) => r.floor === this.floor.id).length + 1;
        this._addAt("rooms", { name: "Pokój " + n, poly: rectPoly(a.x, a.y, b.x, b.y), finish: "DREWNO" }, false);
      } else {
        const f = this.floor;
        const up = this.dom.floors.find((g) => g.level === f.level + 1);
        this._addAt("stairs", {
          x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
          dir: this.stairDir, steps: 14, z0: 0, z1: up ? round(up.elev - f.elev) : f.height,
        }, false);
      }
    }
  }

  _dbl(e) {
    if (this.tool === "wall" && this.chain) { this.chain = null; this._clearPreview(); this._hint(); }
  }

  _noPan() { this.v.controls.enabled = false; }
  _yesPan() { this.v.controls.enabled = true; }

  _key(e) {
    const tag = (e.target && e.target.tagName) || "";
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.store.redo() : this.store.undo(); return; }
    if (ctrl && e.key.toLowerCase() === "y") { e.preventDefault(); this.store.redo(); return; }
    if (ctrl && e.key.toLowerCase() === "s") { e.preventDefault(); this.store.save(); return; }
    if (ctrl && e.key.toLowerCase() === "d") { e.preventDefault(); this.duplicate(); return; }
    if (e.key === "Escape") {
      if (this.chain) { this.chain = null; this._clearPreview(); }
      else this.setTool("select");
      this._hint();
      return;
    }
    if (this.tool === "wall" && this.chain) {
      if (/^[0-9.,]$/.test(e.key)) { this.keyBuf += e.key === "," ? "." : e.key; this._hint("wpisano: " + this.keyBuf); return; }
      if (e.key === "Backspace") { this.keyBuf = this.keyBuf.slice(0, -1); return; }
      if (e.key === "Enter" && this.keyBuf) {
        const L = parseFloat(this.keyBuf);
        this.keyBuf = "";
        const s = this.chain.start, c = this.chain.cur || { x: s.x + 1, y: s.y };
        const a = Math.atan2(c.y - s.y, c.x - s.x);
        if (L > 0) this._addWall(s, { x: round(s.x + Math.cos(a) * L), y: round(s.y + Math.sin(a) * L) });
        return;
      }
    }
    if (this.tool === "select" && this.store.sel) {
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.deleteSelected(); }
      if (e.key.toLowerCase() === "r") { e.preventDefault(); this.rotateSelected(e.shiftKey ? -90 : 90); }
      if (e.key.toLowerCase() === "q") { e.preventDefault(); this.rotateSelected(e.shiftKey ? 1 : 15); return; }
      if (e.key.toLowerCase() === "e") { e.preventDefault(); this.rotateSelected(e.shiftKey ? -1 : -15); return; }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (arrows[e.key]) {
        e.preventDefault();
        const s = e.shiftKey ? 0.1 : 0.01;
        this.nudge(arrows[e.key][0] * s, arrows[e.key][1] * s);
      }
    }
    const shortcuts = { v: "view", s: "select", w: "wall", p: "room", o: "window", d: "door", m: "item", l: "light", c: "sensor" };
    if (!ctrl && !e.altKey && shortcuts[e.key] && !(this.tool === "select" && this.store.sel && e.key === "r")) {
      this.ui.setTool(shortcuts[e.key]);
    }
  }

  // ------------------------------------------------------------ operacje
  _addAt(coll, obj, select = true) {
    obj.id = uid(coll[0]);
    obj.floor = this.floor.id;
    this.store.commit((dom) => dom[coll].push(obj));
    if (select !== false) this.store.select(obj.id, this._kindOf(coll));
    else this.store.select(obj.id, this._kindOf(coll));
    return obj;
  }

  _kindOf(coll) {
    return { walls: "wall", rooms: "room", items: "item", lights: "light", sensors: "sensor", models: "model", stairs: "stairs", backgrounds: "background" }[coll];
  }

  _addWall(a, b) {
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.05) return;
    const w = { id: uid("w"), floor: this.floor.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y, t: this.wallT, openings: [] };
    this.store.commit((dom) => dom.walls.push(w));
    this.chain = { start: { x: b.x, y: b.y } };
    this._hint();
  }

  _nearestWall(p) {
    let best = null, bd = Infinity;
    for (const w of this.dom.walls) {
      if (w.floor !== this.floor.id) continue;
      const pr = projectOnWall(w, p.x, p.y);
      if (pr.t < 0 || pr.t > wallLen(w)) continue;
      if (pr.d < w.t / 2 + 0.35 && pr.d < bd) { bd = pr.d; best = w; }
    }
    return best;
  }

  _addOpening(p) {
    const w = this._nearestWall(p);
    if (!w) { this.ui.status("Kliknij bliżej ściany."); return; }
    const L = wallLen(w);
    const def = {
      window: { width: 1.2, height: 1.4, sill: 0.85 },
      door: { width: 0.9, height: 2.05, sill: 0 },
      passage: { width: 0.9, height: 2.05, sill: 0 },
    }[this.tool];
    const pr = projectOnWall(w, p.x, p.y);
    const width = Math.min(def.width, L - 0.02);
    const offset = round(Math.max(0, Math.min(L - width, pr.tc - width / 2)), 2);
    const op = { id: uid("op"), type: this.tool, offset, width, height: def.height, sill: def.sill, name: "" };
    this.store.commit((dom) => dom.walls.find((x) => x.id === w.id).openings.push(op));
    this.store.select(op.id, "opening", w.id);
  }

  _dragMove(p, e) {
    const d = this.drag;
    const sp = e.altKey ? p : this._snapGrid(p);
    const s0 = e.altKey ? d.start : this._snapGrid(d.start);
    const dx = round(sp.x - s0.x), dy = round(sp.y - s0.y);
    const pdx = dx - (d.ldx || 0), pdy = dy - (d.ldy || 0);
    if (!pdx && !pdy) return;
    d.ldx = dx; d.ldy = dy; d.moved = true;
    const k = d.hit.kind;
    this.store.commit((dom) => {
      if (k === "opening") {
        const w = dom.walls.find((x) => x.id === d.hit.wall);
        const op = w && w.openings.find((o) => o.id === d.hit.id);
        if (!op) return;
        const pr = projectOnWall(w, p.x, p.y);
        op.offset = round(Math.max(0, Math.min(wallLen(w) - op.width, (d.off0 ??= op.offset) + (pr.t - (d.t0 ??= pr.t)))), 2);
        return;
      }
      const o = findAny(dom, d.hit.id);
      if (!o) return;
      if (k === "wall") { o.x1 = round(o.x1 + pdx); o.y1 = round(o.y1 + pdy); o.x2 = round(o.x2 + pdx); o.y2 = round(o.y2 + pdy); }
      else if (k === "room") o.poly = o.poly.map(([x, y]) => [round(x + pdx), round(y + pdy)]);
      else if (k === "stairs") { o.x0 = round(o.x0 + pdx); o.x1 = round(o.x1 + pdx); o.y0 = round(o.y0 + pdy); o.y1 = round(o.y1 + pdy); }
      else { o.x = round((o.x || 0) + pdx); o.y = round((o.y || 0) + pdy); }
    }, { history: false, rebuild: "throttle" });
    this.refreshHandles();
  }

  _dragHandle(p, e) {
    const d = this.drag;
    const h = d.h;
    d.moved = true;
    this.store.commit((dom) => {
      if (h.kind === "wallEnd") {
        const w = dom.walls.find((x) => x.id === h.id);
        if (!w) return;
        const other = h.end === 1 ? { x: w.x2, y: w.y2 } : { x: w.x1, y: w.y1 };
        const sp = this._snap(p, other, e, w.id);
        const old = h.end === 1 ? { x: w.x1, y: w.y1 } : { x: w.x2, y: w.y2 };
        // ściany połączone w tym punkcie idą razem (bez Ctrl)
        if (!(e.ctrlKey || e.metaKey)) {
          for (const o of dom.walls) {
            if (o.id === w.id || o.floor !== w.floor) continue;
            if (Math.hypot(o.x1 - old.x, o.y1 - old.y) < 0.005) { o.x1 = sp.x; o.y1 = sp.y; }
            if (Math.hypot(o.x2 - old.x, o.y2 - old.y) < 0.005) { o.x2 = sp.x; o.y2 = sp.y; }
          }
        }
        if (h.end === 1) { w.x1 = sp.x; w.y1 = sp.y; } else { w.x2 = sp.x; w.y2 = sp.y; }
        h.x = sp.x; h.y = sp.y;
      } else if (h.kind === "roomVert") {
        const r = dom.rooms.find((x) => x.id === h.id);
        if (!r) return;
        const sp = e.altKey ? p : this._snapGrid(p);
        r.poly[h.i] = [round(sp.x), round(sp.y)];
      } else if (h.kind === "rotate") {
        const o = findAny(dom, h.id);
        if (!o) return;
        let deg = (Math.atan2(p.x - h.cx, -(p.y - h.cy)) * 180) / Math.PI;
        const step = e.shiftKey ? 1 : 15;          // domyślnie co 15°, z Shift co 1°
        deg = Math.round(deg / step) * step;
        o.rot = ((deg % 360) + 360) % 360;
        this._hint(`obrót ${o.rot}°  (Shift = co 1°)`);
      }
    }, { history: false, rebuild: "throttle" });
    this.refreshHandles();
  }

  rotateSelected(deg) {
    const id = this.store.sel;
    this.store.commit((dom) => {
      const o = findAny(dom, id);
      if (!o) return;
      if ("rot" in o || o.x !== undefined) o.rot = (((o.rot || 0) + deg) % 360 + 360) % 360;
      if (o.x1 !== undefined) { // ściana: obrót wokół środka
        const cx = (o.x1 + o.x2) / 2, cy = (o.y1 + o.y2) / 2, a = (deg * Math.PI) / 180;
        const r = (x, y) => [round(cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a)), round(cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a))];
        [o.x1, o.y1] = r(o.x1, o.y1); [o.x2, o.y2] = r(o.x2, o.y2);
      }
    });
    this.refreshHandles();
  }

  nudge(dx, dy) {
    const id = this.store.sel;
    this.store.commit((dom) => {
      const o = findAny(dom, id);
      if (!o) return;
      if (o.x1 !== undefined) { o.x1 = round(o.x1 + dx); o.x2 = round(o.x2 + dx); o.y1 = round(o.y1 + dy); o.y2 = round(o.y2 + dy); }
      else if (o.poly) o.poly = o.poly.map(([x, y]) => [round(x + dx), round(y + dy)]);
      else if (o.x0 !== undefined) { o.x0 = round(o.x0 + dx); o.x1 = round(o.x1 + dx); o.y0 = round(o.y0 + dy); o.y1 = round(o.y1 + dy); }
      else if (o.offset !== undefined) o.offset = round(Math.max(0, o.offset + dx), 3);
      else { o.x = round((o.x || 0) + dx); o.y = round((o.y || 0) + dy); }
    });
    this.refreshHandles();
  }

  deleteSelected() {
    const id = this.store.sel;
    if (!id) return;
    this.store.commit((dom) => {
      for (const k of ["walls", "rooms", "items", "lights", "sensors", "models", "stairs", "backgrounds"]) {
        const i = dom[k].findIndex((o) => o.id === id);
        if (i >= 0) { dom[k].splice(i, 1); return; }
      }
      for (const w of dom.walls) {
        const i = w.openings.findIndex((o) => o.id === id);
        if (i >= 0) { w.openings.splice(i, 1); return; }
      }
    });
    this.store.select(null);
  }

  duplicate() {
    const id = this.store.sel;
    if (!id) return;
    let made = null;
    this.store.commit((dom) => {
      for (const k of ["walls", "rooms", "items", "lights", "sensors", "models", "stairs"]) {
        const o = dom[k].find((x) => x.id === id);
        if (!o) continue;
        const c = JSON.parse(JSON.stringify(o));
        c.id = uid(k[0]);
        if (c.x1 !== undefined) { c.x1 += 0.3; c.x2 += 0.3; c.y1 -= 0.3; c.y2 -= 0.3; for (const op of c.openings || []) op.id = uid("op"); }
        else if (c.poly) c.poly = c.poly.map(([x, y]) => [x + 0.3, y - 0.3]);
        else if (c.x0 !== undefined) { c.x0 += 0.3; c.x1 += 0.3; }
        else { c.x = (c.x || 0) + 0.3; c.y = (c.y || 0) - 0.3; }
        if (c.name) c.name += " (kopia)";
        dom[k].push(c);
        made = { id: c.id, kind: this._kindOf(k) };
        return;
      }
    });
    if (made) this.store.select(made.id, made.kind);
  }

  // ------------------------------------------------------------ kalibracja podkładu
  _calibClick(p) {
    if (!this.calib) { this.calib = { a: p }; this._previewDot(p); this.ui.status("Kliknij drugi punkt."); return; }
    const a = this.calib.a, b = p;
    this.calib = null;
    this._clearPreview();
    const meas = Math.hypot(b.x - a.x, b.y - a.y);
    const real = parseFloat((prompt(`Zmierzono ${meas.toFixed(3)} m na podkładzie. Jaka jest rzeczywista odległość (m)?`) || "").replace(",", "."));
    if (!(real > 0) || !(meas > 0)) { this.setTool("select"); return; }
    const k = real / meas;
    const bgId = this.store.sel;
    this.store.commit((dom) => {
      const bg = dom.backgrounds.find((x) => x.id === bgId) || dom.backgrounds.find((x) => x.floor === this.floor.id);
      if (!bg) return;
      bg.width = round((bg.width || 10) * k, 4);
      bg.x = round(a.x - (a.x - (bg.x || 0)) * k, 4);
      bg.y = round(a.y - (a.y - (bg.y || 0)) * k, 4);
    });
    this.setTool("select");
    this.ui.status(`Podkład przeskalowany ×${k.toFixed(4)}.`);
  }

  // ------------------------------------------------------------ uchwyty i podgląd
  refreshHandles() {
    for (const h of this.handles) this.overlay.remove(h.mesh);
    this.handles = [];
    if (this.tool !== "select" || !this.store.sel) { this.v.render(); return; }
    const f = this.floor;
    const add = (x, y, data) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), new THREE.MeshBasicMaterial({ color: 0x2563eb, depthTest: false }));
      m.renderOrder = 20;
      m.position.set(x, f.elev + (this.v.mode === "top" ? f.height + 0.1 : 0.1), -y);
      this.overlay.add(m);
      this.handles.push({ mesh: m, ...data, x, y });
    };
    const w = this.dom.walls.find((x) => x.id === this.store.sel);
    if (w) { add(w.x1, w.y1, { kind: "wallEnd", id: w.id, end: 1 }); add(w.x2, w.y2, { kind: "wallEnd", id: w.id, end: 2 }); }
    const r = this.dom.rooms.find((x) => x.id === this.store.sel);
    if (r) r.poly.forEach(([x, y], i) => add(x, y, { kind: "roomVert", id: r.id, i }));
    // uchwyt obrotu (pomarańczowy) dla mebli, modeli, lamp i podkładów
    const o = ["items", "models", "lights", "backgrounds"].map((c) => (this.dom[c] || []).find((x) => x.id === this.store.sel)).find(Boolean);
    if (o && o.x !== undefined) {
      const preset = (FURN && FURN[o.type]) || {};
      const R = Math.max(o.w || preset.w || 0.4, o.d || preset.d || 0.4, o.width || 0) / 2 + 0.35;
      const t = ((o.rot || 0) * Math.PI) / 180;
      const hx = o.x + Math.sin(t) * R, hy = o.y - Math.cos(t) * R;
      add(hx, hy, { kind: "rotate", id: o.id, cx: o.x, cy: o.y });
      const last = this.handles[this.handles.length - 1].mesh;
      last.material.color.set(0xf59e0b);
      const ring = new THREE.Mesh(new THREE.RingGeometry(R - 0.012, R + 0.012, 96), new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 19;
      ring.position.set(o.x, last.position.y - 0.01, -o.y);
      ring.raycast = () => {};
      this.overlay.add(ring);
      this.handles.push({ mesh: ring, kind: "ring" });
    }
    this.v.render();
  }

  _pickHandle(e) {
    if (!this.handles.length) return null;
    this.v._setPointer(e);
    this.v.raycaster.setFromCamera(this.v.pointer, this.v.camera);
    const hits = this.v.raycaster.intersectObjects(this.handles.map((h) => h.mesh), false);
    if (!hits.length) return null;
    return this.handles.find((h) => h.mesh === hits[0].object);
  }

  _clearPreview() {
    if (this.prev) { this.overlay.remove(this.prev); this.prev = null; }
    this.v.render();
  }

  _setPrev(obj) {
    this._clearPreview();
    this.prev = obj;
    this.overlay.add(obj);
    this.v.render();
  }

  _previewWall(a, b) {
    const f = this.floor;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(L, 0.01), f.height, this.wallT),
      new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.45, depthWrite: false }));
    m.position.set(L / 2, f.height / 2, 0);
    g.add(m);
    g.position.set(a.x, f.elev, -a.y);
    g.rotation.y = Math.atan2(b.y - a.y, b.x - a.x);
    this._setPrev(g);
  }

  _previewRect(a, b) {
    const f = this.floor;
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w, 0.01), 0.04, Math.max(h, 0.01)),
      new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.45, depthWrite: false }));
    m.position.set((a.x + b.x) / 2, f.elev + 0.03, -(a.y + b.y) / 2);
    this._setPrev(m);
  }

  _previewDot(p) {
    const f = this.floor;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), new THREE.MeshBasicMaterial({ color: 0xf59e0b, depthTest: false }));
    m.renderOrder = 20;
    m.position.set(p.x, f.elev + 0.05, -p.y);
    this._setPrev(m);
  }
}

export function findAny(dom, id) {
  if (!id) return null;
  for (const k of ["walls", "rooms", "items", "lights", "sensors", "models", "stairs", "backgrounds"]) {
    const o = dom[k].find((x) => x.id === id);
    if (o) return o;
  }
  for (const w of dom.walls) {
    const o = w.openings.find((x) => x.id === id);
    if (o) return o;
  }
  const f = dom.floors.find((x) => x.id === id);
  return f || null;
}
