"""App icons: an ochre jigsaw piece with a small tower house, on dark stone."""
import math, os
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(os.path.join(ROOT, "icons"), exist_ok=True)


def cubic(p0, p1, p2, p3, n=24):
    t = np.linspace(0, 1, n)[:, None]
    return ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3


def knob():
    pts = [np.array([[0, 0], [0.36, 0]])]
    pts.append(cubic(*map(np.array, ([0.36, 0], [0.43, 0], [0.455, 0.05], [0.425, 0.10]))))
    cx, cy = 0.5, 0.165
    a0, a1 = math.atan2(0.10 - cy, 0.425 - cx), math.atan2(0.10 - cy, 0.575 - cx) - 2 * math.pi
    r = math.hypot(0.075, 0.065)
    ang = np.linspace(a0, a1, 60)
    pts.append(np.stack([cx + r * np.cos(ang), cy + r * np.sin(ang)], 1))
    pts.append(cubic(*map(np.array, ([0.575, 0.10], [0.545, 0.05], [0.57, 0], [0.64, 0]))))
    pts.append(np.array([[1, 0]]))
    return np.concatenate(pts)


def edge(P, Q, sign):
    P, Q = np.asarray(P, float), np.asarray(Q, float)
    d = Q - P
    n = np.array([-d[1], d[0]])
    k = knob()
    return P + np.outer(k[:, 0], d) + np.outer(k[:, 1] * sign, n)


def piece(size, inset):
    a, b = inset, size - inset
    # square with knobs out on top and right, holes on bottom and left
    top = edge((a, a), (b, a), -1)
    right = edge((b, a), (b, b), -1)
    bottom = edge((b, b), (a, b), 0)
    left = edge((a, b), (a, a), 1)
    return np.concatenate([top, right, bottom, left])


def make(size, maskable=False):
    S = size * 4
    im = Image.new("RGBA", (S, S), (29, 26, 22, 255))
    d = ImageDraw.Draw(im)
    if not maskable:
        im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.22, fill=(29, 26, 22, 255))
    inset = S * (0.30 if maskable else 0.24)
    pts = piece(S, inset) + np.array([-S * 0.02, S * 0.035])
    d.polygon([tuple(p) for p in pts], fill=(219, 165, 67, 255))
    # tower house silhouette
    cx, base = S * 0.47, S * (0.66 if maskable else 0.69)
    w, h = S * 0.12, S * 0.20
    ink = (43, 31, 13, 255)
    d.rectangle([cx - w / 2, base - h, cx + w / 2, base], fill=ink)
    d.polygon([(cx - w / 2 - S * 0.02, base - h), (cx + w / 2 + S * 0.02, base - h), (cx, base - h - S * 0.08)], fill=ink)
    for i in range(2):
        y = base - h + S * 0.045 + i * S * 0.065
        d.rectangle([cx - S * 0.016, y, cx + S * 0.016, y + S * 0.03], fill=(219, 165, 67, 255))
    return im.resize((size, size), Image.LANCZOS)


make(192).save(os.path.join(ROOT, "icons", "icon-192.png"))
make(512).save(os.path.join(ROOT, "icons", "icon-512.png"))
make(512, True).save(os.path.join(ROOT, "icons", "icon-512-maskable.png"))
print("icons written")
