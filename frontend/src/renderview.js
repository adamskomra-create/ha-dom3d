// Tryb "render": fotorealistyczny rzut z Blendera + warstwy światła sterowane encjami HA.
// dom.renders: [{ floor, bounds:[x0,x1,y0,y1], day, night, lights:[{light, file}] }]
import { lightState, sunPosition } from "./model.js";

const CSS = `
.rv{position:absolute;inset:0;background:#0b0d10;overflow:hidden;display:none;touch-action:none}
.rv.on{display:block}
.rv-stage{position:absolute;transform-origin:0 0}
.rv-stage img{position:absolute;inset:0;width:100%;height:100%;user-select:none;-webkit-user-drag:none;pointer-events:none}
.rv-stage img.l{mix-blend-mode:plus-lighter;transition:opacity .6s ease}
.rv-stage img.n{transition:opacity 2s ease}
.rv-hot{position:absolute;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;cursor:pointer;
  border:2px solid rgba(255,255,255,.55);background:rgba(20,24,32,.25);transition:background .3s,box-shadow .3s}
.rv-hot.on{background:rgba(255,214,140,.55);box-shadow:0 0 14px rgba(255,200,120,.9)}
.rv-hot:hover{border-color:#fff}
.rv-tip{position:absolute;left:50%;top:34px;transform:translateX(-50%);white-space:nowrap;font:600 11px system-ui,sans-serif;
  color:#fff;background:rgba(17,24,39,.85);padding:2px 6px;border-radius:6px;display:none}
.rv-hot:hover .rv-tip{display:block}
`;

export class RenderView {
  constructor(container, opts) {
    this.opts = { fileUrl: (n) => "files/" + n, onClick: null, hotspots: true, ...opts };
    this.container = container;
    const root = opts.shadowRoot || document.head;
    if (!(opts.shadowRoot ? opts.shadowRoot.querySelector("#rv-style") : document.getElementById("rv-style"))) {
      const s = document.createElement("style");
      s.id = "rv-style";
      s.textContent = CSS;
      root.appendChild(s);
    }
    this.el = document.createElement("div");
    this.el.className = "rv";
    container.appendChild(this.el);
    this.stage = document.createElement("div");
    this.stage.className = "rv-stage";
    this.el.appendChild(this.stage);
    this.states = {};
    this.dom = opts.dom;
    this.floorId = null;
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this._bindGestures();
    this.ro = new ResizeObserver(() => this._layout());
    this.ro.observe(container);
    this._sunTimer = setInterval(() => this._applyDayNight(), 60000);
  }

  static available(dom, floorId) {
    return !!(dom && Array.isArray(dom.renders) && dom.renders.find((r) => r.floor === floorId && r.day));
  }

  setDom(dom) { this.dom = dom; if (this.floorId) this.setFloor(this.floorId); }

  show(on) {
    this.el.classList.toggle("on", !!on);
    for (const ch of this.container.children) if (ch.classList && ch.classList.contains("d3-wrap")) ch.style.visibility = on ? "hidden" : "";
    if (on) this._layout();
  }

  setFloor(id) {
    this.floorId = id;
    const R = (this.dom.renders || []).find((r) => r.floor === id);
    this.R = R;
    this.stage.innerHTML = "";
    this.layers = [];
    this.hots = [];
    if (!R) return;
    const img = (file, cls) => {
      const i = document.createElement("img");
      i.src = this.opts.fileUrl(file);
      i.className = cls;
      i.draggable = false;
      this.stage.appendChild(i);
      return i;
    };
    this.dayImg = img(R.day, "d");
    this.nightImg = R.night ? img(R.night, "n") : null;
    if (this.dayImg) this.dayImg.onload = () => { this.imgW = this.dayImg.naturalWidth; this.imgH = this.dayImg.naturalHeight; this._layout(); };
    for (const L of R.lights || []) {
      const def = (this.dom.lights || []).find((l) => l.id === L.light);
      const i = img(L.file, "l");
      i.style.opacity = 0;
      this.layers.push({ def, img: i });
      if (def && def.entity && this.opts.hotspots) {
        const h = document.createElement("div");
        h.className = "rv-hot";
        const [x0, x1, y0, y1] = R.bounds;
        h.style.left = ((def.x - x0) / (x1 - x0)) * 100 + "%";
        h.style.top = ((y1 - def.y) / (y1 - y0)) * 100 + "%";
        h.innerHTML = `<span class="rv-tip"></span>`;
        h.onclick = (e) => { e.stopPropagation(); this.opts.onClick && this.opts.onClick({ kind: "light", id: def.id, entity: def.entity }); };
        this.stage.appendChild(h);
        this.hots.push({ def, el: h });
      }
    }
    this.apply();
  }

  setStates(states) { this.states = states || {}; this.apply(); }

  _night() {
    const s = this.states["sun.sun"];
    let el;
    if (s && s.attributes && s.attributes.elevation != null) el = +s.attributes.elevation;
    else el = sunPosition(new Date(), this.dom.lat || 52.4, this.dom.lon || 16.9).el;
    const t = Math.min(1, Math.max(0, (el - -5) / (6 - -5)));
    return 1 - t * t * (3 - 2 * t);
  }

  _applyDayNight() {
    if (!this.R) return 0;
    const n = this._night();
    if (this.nightImg) this.nightImg.style.opacity = n;
    return n;
  }

  apply() {
    if (!this.R) return;
    const night = this._applyDayNight();
    for (const L of this.layers) {
      let on = false, level = 1;
      const d = L.def;
      if (d && d.entity) {
        const ls = lightState(this.states[d.entity]);
        if (ls) { on = ls.on; level = ls.level; }
      }
      L.img.style.opacity = on ? Math.min(1, level * (0.35 + 0.65 * night)) : 0;
    }
    for (const h of this.hots) {
      const st = this.states[h.def.entity];
      const ls = lightState(st);
      h.el.classList.toggle("on", !!(ls && ls.on));
      h.el.querySelector(".rv-tip").textContent = h.def.entity ? `${h.def.name || ""} · ${st ? st.state : "?"}` : `${h.def.name || ""} (bez encji)`;
      h.el.style.display = this.opts.hotspots ? "" : "none";
    }
  }

  _layout() {
    if (!this.R || !this.imgW) return;
    const r = this.container.getBoundingClientRect();
    const k = Math.min(r.width / this.imgW, r.height / this.imgH) * this.zoom;
    const w = this.imgW * k, h = this.imgH * k;
    this.stage.style.width = w + "px";
    this.stage.style.height = h + "px";
    this.stage.style.left = (r.width - w) / 2 + this.panX + "px";
    this.stage.style.top = (r.height - h) / 2 + this.panY + "px";
  }

  _bindGestures() {
    let drag = null;
    this.el.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY }; this.el.setPointerCapture(e.pointerId); });
    this.el.addEventListener("pointermove", (e) => { if (!drag) return; this.panX = drag.px + e.clientX - drag.x; this.panY = drag.py + e.clientY - drag.y; this._layout(); });
    this.el.addEventListener("pointerup", () => (drag = null));
    this.el.addEventListener("wheel", (e) => { e.preventDefault(); this.zoom = Math.min(6, Math.max(1, this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); if (this.zoom === 1) { this.panX = this.panY = 0; } this._layout(); }, { passive: false });
    this.el.addEventListener("dblclick", () => { this.zoom = 1; this.panX = this.panY = 0; this._layout(); });
  }

  dispose() { clearInterval(this._sunTimer); this.ro.disconnect(); this.el.remove(); }
}
