"""Minimal GLB writer: one primitive per node, vertex colours (alpha 128 marks water).

Coordinates: metres are NOT assumed. The game works in millimetres, Y up,
X = east, -Z = north, board centre at the origin.
"""
import json, struct
import numpy as np


def srgb2lin(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.views, self.accs, self.meshes, self.nodes = [], [], [], []
        self.materials = [{"name": "matte", "pbrMetallicRoughness": {
            "baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 0.85}}]

    def _view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin += b"\0"
        off = len(self.bin)
        self.bin += data
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        self.views.append(v)
        return len(self.views) - 1

    def _acc(self, arr, ctype, typ, normalized=False, target=34962, minmax=False):
        view = self._view(arr.tobytes(), target)
        a = {"bufferView": view, "componentType": ctype, "count": int(arr.shape[0]), "type": typ}
        if normalized:
            a["normalized"] = True
        if minmax:
            a["min"] = arr.min(axis=0).astype(float).tolist()
            a["max"] = arr.max(axis=0).astype(float).tolist()
        self.accs.append(a)
        return len(self.accs) - 1

    def add(self, name, pos, nrm, col, idx, translation=(0, 0, 0), fx=None, extras=None):
        """pos/nrm: (n,3) float (nrm may be None); col: (n,3) sRGB 0..1; idx: (m,3) or (k,) int."""
        pos = np.ascontiguousarray(pos, dtype=np.float32)
        lin = srgb2lin(np.clip(col, 0, 1))
        c8 = np.ascontiguousarray(np.round(lin * 255), dtype=np.uint8)
        # alpha carries the water flag (survives mesh compression): 255 = normal, 128 = water
        alpha = np.full((len(c8), 1), 255, np.uint8)
        if fx is not None:
            alpha[np.asarray(fx).reshape(-1) > 0.5] = 128
        c8 = np.concatenate([c8, alpha], axis=1)
        idx = np.ascontiguousarray(np.asarray(idx).reshape(-1), dtype=np.uint32)
        attrs = {"POSITION": self._acc(pos, 5126, "VEC3", minmax=True)}
        if nrm is not None:   # without normals the game shades faces flat
            attrs["NORMAL"] = self._acc(np.ascontiguousarray(nrm, dtype=np.float32), 5126, "VEC3")
        attrs["COLOR_0"] = self._acc(c8, 5121, "VEC4", normalized=True)
        ia = self._acc(idx, 5125, "SCALAR", target=34963)
        self.meshes.append({"name": name, "primitives": [{"attributes": attrs, "indices": ia, "material": 0}]})
        node = {"name": name, "mesh": len(self.meshes) - 1}
        if any(abs(t) > 1e-9 for t in translation):
            node["translation"] = [float(t) for t in translation]
        if extras:
            node["extras"] = extras
        self.nodes.append(node)

    def save(self, path, scene_extras=None):
        while len(self.bin) % 4:
            self.bin += b"\0"
        scene = {"nodes": list(range(len(self.nodes)))}
        if scene_extras:
            scene["extras"] = scene_extras
        gltf = {"asset": {"version": "2.0", "generator": "slagalica tools"},
                "scene": 0, "scenes": [scene], "nodes": self.nodes, "meshes": self.meshes,
                "materials": self.materials, "accessors": self.accs, "bufferViews": self.views,
                "buffers": [{"byteLength": len(self.bin)}]}
        js = json.dumps(gltf, separators=(",", ":")).encode()
        while len(js) % 4:
            js += b" "
        out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(self.bin))
        out += struct.pack("<I4s", len(js), b"JSON") + js
        out += struct.pack("<I4s", len(self.bin), b"BIN\0") + bytes(self.bin)
        with open(path, "wb") as f:
            f.write(out)
        return len(out)


class MeshBuilder:
    """Accumulates flat-shaded triangles with per-face colour and fx flag."""

    def __init__(self):
        self.P, self.N, self.C, self.F = [], [], [], []

    def tri(self, a, b, c, col, fx=0.0):
        a, b, c = map(np.asarray, (a, b, c))
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n)
        if ln < 1e-12:
            return
        n = n / ln
        for p in (a, b, c):
            self.P.append(p); self.N.append(n); self.C.append(col); self.F.append(fx)

    def quad(self, a, b, c, d, col, fx=0.0):
        self.tri(a, b, c, col, fx); self.tri(a, c, d, col, fx)

    def extend(self, other):
        self.P += other.P; self.N += other.N; self.C += other.C; self.F += other.F

    def arrays(self):
        P = np.array(self.P, np.float32).reshape(-1, 3)
        N = np.array(self.N, np.float32).reshape(-1, 3)
        C = np.array(self.C, np.float32).reshape(-1, 3)
        F = np.array(self.F, np.float32)
        I = np.arange(len(P), dtype=np.uint32)
        return P, N, C, I, F
