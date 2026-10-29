"""Stand-in puzzle (8x8 pieces, 270 mm area in a 300 mm tray) for building the game
before the real Gusinje puzzle files arrive.

Writes data/pieces.glb, data/tray.glb and data/puzzle.json in the same format the
real converter will produce:
  * millimetres, Y up, X = east, -Z = north, board centre at the origin
  * pieces.glb: one node per piece, named by its code (A..H west->east, 1..8 north->south),
    geometry local to the piece origin, node translation = assembled position
  * _FX vertex attribute: 1 = water (animated), 0 = everything else
"""
import json, math, os, sys
import numpy as np
from matplotlib.path import Path
from glb import GLB, MeshBuilder

rng = np.random.default_rng(7)
OUT = sys.argv[1] if len(sys.argv) > 1 else "data"
os.makedirs(OUT, exist_ok=True)

TRAY, RIM = 300.0, 15.0
INNER = TRAY / 2 - RIM            # 135
FLOOR_Y, RIM_Y, BASE = 2.0, 8.0, 3.0
COLS = ROWS = 8
CELL = 2 * INNER / COLS

C = dict(grass=(0.50, 0.64, 0.35), side=(0.37, 0.50, 0.26), road=(0.62, 0.62, 0.60),
         water=(0.24, 0.50, 0.77), wall=(0.93, 0.90, 0.85), roof=(0.71, 0.31, 0.23),
         tree=(0.18, 0.42, 0.23), dome=(0.55, 0.57, 0.59), tray=(0.86, 0.84, 0.80),
         trayside=(0.74, 0.72, 0.68), wood=(0.55, 0.38, 0.22))


# ---------------------------------------------------------------- jigsaw outlines
def cubic(p0, p1, p2, p3, n=10):
    t = np.linspace(0, 1, n)[:, None]
    return ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3


def knob_template():
    pts = [np.array([[0, 0], [0.36, 0]])]
    pts.append(cubic(*map(np.array, ([0.36, 0], [0.43, 0], [0.455, 0.05], [0.425, 0.10])), n=12))
    cx, cy = 0.5, 0.165
    a0 = math.atan2(0.10 - cy, 0.425 - cx)
    a1 = math.atan2(0.10 - cy, 0.575 - cx)
    r = math.hypot(0.075, 0.065)
    if a1 > a0:
        a1 -= 2 * math.pi
    ang = np.linspace(a0, a1, 26)
    pts.append(np.stack([cx + r * np.cos(ang), cy + r * np.sin(ang)], 1))
    pts.append(cubic(*map(np.array, ([0.575, 0.10], [0.545, 0.05], [0.57, 0], [0.64, 0])), n=12))
    pts.append(np.array([[1, 0]]))
    out = np.concatenate(pts)
    keep = np.r_[True, np.linalg.norm(np.diff(out, axis=0), axis=1) > 1e-6]
    return out[keep]


TEMPLATE = knob_template()


def edge_points(P, Q, knob):
    """Points from P to Q (inclusive). knob = None or (sign, shift, scale)."""
    P, Q = np.asarray(P, float), np.asarray(Q, float)
    if knob is None:
        return np.stack([P, Q])
    sign, shift, scale = knob
    d = Q - P
    L = np.linalg.norm(d)
    n = np.array([-d[1], d[0]]) / L
    u = TEMPLATE[:, 0].copy()
    v = TEMPLATE[:, 1] * scale * sign
    mid = (u > 0.30) & (u < 0.70)
    u[mid] = 0.5 + (u[mid] - 0.5) * scale + shift
    return P + np.outer(u, d) + np.outer(v * L, n)


# lattice corners, interior ones jittered
corner = np.zeros((COLS + 1, ROWS + 1, 2))
for i in range(COLS + 1):
    for j in range(ROWS + 1):
        x = -INNER + i * CELL
        z = -INNER + j * CELL
        if 0 < i < COLS and 0 < j < ROWS:
            x += rng.uniform(-2.2, 2.2)
            z += rng.uniform(-2.2, 2.2)
        corner[i, j] = (x, z)


def rand_knob():
    return (rng.choice([-1, 1]), rng.uniform(-0.04, 0.04), rng.uniform(0.92, 1.06))


# horizontal edges h[i][j]: corner(i,j)->corner(i+1,j); vertical v[i][j]: corner(i,j)->corner(i,j+1)
hk = [[None if j in (0, ROWS) else rand_knob() for j in range(ROWS + 1)] for i in range(COLS)]
vk = [[None if i in (0, COLS) else rand_knob() for j in range(ROWS)] for i in range(COLS + 1)]


def outline(i, j):
    top = edge_points(corner[i, j], corner[i + 1, j], hk[i][j])
    right = edge_points(corner[i + 1, j], corner[i + 1, j + 1], vk[i + 1][j])
    bottom = edge_points(corner[i, j + 1], corner[i + 1, j + 1], hk[i][j + 1])[::-1]
    left = edge_points(corner[i, j], corner[i, j + 1], vk[i][j])[::-1]
    pts = np.concatenate([top[:-1], right[:-1], bottom[:-1], left[:-1]])
    return pts


# ---------------------------------------------------------------- triangulation
def signed_area(p):
    x, y = p[:, 0], p[:, 1]
    return 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)


def earclip(poly):
    """Ear clipping for a simple polygon; returns index triples (same orientation as input)."""
    pts = np.asarray(poly, float)
    if signed_area(pts) < 0:
        tris = earclip(pts[::-1])
        n = len(pts)
        return [(n - 1 - a, n - 1 - c, n - 1 - b) for a, b, c in tris]
    idx = list(range(len(pts)))
    tris = []
    guard = 0
    while len(idx) > 3 and guard < 100000:
        guard += 1
        n = len(idx)
        P = pts[idx]
        prv, nxt = np.roll(P, 1, axis=0), np.roll(P, -1, axis=0)
        cross = (P[:, 0] - prv[:, 0]) * (nxt[:, 1] - P[:, 1]) - (P[:, 1] - prv[:, 1]) * (nxt[:, 0] - P[:, 0])
        found = False
        for k in np.argsort(-cross):
            if cross[k] <= 1e-12:
                break
            a, b, c = prv[k], P[k], nxt[k]
            others = np.delete(np.arange(n), [(k - 1) % n, k, (k + 1) % n])
            Q = P[others]
            d1 = (b[0] - a[0]) * (Q[:, 1] - a[1]) - (b[1] - a[1]) * (Q[:, 0] - a[0])
            d2 = (c[0] - b[0]) * (Q[:, 1] - b[1]) - (c[1] - b[1]) * (Q[:, 0] - b[0])
            d3 = (a[0] - c[0]) * (Q[:, 1] - c[1]) - (a[1] - c[1]) * (Q[:, 0] - c[0])
            inside = (d1 >= -1e-9) & (d2 >= -1e-9) & (d3 >= -1e-9)
            if not inside.any():
                tris.append((idx[(k - 1) % n], idx[k], idx[(k + 1) % n]))
                del idx[k]
                found = True
                break
        if not found:   # degenerate: drop a vertex
            del idx[int(np.argmin(np.abs(cross)))]
    if len(idx) == 3:
        tris.append(tuple(idx))
    return tris


def v3(x, y, z):
    return np.array([x, y, z], float)


def tri_n(mb, a, b, c, col, want, fx=0.0):
    """Add triangle, ordering vertices so the face normal points along `want`."""
    n = np.cross(b - a, c - a)
    if np.dot(n, want) < 0:
        b, c = c, b
    mb.tri(a, b, c, col, fx)


def quad_n(mb, a, b, c, d, col, want, fx=0.0):
    tri_n(mb, a, b, c, col, want, fx)
    tri_n(mb, a, c, d, col, want, fx)


def slab(mb, poly, y0, y1, top_col, side_col, fx=0.0, bottom=True):
    """Extrude a 2D polygon (x,z) between y0 and y1."""
    poly = np.asarray(poly, float)
    if signed_area(poly) < 0:
        poly = poly[::-1]
    up = v3(0, 1, 0)
    for a, b, c in earclip(poly):
        tri_n(mb, v3(poly[a][0], y1, poly[a][1]), v3(poly[b][0], y1, poly[b][1]), v3(poly[c][0], y1, poly[c][1]), top_col, up, fx)
        if bottom:
            tri_n(mb, v3(poly[a][0], y0, poly[a][1]), v3(poly[b][0], y0, poly[b][1]), v3(poly[c][0], y0, poly[c][1]), side_col, -up)
    n = len(poly)
    for k in range(n):
        p, q = poly[k], poly[(k + 1) % n]
        d = q - p
        # polygon has positive signed area in (x,z): outward normal is (d.z, -d.x)
        out = v3(d[1], 0, -d[0])
        quad_n(mb, v3(p[0], y0, p[1]), v3(q[0], y0, q[1]), v3(q[0], y1, q[1]), v3(p[0], y1, p[1]), side_col, out)


# ---------------------------------------------------------------- features
def box(mb, cx, cz, w, d, y0, h, col, rot=0.0):
    c, s = math.cos(rot), math.sin(rot)
    loc = [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]
    poly = [(cx + x * c - z * s, cz + x * s + z * c) for x, z in loc]
    slab(mb, poly, y0, y0 + h, col, col, bottom=False)
    return poly


def hip_roof(mb, cx, cz, w, d, y0, h, col, rot=0.0):
    c, s = math.cos(rot), math.sin(rot)
    ridge = max(0.0, (w - d) / 2)
    def P(x, y, z):
        return v3(cx + x * c - z * s, y, cz + x * s + z * c)
    ov = 0.5
    a, b, cc, dd = P(-w / 2 - ov, y0, -d / 2 - ov), P(w / 2 + ov, y0, -d / 2 - ov), P(w / 2 + ov, y0, d / 2 + ov), P(-w / 2 - ov, y0, d / 2 + ov)
    r1, r2 = P(-ridge, y0 + h, 0), P(ridge, y0 + h, 0)
    centre = P(0, y0 + h * 0.3, 0)
    for f in ((a, b, r2, r1), (cc, dd, r1, r2)):
        n = np.cross(f[1] - f[0], f[2] - f[0])
        quad_n(mb, *f, col, (f[0] + f[1]) / 2 - centre + v3(0, 1, 0))
    tri_n(mb, b, cc, r2, col, (b + cc) / 2 - centre + v3(0, 1, 0))
    tri_n(mb, dd, a, r1, col, (dd + a) / 2 - centre + v3(0, 1, 0))


def cone(mb, cx, cz, r, y0, h, col, seg=6, cap=False):
    ang = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    tip = v3(cx, y0 + h, cz)
    for k in range(seg):
        p = v3(cx + r * math.cos(ang[k]), y0, cz + r * math.sin(ang[k]))
        q = v3(cx + r * math.cos(ang[(k + 1) % seg]), y0, cz + r * math.sin(ang[(k + 1) % seg]))
        mid = (p + q) / 2
        tri_n(mb, p, q, tip, col, mid - v3(cx, y0 + h * 0.2, cz))
        if cap:
            tri_n(mb, p, q, v3(cx, y0, cz), col, v3(0, -1, 0))


def cylinder(mb, cx, cz, r, y0, h, col, seg=8):
    ang = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    poly = [(cx + r * math.cos(a), cz + r * math.sin(a)) for a in ang]
    slab(mb, poly, y0, y0 + h, col, col, bottom=False)


# river and roads as world polylines
def smooth_path(ctrl, n=200):
    ctrl = np.asarray(ctrl, float)
    t = np.linspace(0, 1, len(ctrl))
    tt = np.linspace(0, 1, n)
    return np.stack([np.interp(tt, t, ctrl[:, 0]), np.interp(tt, t, ctrl[:, 1])], 1)


RIVER = smooth_path([(-140, -30), (-100, -42), (-60, -20), (-20, -28), (10, -8), (50, -14), (90, 6), (140, -2)], 400)
ROADS = [smooth_path([(-10, -140), (-6, -60), (0, -8), (4, 40), (2, 140)], 300),
         smooth_path([(-140, 30), (-70, 24), (0, 22), (60, 30), (140, 40)], 300),
         smooth_path([(-120, 110), (-60, 70), (0, 22)], 200)]


def dist_to(path, pts):
    pts = np.atleast_2d(pts)
    a, b = path[:-1], path[1:]
    d = b - a
    L2 = (d ** 2).sum(1)
    out = np.full(len(pts), np.inf)
    for k in range(len(pts)):
        t = np.clip(((pts[k] - a) * d).sum(1) / L2, 0, 1)
        proj = a + t[:, None] * d
        out[k] = np.sqrt(((pts[k] - proj) ** 2).sum(1)).min()
    return out


def strip_quads(path, width):
    """Short quads along a polyline (world coords)."""
    quads = []
    for k in range(len(path) - 1):
        p, q = path[k], path[k + 1]
        d = q - p
        L = np.linalg.norm(d)
        if L < 1e-6:
            continue
        n = np.array([-d[1], d[0]]) / L * width / 2
        quads.append(np.array([p - n, q - n, q + n, p + n]))
    return quads


# ---------------------------------------------------------------- build pieces
pieces, polys, paths = [], {}, {}
for j in range(ROWS):
    for i in range(COLS):
        code = "ABCDEFGH"[i] + str(j + 1)
        poly = outline(i, j)
        polys[code] = poly
        paths[code] = Path(poly)

centres = {}
for j in range(ROWS):
    for i in range(COLS):
        centres["ABCDEFGH"[i] + str(j + 1)] = corner[i:i + 2, j:j + 2].reshape(-1, 2).mean(0)


def owner(pts, margin=0.0):
    """Code of the piece that fully contains all pts (shrunk by margin), else None."""
    pts = np.atleast_2d(np.asarray(pts, float))
    c0 = pts.mean(0)
    for code in sorted(centres, key=lambda c: np.sum((centres[c] - c0) ** 2))[:4]:
        path = paths[code]
        inner = path.contains_points(pts, radius=margin) & path.contains_points(pts, radius=-margin)
        if inner.all():
            return code
    return None


feat = {c: MeshBuilder() for c in polys}
top_y = BASE

# water and roads
for path_, width, col, fx, lift in [(RIVER, 7.0, C["water"], 1.0, 0.15)] + [(r, 3.6, C["road"], 0.0, 0.25) for r in ROADS]:
    for q in strip_quads(path_, width):
        o = owner(q, 0.25)
        if o is None:
            continue
        loc = q - centres[o]
        a, b, c, d = [v3(p[0], top_y + lift, p[1]) for p in loc]
        quad_n(feat[o], a, b, c, d, col, v3(0, 1, 0), fx)

landmarks_def = [
    ("opstina", "Opština", "Town hall", (-24, 8), "hall"),
    ("kula", "Kula Rašića", "Rašić tower house", (30, -58), "tower"),
    ("sahat", "Sahat kula", "Clock tower", (18, 4), "clock"),
    ("vezirova", "Vezirova džamija", "Vezir's Mosque", (-52, 52), "mosque"),
    ("cekica", "Čekića džamija", "Čekić Mosque", (58, 58), "mosque"),
    ("radonciza", "Radončića džamija", "Radončić Mosque", (-30, -72), "mosque"),
    ("balica", "Balića kuća", "Balić house", (78, -40), "tower"),
]
taken = []
landmarks = []
for lid, me, en, (x, z), kind in landmarks_def:
    # nudge into a single piece
    for _ in range(60):
        o = owner([(x - 9, z - 9), (x + 9, z - 9), (x + 9, z + 9), (x - 9, z + 9)], 0.8)
        if o:
            break
        x += rng.uniform(-4, 4); z += rng.uniform(-4, 4)
    lx, lz = np.array([x, z]) - centres[o]
    mb = feat[o]
    if kind == "hall":
        box(mb, lx, lz, 16, 9, top_y, 9, C["wall"]); hip_roof(mb, lx, lz, 16, 9, top_y + 9, 4, C["roof"]); h = 13
    elif kind == "tower":
        box(mb, lx, lz, 8, 8, top_y, 13, C["wall"]); hip_roof(mb, lx, lz, 8, 8, top_y + 13, 4, C["wood"]); h = 17
    elif kind == "clock":
        box(mb, lx, lz, 4.5, 4.5, top_y, 16, C["wall"]); cone(mb, lx, lz, 3.4, top_y + 16, 4, C["dome"], seg=4); h = 20
    else:
        box(mb, lx, lz, 10, 10, top_y, 6, C["wall"]); hip_roof(mb, lx, lz, 10, 10, top_y + 6, 3.2, C["dome"])
        mx, mz = lx + 6.5, lz - 6.5
        cylinder(mb, mx, mz, 1.0, top_y, 15, C["wall"]); cone(mb, mx, mz, 1.15, top_y + 15, 3.5, C["dome"], seg=8); h = 18.5
    taken.append((x, z, 12))
    landmarks.append({"id": lid, "name": {"me": me, "en": en}, "pos": [round(x, 1), round(top_y + FLOOR_Y + h, 1), round(z, 1)], "piece": o})


def free(x, z, r):
    for tx, tz, tr in taken:
        if (x - tx) ** 2 + (z - tz) ** 2 < (r + tr) ** 2:
            return False
    return True


# houses: dense in the middle
n_house = 0
for _ in range(4000):
    if n_house >= 260:
        break
    x, z = rng.normal(0, 48, 2)
    if abs(x) > 128 or abs(z) > 128:
        continue
    w, d = rng.uniform(4.5, 7.5), rng.uniform(4, 6)
    rot = rng.uniform(0, math.pi)
    r = math.hypot(w, d) / 2 + 0.8
    if not free(x, z, r):
        continue
    if dist_to(RIVER, [(x, z)])[0] < r + 4 or min(dist_to(rd, [(x, z)])[0] for rd in ROADS) < r + 2:
        continue
    o = owner([(x + r * math.cos(a), z + r * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 8, endpoint=False)], 0.6)
    if o is None:
        continue
    lx, lz = np.array([x, z]) - centres[o]
    hh = rng.choice([3.0, 3.0, 4.5, 6.0])
    box(feat[o], lx, lz, w, d, top_y, hh, C["wall"], rot)
    hip_roof(feat[o], lx, lz, w, d, top_y + hh, 2.4, C["roof"], rot)
    taken.append((x, z, r)); n_house += 1

# trees: outer ring and along the river
n_tree = 0
for _ in range(20000):
    if n_tree >= 900:
        break
    x, z = rng.uniform(-133, 133, 2)
    rad = math.hypot(x, z)
    near_river = dist_to(RIVER, [(x, z)])[0]
    if rad < 75 and not (6 < near_river < 12):
        continue
    if near_river < 5.5 or min(dist_to(rd, [(x, z)])[0] for rd in ROADS) < 3.5:
        continue
    r = rng.uniform(1.4, 2.3)
    if not free(x, z, r):
        continue
    o = owner([(x + r * math.cos(a), z + r * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 6, endpoint=False)], 0.4)
    if o is None:
        continue
    lx, lz = np.array([x, z]) - centres[o]
    shade = np.array(C["tree"]) * rng.uniform(0.85, 1.15)
    cone(feat[o], lx, lz, r, top_y, rng.uniform(4.5, 8), tuple(shade), seg=6)
    taken.append((x, z, r * 0.8)); n_tree += 1

g = GLB()
for j in range(ROWS):
    for i in range(COLS):
        code = "ABCDEFGH"[i] + str(j + 1)
        loc = polys[code] - centres[code]
        mb = MeshBuilder()
        slab(mb, loc, 0.0, BASE, C["grass"], C["side"])
        mb.extend(feat[code])
        P, N, Cc, I, F = mb.arrays()
        g.add(code, P, N, Cc, I, translation=(centres[code][0], FLOOR_Y, centres[code][1]), fx=F)
        pieces.append({"code": code, "pos": [round(float(centres[code][0]), 2), round(float(centres[code][1]), 2)],
                       "outline": np.round(loc, 2).tolist(), "edge": i in (0, COLS - 1) or j in (0, ROWS - 1),
                       "height": round(float(P[:, 1].max()), 2)})
size = g.save(os.path.join(OUT, "pieces.glb"))

# tray: floor + rim ring
t = MeshBuilder()
h = TRAY / 2
slab(t, [(-h, -h), (h, -h), (h, h), (-h, h)], 0.0, FLOOR_Y, C["tray"], C["trayside"])
for (x0, z0, x1, z1) in [(-h, -h, h, -INNER), (-h, INNER, h, h), (-h, -INNER, -INNER, INNER), (INNER, -INNER, h, INNER)]:
    slab(t, [(x0, z0), (x1, z0), (x1, z1), (x0, z1)], FLOOR_Y, RIM_Y, C["tray"], C["trayside"], bottom=False)
P, N, Cc, I, F = t.arrays()
gt = GLB()
gt.add("tray", P, N, Cc, I)
gt.save(os.path.join(OUT, "tray.glb"))

meta = {"version": 1, "standin": True, "units": "mm",
        "title": {"me": "Slagalica Gusinje", "en": "Gusinje Puzzle"},
        "tray": {"size": [TRAY, TRAY], "inner": [-INNER, -INNER, INNER, INNER], "floorY": FLOOR_Y, "rimY": RIM_Y},
        "grid": {"cols": COLS, "rows": ROWS},
        "pieces": pieces, "landmarks": landmarks}
with open(os.path.join(OUT, "puzzle.json"), "w") as f:
    json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
print(f"pieces.glb {size/1e6:.2f} MB, {n_house} houses, {n_tree} trees, {len(landmarks)} landmarks")
