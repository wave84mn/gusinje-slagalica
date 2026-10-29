"""Make the copy of the game that is published as a Claude page (build/artifact/).

That host wraps the page in its own <html>/<head>, loads scripts only from a few CDNs, has no
service workers, and doesn't serve .glb files. So this copy loads three.js from jsDelivr, skips the
offline cache, and ships the models as base64 text (quantized, without meshopt compression).
usage: python3 tools/build_artifact.py <raw dir, e.g. build/raw_real>   (needs gltfpack on PATH or $GLTFPACK)
"""
import base64, os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "build", "raw_real")
OUT = os.path.join(ROOT, "build", "artifact")
GLTFPACK = os.environ.get("GLTFPACK", "gltfpack")
THREE = "https://cdn.jsdelivr.net/npm/three@0.184.0/"

shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(os.path.join(OUT, "css")); os.makedirs(os.path.join(OUT, "js")); os.makedirs(os.path.join(OUT, "data"))
shutil.copy(os.path.join(ROOT, "css", "app.css"), os.path.join(OUT, "css"))
for f in ("main.js", "view.js", "input.js", "i18n.js", "sound.js"):
    shutil.copy(os.path.join(ROOT, "js", f), os.path.join(OUT, "js"))
shutil.copy(os.path.join(ROOT, "data", "puzzle.json"), os.path.join(OUT, "data"))
for name in ("pieces", "tray"):
    tmp = os.path.join(OUT, "data", name + ".glb")
    subprocess.run([GLTFPACK, "-i", os.path.join(RAW, name + ".glb"), "-o", tmp, "-kn"], check=True, capture_output=True)
    with open(tmp, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    os.remove(tmp)
    with open(os.path.join(OUT, "data", name + ".glb.txt"), "w") as f:
        f.write(b64)

src = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
head = src[src.index("<head>") + 6: src.index("</head>")]
body = src[src.index("<body"):]
body = body[body.index(">") + 1: body.index("</body>")]
skip = ('<meta charset', 'name="viewport"', 'rel="manifest"', 'rel="icon"', 'apple-touch-icon', 'mobile-web-app', 'theme-color')
head = "\n".join(l for l in head.strip().split("\n") if not any(k in l for k in skip))
old_map = '{"imports":{"three":"./js/vendor/three/three.module.min.js","three/addons/":"./js/vendor/three/addons/"}}'
assert old_map in head
head = head.replace(old_map, '{"imports":{"three":"%sbuild/three.module.min.js","three/addons/":"%sexamples/jsm/"}}' % (THREE, THREE))
head = head.replace('<script type="module" src="js/main.js"></script>',
                    '<script>window.SLAGALICA_NO_SW = true; window.SLAGALICA_FILES = { pieces: "data/pieces.glb.txt", tray: "data/tray.glb.txt" };</script>\n'
                    '<script type="module" src="js/main.js"></script>')
with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as f:
    f.write(head + "\n" + body.strip() + "\n")
for d, _, fs in os.walk(OUT):
    for f in fs:
        p = os.path.join(d, f)
        print(f"{os.path.relpath(p, OUT):24s} {os.path.getsize(p) / 1e6:6.2f} MB")
