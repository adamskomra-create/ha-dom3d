import { Dom3DViewer, escapeHtml } from "./viewer.js";
import { Editor, findAny } from "./editor.js";
import {
  FURN, LIGHT_KINDS, SENSOR_KINDS, FLOOR_FINISH, normalize, uid, wallLen, polyArea, round, friendly,
} from "./model.js";

const $ = (s, el = document) => el.querySelector(s);
const api = (p) => new URL(p, location.href).toString();

// ------------------------------------------------------------ store
const store = {
  dom: null,
  sel: null,
  selKind: null,
  selWall: null,
  undoStack: [],
  redoStack: [],
  dirty: false,
  files: [],
  states: {},
  areas: [],
  snapshot() { return JSON.stringify(this.dom); },
  commit(fn, opts = {}) {
    const before = opts.snapshot || (opts.history === false ? null : this.snapshot());
    if (fn) fn(this.dom);
    if (before) { this.undoStack.push(before); if (this.undoStack.length > 150) this.undoStack.shift(); this.redoStack = []; }
    this.setDirty(true);
    if (opts.rebuild === "throttle") scheduleBuild();
    else if (opts.rebuild !== false) { viewer.setDom(this.dom); refreshProps(); }
  },
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.dom = normalize(JSON.parse(this.undoStack.pop()));
    viewer.setDom(this.dom); this.setDirty(true); refreshProps(); editor.refreshHandles();
  },
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.dom = normalize(JSON.parse(this.redoStack.pop()));
    viewer.setDom(this.dom); this.setDirty(true); refreshProps(); editor.refreshHandles();
  },
  select(id, kind, wall) {
    this.sel = id; this.selKind = kind || null; this.selWall = wall || null;
    viewer.setSelected(id);
    refreshProps();
    editor && editor.refreshHandles();
  },
  setDirty(d) {
    this.dirty = d;
    $("#save").classList.toggle("dirty", d);
    $("#save").textContent = d ? "Zapisz *" : "Zapisane";
  },
  async save() {
    const r = await fetch(api("api/dom"), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.dom) });
    if (!r.ok) { status("Błąd zapisu: " + (await r.text())); return; }
    const j = await r.json();
    this.setDirty(false);
    publishUrl = j.publish;
    status(`Zapisano ${j.saved}. Karta czyta z ${j.publish || "(brak publikacji)"}`);
  },
};

let buildTimer = null;
function scheduleBuild() {
  if (buildTimer) return;
  buildTimer = setTimeout(() => { buildTimer = null; viewer.setDom(store.dom); refreshProps(true); }, 40);
}

let viewer, editor, publishUrl = null, ws;

function status(t) { $("#status").textContent = t; }

// ------------------------------------------------------------ HA websocket (przez serwer dodatku)
let wsSeq = 1;
const wsWait = new Map();
function connectWS() {
  const u = new URL("api/ws", location.href);
  u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(u);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "hello") $("#ha").className = m.ha ? "ok" : "bad";
    if (m.type === "states") {
      store.states = Object.fromEntries(m.states.map((s) => [s.entity_id, s]));
      viewer.setStates(store.states);
      fillDatalists();
      if (m.states.length) { $("#ha").className = "ok"; loadAreas(); }
      refreshProps();
    } else if (m.type === "state") {
      if (m.state) store.states[m.entity_id] = m.state; else delete store.states[m.entity_id];
      viewer.updateState(m.entity_id, m.state);
    } else if (m.type === "ws_result" && wsWait.has(m.id)) {
      wsWait.get(m.id)(m);
      wsWait.delete(m.id);
    }
  };
  ws.onclose = () => { $("#ha").className = "bad"; setTimeout(connectWS, 3000); };
}

function haCall(msg) {
  return new Promise((res) => {
    const id = wsSeq++;
    wsWait.set(id, res);
    ws.send(JSON.stringify({ type: "ws", id, msg }));
    setTimeout(() => { if (wsWait.has(id)) { wsWait.delete(id); res({ success: false }); } }, 15000);
  });
}

async function loadAreas() {
  const r = await haCall({ type: "config/area_registry/list" });
  if (r.success) store.areas = r.result || [];
}

function toggleEntity(eid) {
  if (!eid) return;
  const dom = eid.split(".")[0];
  const svc = ["light", "switch", "input_boolean", "fan", "cover", "media_player"].includes(dom) ? dom : "homeassistant";
  haCall({ type: "call_service", domain: svc, service: "toggle", service_data: { entity_id: eid } });
}

function fillDatalists() {
  const by = {};
  for (const eid of Object.keys(store.states).sort()) {
    const d = eid.split(".")[0];
    (by[d] ||= []).push(eid);
  }
  const mk = (id, domains) => {
    let dl = document.getElementById(id);
    if (!dl) { dl = document.createElement("datalist"); dl.id = id; document.body.appendChild(dl); }
    dl.innerHTML = domains.flatMap((d) => by[d] || []).map((e) => `<option value="${e}">${escapeHtml(friendly(store.states[e], e))}</option>`).join("");
  };
  mk("dl-light", ["light", "switch", "input_boolean"]);
  mk("dl-binary", ["binary_sensor", "input_boolean", "cover", "lock"]);
  mk("dl-sensor", ["sensor"]);
  mk("dl-any", Object.keys(by));
}

// ------------------------------------------------------------ UI
const TOOLS = [
  ["view", "👆", "Podgląd (V)"], ["select", "⬚", "Zaznacz / przesuń (S)"], ["wall", "▭", "Ściana (W)"],
  ["room", "▦", "Pokój (P)"], ["window", "⊞", "Okno (O)"], ["door", "◫", "Drzwi (D)"], ["passage", "⊓", "Przejście"],
  ["stairs", "☰", "Schody"], ["item", "🛋", "Mebel (M)"], ["light", "💡", "Lampa (L)"], ["sensor", "◉", "Czujka (C)"],
  ["model", "📦", "Model .glb"],
];

function setTool(t) {
  editor.setTool(t);
  document.querySelectorAll("#tools button").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  renderToolOpts();
}

function renderToolOpts() {
  const t = editor.tool;
  const el = $("#toolopts");
  const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${v.name}</option>`).join("");
  let h = "";
  if (t === "wall") h = `Grubość <input id="o-t" type="number" step="0.01" value="${editor.wallT}"> m  Siatka <input id="o-g" type="number" step="0.01" value="${editor.grid}"> m`;
  if (t === "item") h = `Mebel <select id="o-f">${opt(FURN, editor.furnType)}</select>`;
  if (t === "light") h = `Rodzaj <select id="o-l">${opt(LIGHT_KINDS, editor.lightKind)}</select>`;
  if (t === "sensor") h = `Rodzaj <select id="o-s">${opt(SENSOR_KINDS, editor.sensorKind)}</select>`;
  if (t === "stairs") h = `Wejście w kierunku <select id="o-sd">${["x+", "x-", "y+", "y-"].map((d) => `<option ${d === editor.stairDir ? "selected" : ""}>${d}</option>`).join("")}</select>`;
  if (t === "model") h = `Plik <select id="o-m"><option value="">-</option>${store.files.filter((f) => /\.glb$/i.test(f.name)).map((f) => `<option ${f.name === editor.modelFile ? "selected" : ""}>${f.name}</option>`).join("")}</select> <button id="o-up">Wgraj .glb</button>`;
  el.innerHTML = h;
  const on = (id, fn) => { const x = $(id); if (x) x.onchange = (e) => fn(e.target.value); };
  on("#o-t", (v) => (editor.wallT = +v || 0.12));
  on("#o-g", (v) => (editor.grid = +v || 0.05));
  on("#o-f", (v) => (editor.furnType = v));
  on("#o-l", (v) => (editor.lightKind = v));
  on("#o-s", (v) => (editor.sensorKind = v));
  on("#o-sd", (v) => (editor.stairDir = v));
  on("#o-m", (v) => (editor.modelFile = v));
  const up = $("#o-up");
  if (up) up.onclick = () => uploadFile(".glb", (n) => { editor.modelFile = n; renderToolOpts(); });
}

function renderFloors() {
  const s = $("#floor");
  s.innerHTML = store.dom.floors.map((f) => `<option value="${f.id}" ${f.id === viewer.floorId ? "selected" : ""}>${escapeHtml(f.name)}</option>`).join("");
}

// ------------------------------------------------------------ formularz właściwości
const FIELDS = {
  floor: [["name", "Nazwa"], ["level", "Poziom", "int"], ["elev", "Rzędna podłogi (m)", "num"], ["height", "Wysokość w świetle (m)", "num"], ["slab", "Grubość stropu (m)", "num"]],
  wall: [["name", "Nazwa"], ["t", "Grubość", "num"], ["h", "Wysokość (puste = piętro)", "num"], ["_len", "Długość", "num"], ["x1", "x1", "num"], ["y1", "y1", "num"], ["x2", "x2", "num"], ["y2", "y2", "num"], ["color", "Kolor", "color"]],
  opening: [["name", "Nazwa"], ["type", "Typ", ["window:Okno", "door:Drzwi", "passage:Przejście"]], ["offset", "Od początku ściany", "num"], ["width", "Szerokość", "num"], ["height", "Wysokość", "num"], ["sill", "Parapet / próg", "num"], ["hinge", "Zawiasy", ["L:Lewe", "R:Prawe"]], ["side", "Otwiera się na stronę", ["1:A", "-1:B"]], ["entity", "Kontaktron (encja)", "ent:dl-binary"]],
  room: [["name", "Nazwa"], ["finish", "Podłoga", Object.entries(FLOOR_FINISH).map(([k, v]) => `${k}:${v.name}`)], ["color", "Kolor podłogi (nadpisuje)", "color"], ["area_id", "Obszar HA", "area"], ["temp_entity", "Temperatura", "ent:dl-sensor"], ["hum_entity", "Wilgotność", "ent:dl-sensor"], ["label", "Etykieta", "bool"], ["_poly", "Obrys [[x,y],...]", "json"]],
  item: [["name", "Nazwa"], ["model", "Model (IKEA / JYSK)"], ["url", "Link do produktu"], ["type", "Rodzaj", Object.entries(FURN).map(([k, v]) => `${k}:${v.name}`)], ["w", "Szerokość", "num"], ["d", "Głębokość", "num"], ["h", "Wysokość", "num"], ["x", "x", "num"], ["y", "y", "num"], ["z", "Nad podłogą", "num"], ["rot", "Obrót (°)", "num"], ["color", "Kolor", "color"], ["glb", "Model 3D (.glb)", "file"], ["fit", "Dopasowanie modelu", ["contain:Proporcjonalnie", "stretch:Rozciągnij"]]],
  light: [["name", "Nazwa"], ["entity", "Encja", "ent:dl-light"], ["kind", "Rodzaj", Object.entries(LIGHT_KINDS).map(([k, v]) => `${k}:${v.name}`)], ["lm", "Strumień (lm)", "num"], ["kelvin", "Barwa (K) gdy brak w encji", "num"], ["x", "x", "num"], ["y", "y", "num"], ["z", "Wysokość (puste = domyślna, ujemna = pod sufitem)", "num"], ["size", "Promień oprawy", "num"], ["len", "Długość LED", "num"], ["rot", "Obrót (°)", "num"], ["shadow", "Rzuca cienie (wolniej)", "bool"], ["preview", "Świeci bez encji (podgląd)", "bool"]],
  sensor: [["name", "Nazwa"], ["entity", "Encja", "ent:dl-any"], ["kind", "Rodzaj", Object.entries(SENSOR_KINDS).map(([k, v]) => `${k}:${v.name}`)], ["x", "x", "num"], ["y", "y", "num"], ["z", "Wysokość (puste = domyślna)", "num"], ["showValue", "Pokaż wartość", "bool"]],
  model: [["name", "Nazwa"], ["file", "Plik .glb", "file"], ["x", "x", "num"], ["y", "y", "num"], ["z", "z", "num"], ["rot", "Obrót (°)", "num"], ["scale", "Skala", "num"], ["mirror", "Lustrzane odbicie", "bool"], ["keepLights", "Zachowaj światła z modelu", "bool"], ["emissive", "Świecące materiały z modelu", "bool"], ["_hide", "Ukryj obiekty (prefiksy, po przecinku)"]],
  stairs: [["name", "Nazwa"], ["dir", "Kierunek wejścia", ["x+:x+", "x-:x-", "y+:y+", "y-:y-"]], ["steps", "Stopnie", "int"], ["z0", "Start (m nad podłogą)", "num"], ["z1", "Koniec (m nad podłogą)", "num"], ["x0", "x0", "num"], ["y0", "y0", "num"], ["x1", "x1", "num"], ["y1", "y1", "num"]],
  background: [["file", "Obraz", "file"], ["x", "x", "num"], ["y", "y", "num"], ["width", "Szerokość (m)", "num"], ["rot", "Obrót (°)", "num"], ["opacity", "Krycie", "num"]],
  house: [["name", "Nazwa domu"], ["north", "Północ: kąt od osi +y planu (°, zgodnie z zegarem)", "num"], ["lat", "Szerokość geogr.", "num"], ["lon", "Długość geogr.", "num"]],
};

function getObj() {
  if (!store.sel) return { kind: "house", obj: store.dom };
  const o = findAny(store.dom, store.sel);
  if (!o) return { kind: "house", obj: store.dom };
  let kind = store.selKind;
  if (!kind) kind = o.openings ? "wall" : o.poly ? "room" : "item";
  return { kind, obj: o };
}

let lastPropsKey = null;
function refreshProps(light = false) {
  const { kind, obj } = getObj();
  const key = kind + ":" + (obj.id || "dom");
  const el = $("#props");
  if (light && key === lastPropsKey && el.contains(document.activeElement)) {
    // podczas przeciągania odśwież tylko wartości liczbowe
    el.querySelectorAll("[data-k]").forEach((inp) => {
      if (inp === document.activeElement) return;
      const v = readVal(obj, inp.dataset.k);
      if (inp.type === "checkbox") inp.checked = !!v; else inp.value = v ?? "";
    });
    return;
  }
  lastPropsKey = key;
  const titles = { house: "Dom", floor: "Piętro", wall: "Ściana", opening: "Otwór", room: "Pokój", item: "Mebel", light: "Lampa", sensor: "Czujka", model: "Model", stairs: "Schody", background: "Podkład" };
  let h = `<h3>${titles[kind] || kind}</h3>`;
  for (const [k, label, type] of FIELDS[kind] || []) h += field(obj, k, label, type);
  if (kind === "wall") {
    h += `<div class="sub">Otwory: ${obj.openings.length}</div><div class="row">` +
      obj.openings.map((o) => `<button data-op="${o.id}">${o.type === "window" ? "Okno" : o.type === "door" ? "Drzwi" : "Przejście"} ${o.width}×${o.height}</button>`).join("") + "</div>";
    h += `<div class="row"><button data-act="split">Podziel w połowie</button><button data-act="flip">Odwróć kierunek</button></div>`;
  }
  if (kind === "room") h += `<div class="sub">Powierzchnia: ${polyArea(obj.poly).toFixed(2)} m²</div>`;
  if (kind === "light" || kind === "sensor") {
    const st = store.states[obj.entity];
    h += `<div class="sub">${obj.entity ? (st ? `${escapeHtml(friendly(st, obj.entity))}: <b>${escapeHtml(st.state)}</b>` : "encja nie istnieje w HA") : "brak encji"}</div>`;
    if (kind === "light" && obj.entity) h += `<div class="row"><button data-act="toggle">Przełącz</button></div>`;
  }
  if (kind === "background") h += `<div class="row"><button data-act="calib">Kalibruj (2 punkty)</button></div>`;
  if (kind === "house") {
    const f = viewer.floor();
    h += `<h3>Piętro: ${escapeHtml(f.name)}</h3>`;
    for (const [k, label, type] of FIELDS.floor) h += field(f, k, label, type, "floor");
    h += `<div class="row"><button data-act="addbg">Podkład z rzutu…</button><button data-act="delfloor">Usuń piętro</button></div>`;
    h += objectList(f.id);
    h += `<h3>Karta na dashboard</h3><div class="sub">Zasób (Ustawienia → Panele → Zasoby): <code>/local/dom3d/dom3d-card.js</code> (moduł JavaScript)</div>`;
    h += `<pre class="code">type: custom:dom3d-card\ndata: ${publishUrl || "/local/dom3d/<zapisz najpierw>/"}\nfloor: ${f.id}\nview: top\nheight: 520px</pre>`;
  }
  if (kind !== "house") h += `<div class="row"><button data-act="dup">Duplikuj</button><button data-act="del" class="danger">Usuń</button><button data-act="desel">Odznacz</button></div>`;
  el.innerHTML = h;
  el.querySelectorAll("[data-k]").forEach((inp) => {
    const ev = inp.tagName === "SELECT" || inp.type === "checkbox" || inp.type === "color" ? "change" : "change";
    inp.addEventListener(ev, () => onField(inp));
  });
  el.querySelectorAll("[data-op]").forEach((b) => (b.onclick = () => store.select(b.dataset.op, "opening", obj.id)));
  el.querySelectorAll("[data-sel]").forEach((b) => (b.onclick = () => store.select(b.dataset.sel, b.dataset.kind)));
  el.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => onAct(b.dataset.act, kind, obj)));
  el.querySelectorAll("[data-up]").forEach((b) => (b.onclick = () => uploadFile(b.dataset.up, () => refreshProps())));
}

function objectList(fid) {
  const d = store.dom;
  const groups = [["Pokoje", "rooms", "room"], ["Lampy", "lights", "light"], ["Czujki", "sensors", "sensor"], ["Meble", "items", "item"], ["Modele", "models", "model"], ["Schody", "stairs", "stairs"], ["Podkłady", "backgrounds", "background"]];
  let h = "";
  for (const [title, coll, kind] of groups) {
    const list = d[coll].filter((o) => o.floor === fid);
    if (!list.length) continue;
    h += `<details ${coll === "lights" || coll === "rooms" ? "open" : ""}><summary>${title} (${list.length})</summary>` +
      list.map((o) => `<button class="li" data-sel="${o.id}" data-kind="${kind}">${escapeHtml(o.name || o.file || kind)}${o.entity ? ` <small>${escapeHtml(o.entity)}</small>` : ""}</button>`).join("") + "</details>";
  }
  return h;
}

function readVal(obj, k) {
  if (k === "_len") return round(wallLen(obj), 3);
  if (k === "_poly") return JSON.stringify(obj.poly);
  if (k === "_hide") return (obj.hide || []).join(", ");
  return obj[k];
}

function field(obj, k, label, type, scope = "") {
  const v = readVal(obj, k);
  const attrs = `data-k="${k}" data-scope="${scope}"`;
  let inp;
  if (Array.isArray(type)) {
    inp = `<select ${attrs}><option value=""></option>${type.map((o) => { const [val, lab] = o.split(":"); return `<option value="${val}" ${String(v) === val ? "selected" : ""}>${escapeHtml(lab)}</option>`; }).join("")}</select>`;
  } else if (type === "num" || type === "int") inp = `<input ${attrs} type="number" step="${type === "int" ? 1 : 0.01}" value="${v ?? ""}">`;
  else if (type === "bool") inp = `<input ${attrs} type="checkbox" ${v || (k === "label" && v === undefined) ? "checked" : ""}>`;
  else if (type === "color") inp = `<input ${attrs} type="color" value="${typeof v === "string" && v.startsWith("#") ? v : "#cccccc"}"><button class="mini" data-act="clr-${k}">×</button>`;
  else if (type && type.startsWith("ent:")) inp = `<input ${attrs} list="${type.slice(4)}" value="${escapeHtml(v || "")}" placeholder="np. light.salon">`;
  else if (type === "area") inp = `<select ${attrs}><option value=""></option>${store.areas.map((a) => `<option value="${a.area_id}" ${a.area_id === v ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}</select>`;
  else if (type === "file") inp = `<select ${attrs}><option value=""></option>${store.files.map((f) => `<option ${f.name === v ? "selected" : ""}>${f.name}</option>`).join("")}</select><button class="mini" data-up="*">↑</button>`;
  else if (type === "json") inp = `<textarea ${attrs} rows="3">${escapeHtml(v || "")}</textarea>`;
  else inp = `<input ${attrs} value="${escapeHtml(v ?? "")}">`;
  return `<label><span>${label}</span>${inp}</label>`;
}

function onField(inp) {
  const k = inp.dataset.k;
  const scope = inp.dataset.scope;
  let val;
  if (inp.type === "checkbox") val = inp.checked;
  else if (inp.type === "number") val = inp.value === "" ? undefined : +inp.value;
  else val = inp.value;
  const { kind, obj: o0 } = getObj();
  store.commit(() => {
    const obj = scope === "floor" ? viewer.floor() : o0;
    if (k === "_len" && kind === "wall") {
      const L = wallLen(obj) || 1;
      obj.x2 = round(obj.x1 + ((obj.x2 - obj.x1) / L) * val);
      obj.y2 = round(obj.y1 + ((obj.y2 - obj.y1) / L) * val);
    } else if (k === "_poly") {
      try { obj.poly = JSON.parse(val); } catch { status("Niepoprawny obrys"); }
    } else if (k === "_hide") {
      obj.hide = val.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (k === "side") obj.side = +val;
    else if (val === undefined || val === "") delete obj[k];
    else obj[k] = val;
  });
  if (scope === "floor" || kind === "floor") renderFloors();
}

function onAct(act, kind, obj) {
  if (act === "del") editor.deleteSelected();
  else if (act === "dup") editor.duplicate();
  else if (act === "desel") store.select(null);
  else if (act === "toggle") toggleEntity(obj.entity);
  else if (act === "calib") { viewer.showBackgrounds = true; viewer._applyVisibility(); $("#bgtoggle").checked = true; editor.setTool("calib"); }
  else if (act.startsWith("clr-")) store.commit(() => delete obj[act.slice(4)]);
  else if (act === "split") {
    store.commit((dom) => {
      const mx = round((obj.x1 + obj.x2) / 2), my = round((obj.y1 + obj.y2) / 2);
      const L = wallLen(obj) / 2;
      const b = { ...JSON.parse(JSON.stringify(obj)), id: uid("w"), x1: mx, y1: my };
      b.openings = obj.openings.filter((o) => o.offset >= L).map((o) => ({ ...o, offset: round(o.offset - L) }));
      obj.openings = obj.openings.filter((o) => o.offset < L);
      obj.x2 = mx; obj.y2 = my;
      dom.walls.push(b);
    });
  } else if (act === "flip") {
    store.commit(() => {
      const L = wallLen(obj);
      [obj.x1, obj.y1, obj.x2, obj.y2] = [obj.x2, obj.y2, obj.x1, obj.y1];
      for (const o of obj.openings) o.offset = round(L - o.offset - o.width);
    });
  } else if (act === "addbg") {
    uploadFile("image/*", (name) => {
      const width = parseFloat((prompt("Ile metrów ma szerokość tego obrazka? (możesz potem skalibrować)", "15") || "15").replace(",", "."));
      const bg = { id: uid("b"), floor: viewer.floorId, file: name, x: 0, y: 0, width, opacity: 0.6 };
      store.commit((dom) => dom.backgrounds.push(bg));
      viewer.showBackgrounds = true; viewer._applyVisibility(); $("#bgtoggle").checked = true;
      store.select(bg.id, "background");
    });
  } else if (act === "delfloor") {
    const f = viewer.floor();
    if (store.dom.floors.length < 2) return;
    if (!confirm(`Usunąć piętro "${f.name}" razem z całą zawartością?`)) return;
    store.commit((dom) => {
      dom.floors = dom.floors.filter((x) => x.id !== f.id);
      for (const k of ["walls", "rooms", "items", "lights", "sensors", "models", "stairs", "backgrounds"]) dom[k] = dom[k].filter((o) => o.floor !== f.id);
    });
    viewer.setFloor(store.dom.floors[0].id);
    renderFloors();
  }
}

async function loadFiles() {
  try { store.files = await (await fetch(api("api/files"))).json(); } catch { store.files = []; }
}

let uploadDone = null;
async function uploadSelected(f) {
  if (!f) return;
  if (/\.json$/i.test(f.name)) { importJson(await f.text()); return; }
  status(`Wgrywam ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`);
  const fd = new FormData();
  fd.append("file", f, f.name);
  const r = await fetch(api("api/files"), { method: "POST", body: fd });
  if (!r.ok) { status("Błąd: " + (await r.text())); return; }
  const j = await r.json();
  await loadFiles();
  status("Wgrano " + j.files.join(", "));
  const cb = uploadDone; uploadDone = null;
  if (cb) cb(j.files[0]); else { viewer.setDom(store.dom); renderToolOpts(); refreshProps(); }
}

function uploadFile(accept, done) {
  const inp = $("#fileinput");
  inp.accept = accept === "*" ? ".glb,.gltf,image/*" : accept;
  uploadDone = done || null;
  inp.value = "";
  inp.click();
}

function importJson(text) {
  try {
    const d = normalize(JSON.parse(text));
    store.commit(() => { store.dom = d; }, { rebuild: false });
    viewer.setDom(store.dom, false);
    viewer.setFloor(store.dom.floors[store.dom.floors.length - 1].id);
    renderFloors(); refreshProps();
    status("Zaimportowano. Kliknij Zapisz, żeby zachować.");
  } catch (e) { status("Błąd importu: " + e.message); }
}

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
}

// ------------------------------------------------------------ start
async function main() {
  const dom = normalize(await (await fetch(api("api/dom"))).json());
  store.dom = dom;
  await loadFiles();
  try { publishUrl = (await (await fetch(api("api/info"))).json()).publish; } catch { /* */ }
  viewer = new Dom3DViewer($("#view"), {
    dom, fileUrl: (n) => api("files/" + encodeURIComponent(n)),
    onClick: (hit) => {
      if (editor.tool !== "view") return;
      if (hit.kind === "light") toggleEntity(hit.entity);
      else if (hit.entity) { const st = store.states[hit.entity]; status(`${friendly(st, hit.entity)}: ${st ? st.state : "?"}`); }
    },
  });
  window.dom3d = { viewer, store };
  editor = new Editor(viewer, store, { status, setTool: (t) => setTool(t) });
  window.dom3d.editor = editor;

  $("#tools").innerHTML = TOOLS.map(([id, ico, title]) => `<button data-tool="${id}" title="${title}"><span>${ico}</span><small>${title.replace(/ \(.\)$/, "")}</small></button>`).join("");
  $("#tools").onclick = (e) => { const b = e.target.closest("button"); if (b) setTool(b.dataset.tool); };
  renderFloors();
  $("#floor").onchange = (e) => { viewer.setFloor(e.target.value); store.select(null); };
  $("#addfloor").onclick = () => {
    const top = store.dom.floors[store.dom.floors.length - 1];
    const name = prompt("Nazwa piętra", "Nowe piętro");
    if (!name) return;
    const f = { id: uid("f"), name, level: top.level + 1, elev: round(top.elev + top.height + (top.slab ?? 0.22) + 0.05), height: top.height };
    store.commit((dom) => dom.floors.push(f));
    viewer.setFloor(f.id);
    renderFloors();
  };
  $("#mode").onclick = () => {
    const m = viewer.mode === "top" ? "3d" : "top";
    viewer.setMode(m);
    $("#mode").textContent = m === "top" ? "Widok 3D" : "Widok z góry";
    editor.refreshHandles();
  };
  $("#fit").onclick = () => viewer.fit();
  const tsl = $("#time");
  const tlabel = () => {
    if (+tsl.value < 0) { $("#tval").textContent = "na żywo"; viewer.setTime(null); return; }
    const d = new Date(); d.setHours(0, +tsl.value, 0, 0);
    $("#tval").textContent = d.toTimeString().slice(0, 5);
    viewer.setTime(d);
  };
  tsl.oninput = tlabel;
  viewer.editLight = true;
  viewer.applyStates();
  $("#lighttoggle").onchange = (e) => { viewer.editLight = e.target.checked; viewer.applyStates(); };
  $("#bgtoggle").onchange = (e) => { viewer.showBackgrounds = e.target.checked; viewer._applyVisibility(); };
  $("#undo").onclick = () => store.undo();
  $("#redo").onclick = () => store.redo();
  $("#save").onclick = () => store.save();
  $("#exp").onclick = () => download("dom.json", JSON.stringify(store.dom, null, 1));
  $("#imp").onclick = () => uploadFile(".json,application/json");
  $("#fileinput").onchange = (e) => uploadSelected(e.target.files[0]);
  window.addEventListener("beforeunload", (e) => { if (store.dirty) { e.preventDefault(); e.returnValue = ""; } });
  setTool("select");
  store.setDirty(false);
  refreshProps();
  connectWS();
}

main().catch((e) => { document.body.innerHTML = `<pre style="color:#fff;padding:20px">Błąd startu: ${escapeHtml(e.stack || e)}</pre>`; });
