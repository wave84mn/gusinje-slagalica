"""Find where each printed piece sits in the tray.

The pieces project stores every piece centred on its own bounding box (they were packed
onto print plates), so their assembled positions are recovered by matching each piece's
outline against the cut lines engraved in the tray floor.

usage: python3 tools/locate.py <pieces.3mf> <tray.3mf> <out.json> [debug dir]
Coordinates: 3MF millimetres, X east, Y north, tray centre at the origin.
"""
import json, os, pickle, re, sys
import numpy as np
import cv2

POCKET = 276.2 / 2          # tray pocket half-size (README: 276.2 mm square)
CELL = 2 * POCKET / 8


def fill(img, tris_xy, to_px):
    pts = to_px(tris_xy)
    cv2.fillPoly(img, [np.round(p * 16).astype(np.int32) for p in pts], 255, lineType=cv2.LINE_8, shift=4)


def engraving(tray, res):
    P = tray["parts"][0]
    T = P["V"][P["F"]]
    zmax, zmin = T[:, :, 2].max(1), T[:, :, 2].min(1)
    c = T[:, :, :2].mean(1)
    inside = (np.abs(c) < POCKET).all(1)
    deep = inside & (np.abs(zmax - 1.6) < 0.01) & (np.abs(zmin - 1.6) < 0.01)
    N = int(round(2 * POCKET / res))
    img = np.zeros((N, N), np.uint8)
    fill(img, T[deep][:, :, :2], lambda p: np.stack([(p[..., 0] + POCKET) / res, N - (p[..., 1] + POCKET) / res], -1))
    return img


def bottom(piece):
    """Bottom-face triangles of the terrain (they tile the footprint without overlapping;
    fillPoly treats overlapping polygons even-odd, so the full mesh can't be used)."""
    T = np.concatenate([p["V"][p["F"]] for p in piece["parts"] if p["part"]["name"] == "Terrain"])
    return T[T[:, :, 2].max(1) < 0.01]


def rot90(xy, k):
    """Rotate (x, y) by k quarter turns counter-clockwise (seen from above)."""
    x, y = xy[..., 0], xy[..., 1]
    for _ in range(k % 4):
        x, y = -y, x
    return np.stack([x, y], -1)


def footprint(piece, res, pad_mm=2.0, k=0):
    """Mask of the piece seen from above, in a local raster centred on the piece origin."""
    T = bottom(piece)
    xy = rot90(T[:, :, :2], k)
    half = np.abs(xy).max() + pad_mm
    N = int(np.ceil(2 * half / res))
    img = np.zeros((N, N), np.uint8)
    fill(img, xy, lambda p: np.stack([(p[..., 0] + half) / res, N - (p[..., 1] + half) / res], -1))
    return img, half


def outline_template(mask, res, groove_px):
    """Outline pushed out by the 0.1 mm set-back, so it lies on the cut line, drawn as a groove."""
    k = max(1, int(round(0.1 / res)))
    m = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1)))
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cs, key=cv2.contourArea)
    t = np.zeros_like(mask, dtype=np.float32)
    cv2.polylines(t, [c], True, 1.0, thickness=max(1, groove_px), lineType=cv2.LINE_AA)
    return t


def locate(engr, mask, half, guess, res, win_mm, groove_px):
    """Return the piece origin (X, Y) in tray mm that best lines up the outline with the cut lines."""
    N = engr.shape[0]
    tpl = outline_template(mask, res, groove_px)
    th, tw = tpl.shape
    # pixel position of the template's top-left for a piece origin at (X, Y)
    def tl(X, Y):
        return (X - half + POCKET) / res, N - (Y + half + POCKET) / res
    gx, gy = tl(*guess)
    w = int(np.ceil(win_mm / res))
    x0, y0 = int(np.floor(gx)) - w, int(np.floor(gy)) - w
    # pad the engraving so windows at the edge still work
    pad = th + 2 * w + 4
    E = cv2.copyMakeBorder(engr, pad, pad, pad, pad, cv2.BORDER_CONSTANT, 0).astype(np.float32) / 255.0
    region = E[y0 + pad: y0 + pad + th + 2 * w, x0 + pad: x0 + pad + tw + 2 * w]
    score = cv2.matchTemplate(region, tpl, cv2.TM_CCORR)
    _, best, _, loc = cv2.minMaxLoc(score)
    # sub-pixel peak by fitting a parabola in each direction
    px, py = loc
    def refine(a, b, c):
        d = a - 2 * b + c
        return 0.0 if abs(d) < 1e-9 else 0.5 * (a - c) / d
    sx = refine(score[py, px - 1], score[py, px], score[py, px + 1]) if 0 < px < score.shape[1] - 1 else 0
    sy = refine(score[py - 1, px], score[py, px], score[py + 1, px]) if 0 < py < score.shape[0] - 1 else 0
    tlx, tly = x0 + px + sx, y0 + py + sy
    X = tlx * res + half - POCKET
    Y = (N - tly) * res - half - POCKET
    return (X, Y), best / max(tpl.sum(), 1e-9)


def main(pieces_3mf, tray_3mf, out, dbg=None):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from read3mf import read_project
    pieces, tray = read_project(pieces_3mf), read_project(tray_3mf)[0]
    coarse_res, fine_res = 0.2, 0.04
    e_coarse = engraving(tray, coarse_res)
    e_fine = engraving(tray, fine_res)
    # groove width: measure from the fine engraving (thickness of the cut lines)
    dist = cv2.distanceTransform((e_fine > 0).astype(np.uint8), cv2.DIST_L2, 5)
    groove_mm = float(np.percentile(dist[dist > 0], 90)) * 2 * fine_res
    print(f"cut-line groove about {groove_mm:.2f} mm wide")
    result = {}
    for pc in pieces:
        code = re.search(r"([A-H][1-8])", pc["name"]).group(1)
        i, j = "ABCDEFGH".index(code[0]), int(code[1]) - 1
        guess = (-POCKET + CELL * (i + 0.5), POCKET - CELL * (j + 0.5))
        best = None
        # the plate packer may have turned pieces by quarter turns: try all four
        for k in range(4):
            mc, hc = footprint(pc, coarse_res, k=k)
            (X, Y), s1 = locate(e_coarse, mc, hc, guess, coarse_res, 11.0, max(1, int(round(groove_mm / coarse_res))))
            if best is None or s1 > best[0]:
                best = (s1, k, X, Y)
        s1, k, X, Y = best
        mf, hf = footprint(pc, fine_res, k=k)
        (X2, Y2), s2 = locate(e_fine, mf, hf, (X, Y), fine_res, 0.8, max(1, int(round(groove_mm / fine_res))))
        result[code] = {"x": round(float(X2), 3), "y": round(float(Y2), 3), "rot": k, "score": round(float(s2), 3),
                        "coarse_shift": [round(float(X2 - X), 3), round(float(Y2 - Y), 3)]}
        print(code, result[code])
    json.dump(result, open(out, "w"), indent=1)

    # check: paint all footprints at their found places
    res = 0.1
    N = int(round(2 * POCKET / res)) + 40
    count = np.zeros((N, N), np.uint8)
    for pc in pieces:
        code = re.search(r"([A-H][1-8])", pc["name"]).group(1)
        X, Y = result[code]["x"], result[code]["y"]
        T = rot90(bottom(pc)[:, :, :2], result[code]["rot"])
        m = np.zeros((N, N), np.uint8)
        fill(m, T + np.array([X, Y]), lambda p: np.stack([(p[..., 0] + POCKET) / res + 20, N - 20 - (p[..., 1] + POCKET) / res], -1))
        count += (m > 0)
    inner = count[20:-20, 20:-20]
    overlap = (count > 1).sum() * res * res
    gaps = (inner == 0).sum() * res * res
    print(f"overlap {overlap:.1f} mm2, uncovered {gaps:.1f} mm2 of {(2 * POCKET) ** 2:.0f} mm2 "
          f"(expected gaps: ~{0.2 * 276.2 * 14 + 0.1 * 276.2 * 4:.0f} mm2 of cut lines)")
    if dbg:
        os.makedirs(dbg, exist_ok=True)
        vis = np.full((N, N, 3), 255, np.uint8)
        vis[count == 1] = (120, 190, 110)
        vis[count > 1] = (0, 0, 255)
        cv2.imwrite(os.path.join(dbg, "placed.png"), cv2.resize(vis, (1100, 1100), interpolation=cv2.INTER_AREA))


if __name__ == "__main__":
    main(*sys.argv[1:])
