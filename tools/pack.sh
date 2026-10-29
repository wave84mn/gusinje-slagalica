#!/bin/sh
# Compress raw GLBs for phones (meshopt + quantization) and copy them into data/.
# usage: tools/pack.sh <raw dir>   (needs gltfpack from github.com/zeux/meshoptimizer)
set -e
RAW=${1:-build/raw}
GLTFPACK=${GLTFPACK:-gltfpack}
mkdir -p data
for f in pieces tray; do
  "$GLTFPACK" -i "$RAW/$f.glb" -o "data/$f.glb" -cc -kn
done
cp "$RAW/puzzle.json" data/puzzle.json
python3 tools/build_sw.py
ls -la data
