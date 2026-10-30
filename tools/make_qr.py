"""QR cards for the game: one for Android phones (opens the game in Chrome, ready for AR) and one
for Windows. Xplore Prokletije sits in the middle of each code; the game's name and the platform
are written underneath. Writes build/qr/*.html; tools/qr_render.cjs turns them into PNG and PDF,
and this script's --check reads the PNGs back.
usage: python3 tools/make_qr.py            (then node tools/qr_render.cjs, python3 tools/make_qr.py --check)"""
import os, sys, cv2, numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "qr")
BASE = "https://wave84mn.github.io/gusinje-slagalica/"
CARDS = [
    {"id": "android", "url": BASE + "?p=android", "platform": "Android", "app": "Google Chrome"},
    {"id": "windows", "url": BASE + "?p=windows", "platform": "Windows", "app": "Edge ili Chrome"},
]
INK = "#1d1a16"
OCHRE = "#c98f2c"

def matrix(text):
    p = cv2.QRCodeEncoder_Params()
    p.correction_level = cv2.QRCodeEncoder_CORRECT_LEVEL_H      # 30 %: room for the mark in the middle
    img = cv2.QRCodeEncoder.create(p).encode(text)
    dark = img < 128
    ys, xs = np.where(dark)
    return dark[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

def qr_svg(m, quiet=4):
    n = m.shape[0]
    size = n + 2 * quiet
    # the mark: a white plate over the middle (about 10 % of the code, well inside level H)
    pw, ph = 17, 11
    px, py = quiet + (n - pw) / 2, quiet + (n - ph) / 2
    m = m.copy()
    m[int(py - quiet):int(py - quiet + ph), int(px - quiet):int(px - quiet + pw)] = False   # nothing peeks out under the plate
    rects = []
    for y in range(n):
        x = 0
        while x < n:
            if m[y, x]:
                x0 = x
                while x < n and m[y, x]: x += 1
                rects.append(f'<rect x="{x0 + quiet}" y="{y + quiet}" width="{x - x0}" height="1"/>')
            else:
                x += 1
    mark = f'''
  <g transform="translate({px} {py})">
    <rect x="0" y="0" width="{pw}" height="{ph}" rx="1.6" fill="#fff"/>
    <rect x="0.55" y="0.55" width="{pw - 1.1}" height="{ph - 1.1}" rx="1.2" fill="none" stroke="{OCHRE}" stroke-width="0.32"/>
    <g transform="translate({pw / 2 - 3.1} 1.55) scale(0.155)">
      <path d="M1 19L12 5l5 6 6-9 16 17z" fill="{OCHRE}"/>
      <path d="M20.3 6l2.7-4 2.8 4.1-1.6 1.3-1.2-1.4-1.3 1.6z" fill="#fff"/>
    </g>
    <text x="{pw / 2}" y="6.75" text-anchor="middle" font-family="Inter" font-weight="800" font-size="2.15" letter-spacing="0.42" fill="{INK}">XPLORE</text>
    <text x="{pw / 2}" y="9.2" text-anchor="middle" font-family="Inter" font-weight="800" font-size="1.62" letter-spacing="0.2" fill="{INK}">PROKLETIJE</text>
  </g>'''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" shape-rendering="crispEdges">'
            f'<rect width="{size}" height="{size}" fill="#fff"/><g fill="{INK}">{"".join(rects)}</g>'
            f'<g shape-rendering="geometricPrecision">{mark}</g></svg>')

CSS = f"""
@page {{ size: A4; margin: 0; }}
* {{ box-sizing: border-box; margin: 0; }}
body {{ background: #fff; font-family: Inter, sans-serif; color: {INK}; }}
.card {{ width: 1000px; height: 1340px; background: #f7f1e5; padding: 70px 80px 0; display: flex; flex-direction: column; align-items: center; }}
.qr {{ width: 840px; height: 840px; background: #fff; border-radius: 28px; padding: 0; overflow: hidden; box-shadow: 0 0 0 3px #eadfc8; }}
.qr svg {{ width: 100%; height: 100%; display: block; }}
h1 {{ font-family: Lora, Georgia, serif; font-weight: 600; font-size: 96px; letter-spacing: 0.005em; margin-top: 56px; line-height: 1; }}
.platform {{ margin-top: 30px; display: flex; align-items: center; gap: 18px; font-size: 40px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; }}
.platform b {{ background: {INK}; color: #f7f1e5; padding: 10px 22px 10px 26px; border-radius: 14px; letter-spacing: 0.18em; }}
.platform span {{ color: {OCHRE}; letter-spacing: 0.08em; }}
.url {{ margin-top: 30px; font-size: 27px; color: #7a6d5a; letter-spacing: 0.02em; }}
/* print sheet: both cards on one A4 page, 9 cm wide each */
.sheet {{ width: 210mm; height: 297mm; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12mm; }}
.sheet .row {{ display: flex; gap: 10mm; }}
.sheet .card {{ zoom: 0.36; }}
.sheet p {{ font-size: 9pt; color: #7a6d5a; }}
"""

def card_html(c):
    m = matrix(c["url"])
    return f'''<div class="card" id="{c["id"]}">
  <div class="qr">{qr_svg(m)}</div>
  <h1>Slagalica Gusinje</h1>
  <div class="platform"><b>{c["platform"]}</b><span>{c["app"]}</span></div>
  <div class="url">wave84mn.github.io/gusinje-slagalica</div>
</div>'''

def build():
    os.makedirs(OUT, exist_ok=True)
    for c in CARDS:
        with open(os.path.join(OUT, f'{c["id"]}.html'), "w", encoding="utf-8") as f:
            f.write(f'<!doctype html><meta charset="utf-8"><style>{CSS}</style><body>{card_html(c)}</body>')
    with open(os.path.join(OUT, "sheet.html"), "w", encoding="utf-8") as f:
        f.write(f'<!doctype html><meta charset="utf-8"><style>{CSS}</style><body><div class="sheet"><div class="row">'
                + "".join(card_html(c) for c in CARDS)
                + '</div><p>Izreži po rubu kartice · širina kartice 9 cm</p></div></body>')
    print("wrote", OUT)

def check():
    det, aru = cv2.QRCodeDetector(), cv2.QRCodeDetectorAruco()
    ok = True
    for c in CARDS:
        path = os.path.join(ROOT, "qr", f'slagalica_{c["id"]}.png')
        img = cv2.imread(path)
        trials = {"full": img}
        h, w = img.shape[:2]
        trials["small 360px"] = cv2.resize(img, (360, int(360 * h / w)), interpolation=cv2.INTER_AREA)
        trials["blurred"] = cv2.GaussianBlur(cv2.resize(img, (700, int(700 * h / w))), (0, 0), 1.6)
        M = cv2.getRotationMatrix2D((w / 2, h / 2), 17, 0.8)
        trials["turned 17°"] = cv2.warpAffine(img, M, (w, h), borderValue=(255, 255, 255))
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        dst = np.float32([[w * 0.08, h * 0.05], [w * 0.95, 0], [w, h], [0, h * 0.93]])
        trials["at an angle"] = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (w, h), borderValue=(255, 255, 255))
        dim = (img.astype(np.float32) * 0.55 + 40).clip(0, 255).astype(np.uint8)
        trials["dim light"] = dim
        for name, im in trials.items():
            got = det.detectAndDecode(im)[0] or aru.detectAndDecode(im)[0]    # two different readers, like two phones
            good = got == c["url"]
            ok &= good
            print("PASS" if good else "FAIL", c["id"], name, got or "(nothing)")
    print("all QR codes read back correctly" if ok else "SOME QR CODES FAILED")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    check() if "--check" in sys.argv else build()
