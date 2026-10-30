"""Convert the printed Gusinje puzzle (Bambu Studio 3MF projects) into the game's data.

usage: python3 tools/convert.py <pieces.3mf> <tray.3mf> <positions.json> <out dir> [landmarks.json]
  positions.json comes from tools/locate.py (where each piece sits in the tray, and its quarter turn).
  Needs the `simplify` tool (tools/simplify) on PATH or in $SIMPLIFY.

Writes <out>/pieces.glb, <out>/tray.glb and <out>/puzzle.json in the game's format:
millimetres, Y up, X east, -Z north, tray centre at the origin.
"""
import json, os, re, struct, subprocess, sys
import numpy as np
import cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from read3mf import read_project
from glb import GLB
import locate as L

SIMPLIFY = os.environ.get("SIMPLIFY", "simplify")
FLOOR = 2.0                     # tray floor thickness: pieces stand on it
POCKET = L.POCKET

# filament slot -> colour (Gusinje_puzzle_README.md)
PETG = {1: "#00AE42", 2: "#39541A", 3: "#ADB1B2", 4: "#1F79E5", 5: "#FFFFFF", 6: "#BC0900", 7: "#875718"}
# on screen the same colours, slightly softened so the lit model doesn't look neon (set SCREEN = PETG for exact)
SCREEN = {1: "#2FA457", 2: "#36561F", 3: "#B2B5B3", 4: "#2A7DD8", 5: "#F5F2EA", 6: "#B9281E", 7: "#8A5A22"}
SLOT = SCREEN
# how far each kind of part may move when simplified (mm)
ERROR = {"Terrain": 0.12, "Roads": 0.05, "Water": 0.15, "Trees": 0.16, "House roofs": 0.03,
         "House walls": 0.02, "Tombstones": 0.0, "Tray": 0.03}


def hex2rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def simplify(V, F, err, lock_border=True):
    if err <= 0 or len(F) < 64:
        return F
    V32 = np.ascontiguousarray(V, np.float32)
    I32 = np.ascontiguousarray(F.reshape(-1), np.uint32)
    hdr = struct.pack("<IIffI", len(V32), len(I32), 0.0, float(err), 1 if lock_border else 0)
    out = subprocess.run([SIMPLIFY], input=hdr + V32.tobytes() + I32.tobytes(), capture_output=True, check=True).stdout
    n = struct.unpack("<I", out[:4])[0]
    return np.frombuffer(out[8:8 + 4 * n], np.uint32).reshape(-1, 3).astype(np.int64)


def compact(V, F):
    used, inv = np.unique(F.reshape(-1), return_inverse=True)
    return V[used], inv.reshape(-1, 3)


def to_game(V):
    """3MF (X east, Y north, Z up) -> game (x east, y up, z south)."""
    return np.stack([V[:, 0], V[:, 2], -V[:, 1]], 1)


def piece_mesh(pc, k):
    P, C, I = [], [], []
    stats = {}
    base = 0
    for part in pc["parts"]:
        name, slot = part["part"]["name"], part["part"]["extruder"]
        V, F = part["V"].copy(), part["F"]
        V[:, :2] = L.rot90(V[:, :2], k)
        if name == "Terrain":
            # the underside and its engraved code are never seen in the game
            keep = V[F][:, :, 2].max(1) > 0.41
            F = F[keep]
        n0 = len(F)
        # the terrain's open bottom edge is never seen, so it may move too
        F = simplify(V, F, ERROR.get(name, 0.03), lock_border=name != "Terrain")
        V, F = compact(V, F)
        stats[name] = stats.get(name, 0) + len(F)
        col = np.tile(hex2rgb(SLOT.get(slot, "#FF00FF")), (len(V), 1))
        P.append(to_game(V)); C.append(col); I.append(F + base)
        fx = np.full(len(V), 1.0 if name == "Water" else 0.0)
        C[-1] = np.concatenate([col, fx[:, None]], 1)
        base += len(V)
    P, C, I = np.concatenate(P), np.concatenate(C), np.concatenate(I)
    return P, C, I, stats


def outline(pc, k, res=0.04):
    """The piece's cut line (outline pushed out by the 0.1 mm set-back), in game coords local to the piece."""
    mask, half = L.footprint(pc, res, k=k)
    r = max(1, int(round(0.1 / res)))
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cs, key=cv2.contourArea)
    c = cv2.approxPolyDP(c, 0.03 / res, True)[:, 0, :].astype(float)
    x = c[:, 0] * res - half
    y = half - c[:, 1] * res
    return np.stack([x, -y], 1)          # game (x, z)


def tray_mesh(tray):
    P, C, I = [], [], []
    base = 0
    stats = {}
    for part in tray["parts"]:
        name, slot = part["part"]["name"], part["part"]["extruder"]
        V, F = part["V"], part["F"]
        T = V[F]
        zmax = T[:, :, 2].max(1)
        cen = T[:, :, :2].mean(1)
        drop = zmax < 0.01                                          # underside
        if name == "Tray":
            # the engraved guide map is replaced by a plain floor (the game draws its own guide)
            drop |= (np.abs(cen) < POCKET - 0.01).all(1) & (zmax <= FLOOR + 0.001)
        F = F[~drop]
        F = simplify(V, F, ERROR.get(name, 0.03) if name == "Tray" else 0.0)
        V2, F = compact(V, F)
        if name == "Tray":
            h = POCKET
            fl = np.array([[-h, -h, FLOOR], [h, -h, FLOOR], [h, h, FLOOR], [-h, h, FLOOR]])
            F = np.concatenate([F, np.array([[0, 1, 2], [0, 2, 3]]) + len(V2)])
            V2 = np.concatenate([V2, fl])
        stats[name] = len(F)
        col = np.concatenate([np.tile(hex2rgb(SLOT.get(slot, "#FF00FF")), (len(V2), 1)), np.zeros((len(V2), 1))], 1)
        P.append(to_game(V2)); C.append(col); I.append(F + base)
        base += len(V2)
    return np.concatenate(P), np.concatenate(C), np.concatenate(I), stats


def main(pieces_3mf, tray_3mf, positions, out, landmarks=None):
    os.makedirs(out, exist_ok=True)
    pos = json.load(open(positions))
    pieces = read_project(pieces_3mf)
    tray = read_project(tray_3mf)[0]
    g = GLB()
    meta_pieces, total = [], {}
    order = sorted(pieces, key=lambda p: (int(re.search(r"[A-H]([1-8])", p["name"]).group(1)), re.search(r"([A-H])[1-8]", p["name"]).group(1)))
    for pc in order:
        code = re.search(r"([A-H][1-8])", pc["name"]).group(1)
        p = pos[code]
        k, X, Y = p["rot"], p["x"], p["y"]
        P, C, I, stats = piece_mesh(pc, k)
        for a, b in stats.items():
            total[a] = total.get(a, 0) + b
        g.add(code, P, None, C[:, :3], I, translation=(X, FLOOR, -Y), fx=C[:, 3])
        ol = outline(pc, k)
        meta_pieces.append({"code": code, "pos": [round(X, 3), round(-Y, 3)], "outline": np.round(ol, 2).tolist(),
                            "edge": code[0] in "AH" or code[1] in "18", "height": round(float(P[:, 1].max()), 2)})
        print(code, sum(stats.values()), "triangles")
    size = g.save(os.path.join(out, "pieces.glb"))
    print("pieces:", sum(total.values()), "triangles", total, f"{size / 1e6:.1f} MB raw")

    P, C, I, ts = tray_mesh(tray)
    gt = GLB()
    gt.add("tray", P, None, C[:, :3], I)
    gt.save(os.path.join(out, "tray.glb"))
    print("tray:", ts)

    meta = {"version": 1, "id": "gusinje-64-v1", "units": "mm",
            "title": {"me": "Slagalica Gusinje", "sq": "Bashko Gucinë", "en": "Gusinje Puzzle"},
            "tray": {"size": [300, 300], "inner": [-POCKET, -POCKET, POCKET, POCKET], "floorY": FLOOR, "rimY": 15.9},
            "guide": {"line": "rgba(255,240,218,0.82)", "text": "rgba(255,240,218,0.7)"},
            "grid": {"cols": 8, "rows": 8},
            "pieces": meta_pieces,
            "landmarks": json.load(open(landmarks)) if landmarks else []}
    json.dump(meta, open(os.path.join(out, "puzzle.json"), "w"), ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main(*sys.argv[1:])
