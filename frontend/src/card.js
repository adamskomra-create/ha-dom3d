import { Dom3DViewer } from "./viewer.js";
import { RenderView } from "./renderview.js";
import { normalize } from "./model.js";

const VERSION = "0.2.4";

class Dom3DCard extends HTMLElement {
  setConfig(config) {
    if (!config || !config.data) throw new Error("Podaj 'data:' - adres z panelu Dom 3D, np. /local/dom3d/abcd1234/");
    this._config = { view: "top", height: "520px", floors: true, labels: true, quality: "high", rotate: 0, ...config };
    if (!this._config.data.endsWith("/")) this._config.data += "/";
    if (this._built) this._rebuild();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._built) this._build();
    if (this.viewer && (first || hass.states !== this._lastStates)) {
      this._lastStates = hass.states;
      this.viewer.setStates(hass.states);
      if (this.rv) this.rv.setStates(hass.states);
    }
  }

  getCardSize() { return 6; }

  static getStubConfig() { return { data: "/local/dom3d/WPISZ_Z_PANELU/", view: "top", height: "520px" }; }

  connectedCallback() {
    if (this._hass && !this._built) this._build();
    if (this.viewer) this.viewer.resize();
  }

  disconnectedCallback() {
    // zostawiamy viewer - HA odłącza karty przy przełączaniu widoków
  }

  async _build() {
    if (this._building) return;
    this._building = true;
    const c = this._config;
    const root = this.shadowRoot || this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        ha-card{overflow:hidden;position:relative}
        .bar{position:absolute;top:8px;left:8px;right:8px;display:flex;gap:6px;z-index:3;flex-wrap:wrap;pointer-events:none}
        .bar button{pointer-events:auto;border:0;border-radius:999px;padding:6px 12px;font:600 12px system-ui,sans-serif;
          background:rgba(255,255,255,.85);color:#111;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.2)}
        .bar button.on{background:#2563eb;color:#fff}
        .bar .sp{flex:1}
        #v{height:${c.height};width:100%;position:relative}
        .err{padding:16px;color:var(--error-color,#c00)}
      </style>
      <ha-card><div class="bar"></div><div id="v"></div></ha-card>`;
    let dom;
    try {
      const r = await fetch(c.data + "dom.json", { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status + " " + r.statusText);
      dom = normalize(await r.json());
    } catch (e) {
      root.querySelector("#v").innerHTML = `<div class="err">Dom 3D: nie mogę wczytać ${c.data}dom.json (${e.message}). Zapisz projekt w panelu Dom 3D i sprawdź adres.</div>`;
      this._building = false;
      return;
    }
    this._dom = dom;
    const v = root.querySelector("#v");
    this.viewer = new Dom3DViewer(v, {
      dom, shadowRoot: root, mode: c.view === "3d" ? "3d" : "top", quality: c.quality, labels: c.labels, rotate: c.rotate,
      fileUrl: (n) => c.data + "files/" + encodeURIComponent(n),
      onClick: (hit) => this._click(hit),
    });
    const fl = dom.floors.find((f) => f.id === c.floor || f.name === c.floor);
    if (fl) this.viewer.setFloor(fl.id);
    this.rv = new RenderView(v, { dom, shadowRoot: root, fileUrl: (n) => c.data + "files/" + encodeURIComponent(n), onClick: (hit) => this._click(hit), hotspots: c.hotspots !== false });
    this.rv.setFloor(this.viewer.floorId);
    this.renderMode = c.view === "render" && RenderView.available(dom, this.viewer.floorId);
    this.rv.show(this.renderMode);
    if (this._hass) { this.viewer.setStates(this._hass.states); this.rv.setStates(this._hass.states); }
    this._bar();
    this._built = true;
    this._building = false;
  }

  _rebuild() {
    if (this.viewer) this.viewer.dispose();
    this.viewer = null;
    this._built = false;
    this._build();
  }

  _bar() {
    const bar = this.shadowRoot.querySelector(".bar");
    const c = this._config;
    const fl = this._dom.floors;
    const fid = this.viewer.floorId;
    let h = "";
    if (c.floors && fl.length > 1) h += [...fl].reverse().map((f) => `<button data-f="${f.id}" class="${f.id === fid ? "on" : ""}">${f.short || f.name}</button>`).join("");
    h += `<span class="sp"></span>`;
    const modes = [["top", "2D"], ["3d", "3D"]];
    if (RenderView.available(this._dom, fid)) modes.push(["render", "Render"]);
    const cur = this.renderMode ? "render" : this.viewer.mode;
    h += modes.map(([m, l]) => `<button data-m="${m}" class="${m === cur ? "on" : ""}">${l}</button>`).join("");
    bar.innerHTML = h;
    bar.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => {
      this.viewer.setFloor(b.dataset.f);
      this.rv.setFloor(b.dataset.f);
      if (this.renderMode && !RenderView.available(this._dom, b.dataset.f)) { this.renderMode = false; this.rv.show(false); }
      this._bar();
    }));
    bar.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => {
      const m = b.dataset.m;
      this.renderMode = m === "render";
      this.rv.show(this.renderMode);
      if (!this.renderMode && this.viewer.mode !== m) this.viewer.setMode(m);
      this._bar();
    }));
  }

  _click(hit) {
    const eid = hit.entity;
    if (!eid || !this._hass) {
      if (hit.kind === "room") {
        const r = this._dom.rooms.find((x) => x.id === hit.id);
        if (r && r.temp_entity) this._more(r.temp_entity);
      }
      return;
    }
    const domain = eid.split(".")[0];
    if (hit.kind === "light" && ["light", "switch", "input_boolean", "fan"].includes(domain)) {
      this._hass.callService(domain, "toggle", { entity_id: eid });
    } else {
      this._more(eid);
    }
  }

  _more(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
  }
}

if (!customElements.get("dom3d-card")) {
  customElements.define("dom3d-card", Dom3DCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "dom3d-card", name: "Dom 3D", description: "Interaktywny plan domu 3D ze światłem z encji", preview: false });
  console.info(`%c DOM3D-CARD %c ${VERSION} `, "background:#2563eb;color:#fff;border-radius:3px 0 0 3px", "background:#111;color:#fff;border-radius:0 3px 3px 0");
}
