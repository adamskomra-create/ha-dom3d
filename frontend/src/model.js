// Model danych domu (dom.json) + presety. Jednostki: metry, kąty: stopnie.
// Układ planu: x w prawo, y "w górę rzutu". Three.js: X = x, Z = -y, Y = wysokość.

export const FURN = {
  LOZKO_2: { name: "Łóżko 160", w: 1.66, d: 2.10, h: 0.45, color: "#d9d2c5" },
  LOZKO_1: { name: "Łóżko 90", w: 0.96, d: 2.06, h: 0.45, color: "#d9d2c5" },
  SZAFA: { name: "Szafa", w: 1.00, d: 0.58, h: 2.36, color: "#ecebe7" },
  KOMODA: { name: "Komoda", w: 0.80, d: 0.48, h: 0.78, color: "#d8c3a0" },
  NOCNA: { name: "Szafka nocna", w: 0.40, d: 0.40, h: 0.55, color: "#d8c3a0" },
  BIURKO: { name: "Biurko", w: 1.20, d: 0.60, h: 0.75, color: "#c9b08a" },
  KRZESLO: { name: "Krzesło", w: 0.45, d: 0.50, h: 0.90, color: "#55585e" },
  SOFA: { name: "Sofa", w: 2.20, d: 0.95, h: 0.80, color: "#8c979c" },
  FOTEL: { name: "Fotel", w: 0.80, d: 0.85, h: 0.80, color: "#8c979c" },
  REGAL: { name: "Regał", w: 0.80, d: 0.30, h: 2.00, color: "#eeeeea" },
  STOL: { name: "Stół", w: 1.60, d: 0.90, h: 0.75, color: "#c9b08a" },
  SZAFKA_RTV: { name: "Szafka RTV", w: 1.80, d: 0.40, h: 0.45, color: "#e6e4df" },
  TV: { name: "Telewizor", w: 1.45, d: 0.06, h: 0.85, color: "#1d1f22" },
  DYWAN: { name: "Dywan", w: 1.60, d: 2.30, h: 0.012, color: "#b9b0a2" },
  WANNA: { name: "Wanna", w: 1.70, d: 0.75, h: 0.58, color: "#f7f7f7" },
  PRYSZNIC: { name: "Brodzik", w: 0.90, d: 0.90, h: 0.05, color: "#f2f2f2" },
  UMYWALKA: { name: "Umywalka z szafką", w: 0.80, d: 0.48, h: 0.85, color: "#f7f7f7" },
  WC: { name: "WC", w: 0.36, d: 0.55, h: 0.40, color: "#fbfbfb" },
  PRALKA: { name: "Pralka", w: 0.60, d: 0.60, h: 0.85, color: "#f4f4f4" },
  ROSLINA: { name: "Roślina", w: 0.50, d: 0.50, h: 1.20, color: "#5d8a55" },
  INNY: { name: "Mebel", w: 0.60, d: 0.60, h: 0.60, color: "#cfcfcf" },
};

export const LIGHT_KINDS = {
  SUFIT: { name: "Sufitowa", z: null, lm: 1500 },
  OCZKO: { name: "Oczko / spot", z: null, lm: 450 },
  ZWIS: { name: "Lampa wisząca", z: -0.75, lm: 1200 },
  STOJACA: { name: "Lampa stojąca", z: 1.55, lm: 900 },
  NOCNA: { name: "Lampka nocna", z: 0.65, lm: 250 },
  KINKIET: { name: "Kinkiet", z: 1.80, lm: 500 },
  LED: { name: "Taśma LED", z: 0.10, lm: 600 },
};

export const SENSOR_KINDS = {
  RUCH: { name: "Czujka ruchu", z: null, color: "#ff8c1a", domain: "binary_sensor" },
  KONTAKTRON: { name: "Okno / drzwi", z: 1.2, color: "#1a8cff", domain: "binary_sensor" },
  TEMP: { name: "Temperatura", z: 1.5, color: "#22c55e", domain: "sensor" },
  WILG: { name: "Wilgotność", z: 1.5, color: "#06b6d4", domain: "sensor" },
  DYM: { name: "Dym / CO", z: null, color: "#ef4444", domain: "binary_sensor" },
  ZALANIE: { name: "Zalanie", z: 0.02, color: "#3b82f6", domain: "binary_sensor" },
  PRZYCISK: { name: "Przycisk / włącznik", z: 1.1, color: "#a855f7", domain: "" },
  GNIAZDKO: { name: "Gniazdko smart", z: 0.3, color: "#eab308", domain: "switch" },
  KAMERA: { name: "Kamera", z: 2.3, color: "#64748b", domain: "camera" },
  MEDIA: { name: "Głośnik / TV", z: 1.0, color: "#ec4899", domain: "media_player" },
  INNY: { name: "Inny", z: 1.0, color: "#94a3b8", domain: "" },
};

export const FLOOR_FINISH = {
  DREWNO: { name: "Drewno", color: "#c9a57c" },
  DAB_JASNY: { name: "Dąb jasny", color: "#d8bf9a" },
  PLYTKI_JASNE: { name: "Płytki jasne", color: "#dedad3" },
  PLYTKI_SZARE: { name: "Płytki szare", color: "#9a9b9d" },
  BETON: { name: "Beton", color: "#b4b2ad" },
  WYKLADZINA: { name: "Wykładzina", color: "#b8afa5" },
};

let _n = 0;
export function uid(prefix = "o") {
  _n = (_n + 1) % 1e6;
  return prefix + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5) + _n;
}

export function emptyDom() {
  return {
    version: 1, name: "Mój dom", north: 0, lat: 52.41, lon: 16.85,
    floors: [{ id: "f0", name: "Parter", level: 0, elev: 0, height: 2.6 }],
    walls: [], rooms: [], items: [], lights: [], sensors: [], models: [], stairs: [], backgrounds: [],
  };
}

export const COLLECTIONS = ["walls", "rooms", "items", "lights", "sensors", "models", "stairs", "backgrounds"];

export function normalize(dom) {
  dom = dom && typeof dom === "object" ? dom : emptyDom();
  if (!Array.isArray(dom.floors) || !dom.floors.length) dom.floors = emptyDom().floors;
  for (const k of COLLECTIONS) if (!Array.isArray(dom[k])) dom[k] = [];
  for (const f of dom.floors) {
    f.id = f.id || uid("f");
    f.elev = +f.elev || 0;
    f.height = +f.height || 2.6;
    f.level = f.level ?? 0;
  }
  dom.floors.sort((a, b) => a.level - b.level || a.elev - b.elev);
  for (const k of COLLECTIONS) for (const o of dom[k]) o.id = o.id || uid(k[0]);
  for (const w of dom.walls) {
    w.t = +w.t || 0.12;
    w.openings = Array.isArray(w.openings) ? w.openings : [];
    for (const op of w.openings) op.id = op.id || uid("op");
  }
  dom.north = +dom.north || 0;
  return dom;
}

export function floorById(dom, id) {
  return dom.floors.find((f) => f.id === id) || dom.floors[0];
}

export function wallLen(w) {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

export function wallAngle(w) {
  return Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
}

// Rzut punktu na ścianę: {t: odległość od początku, d: odległość od osi, x, y}
export function projectOnWall(w, x, y) {
  const L = wallLen(w) || 1e-6;
  const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
  let t = (x - w.x1) * ux + (y - w.y1) * uy;
  const tc = Math.max(0, Math.min(L, t));
  const px = w.x1 + ux * tc, py = w.y1 + uy * tc;
  return { t, tc, d: Math.hypot(x - px, y - py), x: px, y: py };
}

export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function polyCentroid(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

export function rectPoly(x0, y0, x1, y1) {
  const a = Math.min(x0, x1), b = Math.max(x0, x1), c = Math.min(y0, y1), d = Math.max(y0, y1);
  return [[a, c], [b, c], [b, d], [a, d]];
}

export function round(v, p = 3) {
  const m = 10 ** p;
  return Math.round(v * m) / m;
}

// Kolor z temperatury barwowej (K)
export function kelvinToHex(k) {
  const t = k / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592;
    g = 288.1221695283 * (t - 60) ** -0.0755148492;
    b = 255;
  }
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

// Pozycja słońca (NOAA). Zwraca {az, el} w stopniach; az od północy zgodnie z zegarem.
export function sunPosition(date, lat, lon) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const doy = Math.floor((date.getTime() - start) / 864e5) + 1;
  const hr = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const g = (2 * Math.PI / 365) * (doy - 1 + (hr - 12) / 24);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) -
    0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = hr * 60 + eqt + 4 * lon;
  const ha = ((tst / 4 - 180) * Math.PI) / 180;
  const la = (lat * Math.PI) / 180;
  const cz = Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cz)));
  const el = 90 - (zen * 180) / Math.PI;
  let az = (Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(la) - Math.tan(dec) * Math.cos(la)) * 180) / Math.PI + 180;
  return { az: ((az % 360) + 360) % 360, el };
}

// Stan encji -> {on, level 0..1, kelvin, rgb}
export function lightState(st) {
  if (!st) return null;
  const on = st.state === "on" || st.state === "home" || st.state === "playing" || st.state === "open";
  const a = st.attributes || {};
  let level = 1;
  if (a.brightness != null) level = Math.max(0.03, a.brightness / 255);
  let kelvin = a.color_temp_kelvin || (a.color_temp ? Math.round(1e6 / a.color_temp) : null);
  let rgb = null;
  if (a.color_mode && ["hs", "rgb", "rgbw", "rgbww", "xy"].includes(a.color_mode) && Array.isArray(a.rgb_color)) rgb = a.rgb_color;
  return { on, level, kelvin, rgb };
}

export function sensorActive(st) {
  if (!st) return false;
  return ["on", "open", "detected", "wet", "unlocked", "playing"].includes(st.state);
}

export function friendly(st, eid) {
  return (st && st.attributes && st.attributes.friendly_name) || eid || "";
}
