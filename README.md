# Slagalica Gusinje

The 3D-printed Gusinje jigsaw (64 pieces in a 300 × 300 mm tray), played on a phone with fingers. It runs in the browser, needs no install, and works offline once opened.

**Play:** https://wave84mn.github.io/gusinje-slagalica/

**QR codes** (the Xplore Prokletije logo in the middle), in `qr/`: `slagalica_android.png` is the phone card (TELEFON · iPhone · Android) and `slagalica_windows.png` the Windows card; both open the game in any browser. The phone card keeps its old link (`?p=android`, which used to send Android phones to Chrome for AR and is now just dropped from the address), so cards printed before still work; and `slagalica_qr_print.pdf` has both on one A4 page (cards 9 cm wide). Rebuild with `python3 tools/make_qr.py && node tools/qr_render.cjs && python3 tools/make_qr.py --check` (the last step reads every code back, also small, blurred, turned and in dim light).

**Logo**: `source/brand/xplore_prokletije.png` is the project logo. `python3 tools/logo_trace.py` turns it into vector shapes without the background (`source/brand/xplore_parts.json`) and puts it on the start screen, where it takes the game's colours (cream tower, ochre squares and lettering); the QR cards use the same shapes in their ink and ochre.

## How to play
- Drag a piece up out of the drawer and drop it in its place. It snaps in when it's close.
- Pinch to zoom, one or two fingers to move, both fingers up or down to tilt. Double tap zooms.
- Every level has the guide map and piece codes on the tray, like the printed one; they differ in how much is done already. **Lako**: 70% of the pieces are in (45 of 64). **Srednje**: 30% (19). **Teško**: none. The pieces already in are picked at random, but the landmark pieces are always left for the player. Games and best times saved before this change carry on as Teško.
- The bulb shows where one piece goes; the picture button shows the finished map.
- Progress is saved on the phone. When the puzzle is done you can look around the town and tap the landmark names.
- Placing a piece with a landmark briefly shows its name.
- Turn the tray with a two-finger twist or the side buttons (zoom in/out, quarter turn, compass for north up).
- **AR on your own table**, on any phone (iPhone Safari and Chrome; Android Chrome, Samsung Internet, Firefox), nothing to install: tap **AR** in the game and allow the camera (on iPhone also motion). The tray hovers where the middle of the screen points at the table, with brackets showing its size; tap (or **Set it down here**) and it drops onto the table with its shadow. Turn and tilt the phone and the tray stays put on the table. Play from the drawer as usual; a piece held under a still finger follows as the phone turns. One finger on the empty table slides the tray, two fingers pinch to resize and twist to turn it. **Table** / **Floor**: the surface is taken to be 42 cm or 1.3 m below the phone, with a 30 cm or 1 m tray. **Freeze** keeps the picture still so you can lower your arms and keep playing; **Camera** brings it back. **Move** picks a new spot. An arrow at the screen edge points to the tray when it is out of view. The model's light follows the brightness and colour of the camera picture.
  - How it works: the rear camera's picture fills the screen behind the transparent three.js view, and the phone's motion sensors (`deviceorientation`) turn the 3D camera with the phone. A web page can follow the phone *turning* but not *moving*, so walking around the tray doesn't work (WebXR, which can, only runs in Chrome on Android phones with Google Play Services for AR); pinch to make it bigger instead. The camera's field of view is taken as 66° across the long side of its picture (most phones' main cameras: 63–72°); `?fov=70` tries another value.
  - Phones without motion sensors, or where motion is refused: the tray stays fixed on the screen and the fingers move it; a note says so (on iPhone, how to allow motion). If the camera is refused, missing or busy, the game says why and what to do.
- Sounds: pick up, put down, knobs clicking into neighbours (higher with more neighbours), victory fanfare. All synthesized; the menu turns them off.
- Languages: Montenegrin/Bosnian, Albanian and English (ME / SQ / EN on the start screen and in the menu). On a first visit it starts in the phone's language: Albanian phones in SQ, English-only phones in EN, others in ME. The choice is remembered.

## Files
- `index.html`, `css/`, `js/`: the game (three.js r184, MIT, in `js/vendor/three`). `js/ar.js` is the camera AR.
- `data/pieces.glb`: the 64 pieces, one node each, named by code (A–H west to east, 1–8 north to south) and placed at its spot in the tray. Millimetres, Y up, -Z north. Vertex colours (alpha 128 marks water), no normals (flat shading), meshopt-compressed.
- `data/tray.glb`: the tray with its rim labels; the engraved floor is replaced by a plain floor, and the game draws the guide itself on Lako.
- `data/puzzle.json`: tray size, piece outlines and positions, guide colours, landmarks.
- `sw.js`: offline cache, generated by `tools/build_sw.py`. A new version downloads its files straight from the server (not the browser's cache, which GitHub Pages lets keep the old files 10 minutes). The game looks for an update each time it comes back on screen and on the start screen. If a game was started on the old version and no piece has been touched yet, it starts again on the new one, same level; a game under way gets a short note and switches on the start screen.
- `source/`: the print files the game is made from (Bambu Studio projects and their README).

## Rebuilding the data from the print files
`tools/build_real.sh` runs the three steps:
1. `tools/locate.py` finds where each piece belongs. The print project stores pieces centred and some turned by quarter turns (for packing the plates), so each piece's outline is matched against the cut lines engraved in the tray floor. Result: `tools/positions.json`.
2. `tools/convert.py` simplifies the meshes (1.76 M → 0.27 M triangles; outlines move less than 0.12 mm), drops the never-seen undersides, and writes the GLBs and `puzzle.json`. Landmark names and spots are in `tools/landmarks.json`.
3. `tools/pack.sh` compresses with gltfpack and refreshes `sw.js`.

Tools needed: Python 3 with numpy, opencv and lxml; `gltfpack` and the meshoptimizer library (github.com/zeux/meshoptimizer); `tools/simplify` built with
`g++ -O2 -std=c++17 -I<meshoptimizer>/src tools/simplify/simplify.cpp <meshoptimizer>/src/*.cpp -o simplify`.

On screen the filament colours are slightly softened (`SCREEN` in `tools/convert.py`); set it to `PETG` for the exact print colours.

## Checks
- `tests/play.cjs <url>`: plays the game in a phone-size Chromium with real touch events (drag, wrong drop, pinch, pan, tilt, hint, resume, finish, labels, the three levels, old saves, English).
- `tests/look.cjs <url>`: screenshots of the main screens.
- `tests/ar_cam.cjs <url> [screenshot dir]`: AR in a phone-size Chromium with a fake camera filming a wooden table (`tests/fake_camera.py` writes `build/table.y4m`) and played motion sensors: the iPhone motion permission asked inside the tap, field of view, hovering and the tilt hint, setting the tray down, the tray staying put while the phone turns and tilts, dragging a piece in (also while the phone turns), slide / pinch / twist, Freeze, the edge arrow, light from the camera, Floor, finishing with labels, Exit, no sensors, motion refused, camera refused / missing / busy. Not tested: real Safari (WebKit can't be installed here) and real phone sensors.
- `tests/sfx.cjs <url> <wav>`: renders the sound effects, checks levels, writes a preview.
- `tests/lang.cjs <url>`: the three languages, the phone-language start and the Albanian landmark names.
- `tests/update/run.sh [old commit]`: updates over HTTPS with the offline cache on, as on GitHub Pages: from the old commit to this folder (new files, Easy has 45 in), an untouched game restarting on the next version, a game under way kept, and the app coming back from the background.
- `tests/qr_link.cjs <url>`: the QR links: every browser (Samsung Internet, Firefox, Chrome, in-app, iPhone, Windows) stays put and the tag is dropped.
- `tools/standin.py`: the stand-in pieces used before the real files arrived.

Map data © OpenStreetMap contributors (ODbL). Terrain: Copernicus DEM.
