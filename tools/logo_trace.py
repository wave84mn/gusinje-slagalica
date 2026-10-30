"""Turns the Xplore Prokletije logo (source/brand/xplore_prokletije.png, blue and black on white)
into clean vector shapes without the background: source/brand/xplore_parts.json holds the two colour
layers (ink = the dark tower and "Xplore", accent = the blue squares, base and "PROKLETIJE") as SVG
paths, so the game and the QR cards can colour them to fit their own palette.
Windows and the door are holes in the tower, so whatever is behind the logo shows through them.
It also puts the logo on the game's start screen (index.html, between the logo markers).
usage: python3 tools/logo_trace.py [--preview out.svg]"""
import json, os, sys
import cv2, numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "source", "brand", "xplore_prokletije.png")
OUT = os.path.join(ROOT, "source", "brand", "xplore_parts.json")
UP = 4            # trace at 4x so edges land between the original pixels
EPS = 1.1         # outline simplification at 4x (about a quarter of an original pixel)

im = cv2.imread(SRC, cv2.IMREAD_COLOR).astype(np.float32)
B, G, R = im[..., 0], im[..., 1], im[..., 2]
lum = 0.299 * R + 0.587 * G + 0.114 * B
# how much of each pixel is blue / dark ink (anti-aliased edges are part-way)
blue = np.clip((B - R) / 240.0, 0, 1)
dark = np.clip((250 - lum) / 220.0 - blue * 0.78, 0, 1)

def layer(a):
    big = cv2.resize(a, None, fx=UP, fy=UP, interpolation=cv2.INTER_CUBIC)
    big = cv2.GaussianBlur(big, (0, 0), UP * 0.45)
    m = (big > 0.5).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    return m

def path(mask, min_area):
    cs, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    parts = []
    for c in cs:
        if abs(cv2.contourArea(c)) < min_area:
            continue
        p = cv2.approxPolyDP(c, EPS, True)[:, 0, :] / UP
        parts.append("M" + " ".join(f"{x:.1f} {y:.1f}" for x, y in p) + "Z")
    return "".join(parts)

ink, acc = layer(dark), layer(blue)
ys, xs = np.where((ink | acc) > 0)
pad = 6 * UP
x0, y0, x1, y1 = xs.min() - pad, ys.min() - pad, xs.max() + pad, ys.max() + pad
vb = [round(float(v) / UP, 1) for v in (x0, y0, x1 - x0, y1 - y0)]
data = {"viewBox": vb, "ink": path(ink, 30 * UP * UP), "accent": path(acc, 30 * UP * UP)}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(data, f)
print(f"viewBox {vb}, ink {len(data['ink'])} chars, accent {len(data['accent'])} chars")
if "--preview" in sys.argv:
    out = sys.argv[sys.argv.index("--preview") + 1]
    with open(out, "w") as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(map(str, vb))}">'
                f'<path fill="#17212a" fill-rule="evenodd" d="{data["ink"]}"/>'
                f'<path fill="#015cf8" fill-rule="evenodd" d="{data["accent"]}"/></svg>')

# the start screen: the logo inline, so the page's colours (cream and ochre) can paint it
html = os.path.join(ROOT, "index.html")
with open(html, encoding="utf-8") as f:
    page = f.read()
a, b = "<!-- logo: written by tools/logo_trace.py -->", "<!-- /logo -->"
i, j = page.index(a) + len(a), page.index(b)
logo = (f'<p class="brand" role="img" aria-label="Xplore Prokletije"><svg viewBox="{" ".join(map(str, vb))}" aria-hidden="true">'
        f'<path class="ink" fill-rule="evenodd" d="{data["ink"]}"/><path class="acc" fill-rule="evenodd" d="{data["accent"]}"/></svg></p>')
with open(html, "w", encoding="utf-8") as f:
    f.write(page[:i] + logo + page[j:])
print("start screen logo written")
