"""Dom 3D - serwer dodatku Home Assistant.

Ingress (panel w HA) -> ten serwer:
  /                    panel (edytor + widok 3D)
  api/dom              GET/PUT model domu (dom.json)
  api/files            GET lista / POST upload (modele .glb, podkłady .png/.jpg)
  files/<nazwa>        pobranie pliku
  api/info             adres publikacji dla karty Lovelace
  api/ws               most websocket do Home Assistant (stany + usługi)

Po każdym zapisie dane są publikowane do /homeassistant/www/dom3d/<sekret>/,
skąd czyta je karta `custom:dom3d-card` (adres /local/dom3d/<sekret>/).
"""
import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import time

from aiohttp import web, WSMsgType, ClientSession

LOG = logging.getLogger("dom3d")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DEV = os.environ.get("DOM3D_DEV") == "1"
HERE = os.path.dirname(os.path.abspath(__file__))
WWW = os.path.join(HERE, "www")
DATA = os.environ.get("DOM3D_DATA", os.path.join(HERE, "..", "devdata") if DEV else "/data")
FILES = os.path.join(DATA, "files")
DOM = os.path.join(DATA, "dom.json")
def _token():
    t = os.environ.get("SUPERVISOR_TOKEN") or os.environ.get("HASSIO_TOKEN")
    if t:
        return t
    for p in ("/run/s6/container_environment/SUPERVISOR_TOKEN", "/var/run/s6/container_environment/SUPERVISOR_TOKEN"):
        if os.path.exists(p):
            return open(p).read().strip()
    return None


TOKEN = _token()
HA_WS = os.environ.get("DOM3D_HA_WS", "ws://supervisor/core/websocket")
PORT = int(os.environ.get("DOM3D_PORT", "8099"))
VERSION = "0.2.1"

ALLOWED_EXT = {".glb", ".gltf", ".png", ".jpg", ".jpeg", ".webp", ".hdr"}
WS_ALLOWED = {"get_states", "config/area_registry/list", "config/floor_registry/list",
              "config/entity_registry/list_for_display", "call_service"}

os.makedirs(FILES, exist_ok=True)


def publish_root():
    """Katalog www konfiguracji HA (/local) + /dom3d."""
    env = os.environ.get("DOM3D_PUBLISH")
    if env:
        os.makedirs(env, exist_ok=True)
        return os.path.join(env, "dom3d")
    for cfg in ("/homeassistant", "/config"):
        if os.path.isfile(os.path.join(cfg, "configuration.yaml")):
            www = os.path.join(cfg, "www")
            os.makedirs(www, exist_ok=True)
            return os.path.join(www, "dom3d")
    return None


def secret():
    p = os.path.join(DATA, "secret.txt")
    if not os.path.exists(p):
        with open(p, "w") as fh:
            fh.write(secrets.token_hex(8))
    return open(p).read().strip()


def empty_dom():
    return {"version": 1, "name": "Mój dom", "north": 0, "lat": 52.41, "lon": 16.85,
            "floors": [{"id": "f0", "name": "Parter", "level": 0, "elev": 0, "height": 2.6}],
            "walls": [], "rooms": [], "items": [], "lights": [], "sensors": [],
            "models": [], "stairs": [], "backgrounds": []}


def load_dom():
    if os.path.exists(DOM):
        with open(DOM, encoding="utf-8") as fh:
            return json.load(fh)
    return empty_dom()


def safe_name(name):
    base, ext = os.path.splitext(os.path.basename(name))
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "plik"
    return base[:80] + ext.lower()


def publish(dom=None):
    root = publish_root()
    if not root:
        return None
    sec = secret()
    dst = os.path.join(root, sec)
    os.makedirs(os.path.join(dst, "files"), exist_ok=True)
    card = os.path.join(WWW, "dom3d-card.js")
    if os.path.exists(card):
        shutil.copy2(card, os.path.join(root, "dom3d-card.js"))
    dom = dom if dom is not None else load_dom()
    with open(os.path.join(dst, "dom.json"), "w", encoding="utf-8") as fh:
        json.dump(dom, fh, ensure_ascii=False)
    used = set()
    for key in ("models", "backgrounds"):
        for m in dom.get(key, []):
            if m.get("file"):
                used.add(m["file"])
    for rnd in dom.get("renders", []):
        for k in ("day", "night"):
            if rnd.get(k):
                used.add(rnd[k])
        for L in rnd.get("lights", []):
            if L.get("file"):
                used.add(L["file"])
    for it in dom.get("items", []):
        if it.get("glb"):
            used.add(it["glb"])
    for f in used:
        src = os.path.join(FILES, f)
        tgt = os.path.join(dst, "files", f)
        if os.path.exists(src) and (not os.path.exists(tgt) or os.path.getmtime(tgt) < os.path.getmtime(src)):
            shutil.copy2(src, tgt)
    return f"/local/dom3d/{sec}/"


# ------------------------------------------------------------------ HA bridge


class HABridge:
    def __init__(self):
        self.states = {}
        self.clients = set()
        self.ws = None
        self.pending = {}
        self.next_id = 10
        self.connected = False

    async def run(self, app):
        if not TOKEN:
            LOG.warning("Brak SUPERVISOR_TOKEN - tryb bez Home Assistant (dev)")
            return
        while True:
            try:
                async with ClientSession() as s:
                    async with s.ws_connect(HA_WS, heartbeat=30, max_msg_size=0) as ws:
                        self.ws = ws
                        await self._handshake(ws)
                        self.connected = True
                        LOG.info("Połączono z Home Assistant (%d encji)", len(self.states))
                        await self.broadcast({"type": "states", "states": list(self.states.values())})
                        async for msg in ws:
                            if msg.type == WSMsgType.TEXT:
                                await self._on_msg(json.loads(msg.data))
                            elif msg.type in (WSMsgType.CLOSED, WSMsgType.ERROR):
                                break
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa
                LOG.warning("HA websocket: %s", e)
            self.connected = False
            self.ws = None
            await asyncio.sleep(5)

    async def _handshake(self, ws):
        m = await ws.receive_json()
        await ws.send_json({"type": "auth", "access_token": TOKEN})
        m = await ws.receive_json()
        if m.get("type") != "auth_ok":
            raise RuntimeError("auth: %s" % m)
        await ws.send_json({"id": 1, "type": "get_states"})
        while True:
            m = await ws.receive_json()
            if m.get("id") == 1:
                self.states = {s["entity_id"]: s for s in m.get("result", [])}
                break
        await ws.send_json({"id": 2, "type": "subscribe_events", "event_type": "state_changed"})

    async def _on_msg(self, m):
        if m.get("type") == "event":
            d = m["event"]["data"]
            eid, new = d.get("entity_id"), d.get("new_state")
            if new is None:
                self.states.pop(eid, None)
            else:
                self.states[eid] = new
            await self.broadcast({"type": "state", "entity_id": eid, "state": new})
        elif m.get("type") == "result" and m.get("id") in self.pending:
            fut = self.pending.pop(m["id"])
            if not fut.done():
                fut.set_result(m)

    async def call(self, msg, timeout=15):
        if not self.ws or not self.connected:
            return {"success": False, "error": {"message": "Brak połączenia z Home Assistant"}}
        self.next_id += 1
        mid = self.next_id
        fut = asyncio.get_running_loop().create_future()
        self.pending[mid] = fut
        await self.ws.send_json({**msg, "id": mid})
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self.pending.pop(mid, None)
            return {"success": False, "error": {"message": "timeout"}}

    async def broadcast(self, payload):
        dead = []
        for c in self.clients:
            try:
                await c.send_json(payload)
            except Exception:  # noqa
                dead.append(c)
        for c in dead:
            self.clients.discard(c)


BRIDGE = HABridge()

# ------------------------------------------------------------------ handlers


async def index(request):
    resp = web.FileResponse(os.path.join(WWW, "index.html"))
    resp.headers["Cache-Control"] = "no-cache"
    return resp


async def get_dom(request):
    return web.json_response(load_dom(), dumps=lambda o: json.dumps(o, ensure_ascii=False))


async def put_dom(request):
    try:
        dom = await request.json()
    except Exception:  # noqa
        raise web.HTTPBadRequest(text="Niepoprawny JSON")
    if not isinstance(dom, dict) or "floors" not in dom:
        raise web.HTTPBadRequest(text="Brak listy pięter")
    dom["saved"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    tmp = DOM + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(dom, fh, ensure_ascii=False, indent=1)
    if os.path.exists(DOM):
        bdir = os.path.join(DATA, "kopie")
        os.makedirs(bdir, exist_ok=True)
        shutil.copy2(DOM, os.path.join(bdir, time.strftime("dom-%Y%m%d-%H%M%S.json")))
        kopie = sorted(os.listdir(bdir))
        for old in kopie[:-50]:
            os.remove(os.path.join(bdir, old))
    os.replace(tmp, DOM)
    url = await asyncio.get_running_loop().run_in_executor(None, publish, dom)
    return web.json_response({"ok": True, "saved": dom["saved"], "publish": url})


async def list_files(request):
    out = []
    for f in sorted(os.listdir(FILES)):
        p = os.path.join(FILES, f)
        out.append({"name": f, "size": os.path.getsize(p), "mtime": int(os.path.getmtime(p))})
    return web.json_response(out)


async def upload(request):
    reader = await request.multipart()
    saved = []
    async for part in reader:
        if not part.filename:
            continue
        name = safe_name(part.filename)
        if os.path.splitext(name)[1] not in ALLOWED_EXT:
            raise web.HTTPBadRequest(text=f"Niedozwolony typ pliku: {name}")
        with open(os.path.join(FILES, name), "wb") as fh:
            while True:
                chunk = await part.read_chunk(1 << 20)
                if not chunk:
                    break
                fh.write(chunk)
        saved.append(name)
    return web.json_response({"ok": True, "files": saved})


async def get_file(request):
    name = safe_name(request.match_info["name"])
    p = os.path.join(FILES, name)
    if not os.path.exists(p):
        raise web.HTTPNotFound()
    return web.FileResponse(p)


async def info(request):
    url = await asyncio.get_running_loop().run_in_executor(None, publish, None)
    return web.json_response({"version": VERSION, "publish": url, "ha": BRIDGE.connected, "dev": DEV})


async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=0)
    await ws.prepare(request)
    BRIDGE.clients.add(ws)
    await ws.send_json({"type": "hello", "ha": BRIDGE.connected, "version": VERSION})
    await ws.send_json({"type": "states", "states": list(BRIDGE.states.values())})
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            m = json.loads(msg.data)
            if m.get("type") == "ws":
                inner = m.get("msg") or {}
                if inner.get("type") not in WS_ALLOWED:
                    await ws.send_json({"type": "ws_result", "id": m.get("id"), "success": False,
                                        "error": {"message": "niedozwolone"}})
                    continue
                res = await BRIDGE.call(inner)
                await ws.send_json({"type": "ws_result", "id": m.get("id"), "success": res.get("success"),
                                    "result": res.get("result"), "error": res.get("error")})
    finally:
        BRIDGE.clients.discard(ws)
    return ws


@web.middleware
async def no_cache_js(request, handler):
    resp = await handler(request)
    if request.path.endswith((".js", ".css", ".html")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


async def on_start(app):
    await asyncio.get_running_loop().run_in_executor(None, publish, None)
    app["bridge"] = asyncio.create_task(BRIDGE.run(app))


async def on_stop(app):
    t = app.get("bridge")
    if t:
        t.cancel()


def make_app():
    app = web.Application(client_max_size=300 * 1024 * 1024, middlewares=[no_cache_js])
    app.router.add_get("/", index)
    app.router.add_get("/api/dom", get_dom)
    app.router.add_put("/api/dom", put_dom)
    app.router.add_get("/api/files", list_files)
    app.router.add_post("/api/files", upload)
    app.router.add_get("/files/{name}", get_file)
    app.router.add_get("/api/info", info)
    app.router.add_get("/api/ws", ws_handler)
    app.router.add_static("/", WWW, show_index=False)
    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    return app


if __name__ == "__main__":
    LOG.info("Dom 3D %s, dane: %s, publikacja: %s", VERSION, DATA, publish_root())
    web.run_app(make_app(), host="0.0.0.0", port=PORT, access_log=None)
