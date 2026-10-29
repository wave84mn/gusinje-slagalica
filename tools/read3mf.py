"""Read Bambu Studio 3MF projects: objects, parts (with names and extruders), meshes."""
import re, zipfile
import numpy as np
from lxml import etree

NS = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02",
      "p": "http://schemas.microsoft.com/3dmanufacturing/production/2015/06"}
VERT = re.compile(rb'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"')
TRI = re.compile(rb'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"')


def mesh_objects(data):
    """Parse an object .model file -> {objectid: (V, F)} using fast regex per <object> block."""
    out = {}
    for m in re.finditer(rb'<object id="(\d+)"(.*?)</object>', data, re.S):
        oid = int(m.group(1))
        body = m.group(2)
        V = np.array(VERT.findall(body), dtype=np.float64)
        F = np.array(TRI.findall(body), dtype=np.int64)
        out[oid] = (V.reshape(-1, 3), F.reshape(-1, 3))
    return out


def read_project(path):
    z = zipfile.ZipFile(path)
    root = etree.fromstring(z.read("3D/3dmodel.model"))
    settings = etree.fromstring(z.read("Metadata/model_settings.config"))
    names, parts = {}, {}
    for o in settings.findall("object"):
        oid = int(o.get("id"))
        md = {e.get("key"): e.get("value") for e in o.findall("metadata") if e.get("key")}
        names[oid] = md.get("name", str(oid))
        for p in o.findall("part"):
            pm = {e.get("key"): e.get("value") for e in p.findall("metadata") if e.get("key")}
            parts[int(p.get("id"))] = {"name": pm.get("name", ""), "extruder": int(pm.get("extruder", md.get("extruder", "1")))}
    cache = {}
    objects = []
    builds = {int(it.get("objectid")): it.get("transform") for it in root.find("m:build", NS).findall("m:item", NS)}
    for obj in root.find("m:resources", NS).findall("m:object", NS):
        oid = int(obj.get("id"))
        comps = []
        for c in obj.findall("m:components/m:component", NS):
            path_ = c.get("{%s}path" % NS["p"]).lstrip("/")
            if path_ not in cache:
                cache[path_] = mesh_objects(z.read(path_))
            sub = int(c.get("objectid"))
            V, F = cache[path_][sub]
            T = [float(x) for x in c.get("transform", "1 0 0 0 1 0 0 0 1 0 0 0").split()]
            M = np.array(T[:9]).reshape(3, 3)
            V = V @ M + np.array(T[9:12])
            comps.append({"part": parts.get(sub, {"name": "", "extruder": 1}), "V": V, "F": F})
        bt = [float(x) for x in (builds.get(oid) or "1 0 0 0 1 0 0 0 1 0 0 0").split()]
        objects.append({"id": oid, "name": names.get(oid, str(oid)), "parts": comps, "build": bt})
    return objects
