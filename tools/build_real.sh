#!/bin/sh
# Rebuild the game data from the print files in source/.
# Needs: python3 with numpy, opencv, lxml; gltfpack and the simplify tool (tools/simplify), see README.
set -e
S=source
mkdir -p build/raw_real
python3 tools/locate.py "$S/Gusinje_puzzle_64_pieces_PETG-HF_H2C.3mf" "$S/Gusinje_puzzle_tray_PETG-HF_H2C.3mf" tools/positions.json build/locate
python3 tools/convert.py "$S/Gusinje_puzzle_64_pieces_PETG-HF_H2C.3mf" "$S/Gusinje_puzzle_tray_PETG-HF_H2C.3mf" tools/positions.json build/raw_real tools/landmarks.json
tools/pack.sh build/raw_real
