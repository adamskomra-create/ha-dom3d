"""Eksport modelu z Blendera do aplikacji Dom 3D (.glb).

Użycie: Blender -> zakładka Scripting -> otwórz ten plik -> Run Script.
Eksportuje widoczne obiekty (bez ścian, podłóg, sufitów, okien, kamer i świateł - te robi aplikacja)
do pliku <nazwa_pliku_blend>.glb obok pliku .blend. Potem wgraj go w panelu Dom 3D (narzędzie "Model .glb").

Pozycjonowanie w aplikacji: x, y, obrót i skala ustawiasz w panelu po prawej. Oś Z Blendera = góra,
plan Blendera (x, y) = plan aplikacji (x, y), więc model bez obrotu trafia 1:1.
"""
import bpy
import os

SKIP_PREFIXES = ("wall_", "floor_", "win_", "cam_", "ceiling_spot")
SKIP_TYPES = {"LIGHT", "CAMERA", "EMPTY"}

sc = bpy.context.scene
for o in sc.objects:
    o.select_set(False)
n = 0
for o in sc.objects:
    if o.type in SKIP_TYPES or o.name.startswith(SKIP_PREFIXES):
        continue
    if o.name.startswith("ceiling") and o.name != "ceiling_strip":
        continue
    if o.hide_render or not o.visible_get():
        continue
    o.select_set(True)
    n += 1

base = bpy.path.abspath("//") or os.path.expanduser("~")
name = bpy.path.display_name_from_filepath(bpy.data.filepath) or "model"
path = os.path.join(base, name + ".glb")
bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=True,
                          export_lights=False, export_cameras=False, export_yup=True)
print(f"Dom 3D: wyeksportowano {n} obiektów do {path}")
