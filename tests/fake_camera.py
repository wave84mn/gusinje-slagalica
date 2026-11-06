"""A pretend phone-camera picture for the AR checks: a wooden table seen from above at an angle,
with a wall behind it, a mug and a notebook. Written as a one-frame .y4m video, which Chromium can
play as its camera (--use-file-for-fake-video-capture=build/table.y4m).
usage: python3 tests/fake_camera.py [out.y4m] [width height]      (default build/table.y4m 1080 1920)"""
import os, sys
import numpy as np
import cv2

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'build', 'table.y4m')
W, H = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else (1080, 1920)
rng = np.random.default_rng(7)

# wood planks, straight on: warm brown, grain along the planks, darker seams
TW, TH = 1600, 1600
y, x = np.mgrid[0:TH, 0:TW].astype(np.float32)
plank = (x // 200).astype(int)
shade = rng.uniform(0.86, 1.08, plank.max() + 1)[plank]
noise = cv2.GaussianBlur(rng.normal(0, 1, (TH, TW)).astype(np.float32), (0, 0), sigmaX=2, sigmaY=40)
grain = 0.5 + 0.5 * np.sin(x * 0.11 + 6 * noise + np.sin(y * 0.004 + plank) * 3)
base = np.stack([np.full_like(x, 74), np.full_like(x, 112), np.full_like(x, 156)], -1)   # BGR
wood = base * (0.78 + 0.22 * grain)[..., None] * shade[..., None]
seam = (x % 200) < 3
wood[seam] *= 0.55
wood = np.clip(wood, 0, 255).astype(np.uint8)

img = np.zeros((H, W, 3), np.uint8)
horizon = int(H * 0.2)
# wall: soft warm grey, lighter towards a window on the left
wy, wx = np.mgrid[0:horizon, 0:W].astype(np.float32)
wall = np.stack([196 - 0.03 * wx, 206 - 0.025 * wx, 214 - 0.02 * wx], -1) * (0.9 + 0.1 * wy / horizon)[..., None]
img[:horizon] = np.clip(wall, 0, 255).astype(np.uint8)
img[horizon:] = (58, 66, 74)      # the floor beyond the table's sides
# the table top in perspective: the far edge narrow at the horizon, the near edge past the screen
src = np.float32([[0, 0], [TW, 0], [TW, TH], [0, TH]])
dst = np.float32([[W * 0.08, horizon], [W * 0.92, horizon], [W * 2.1, H * 1.15], [-W * 1.1, H * 1.15]])
M = cv2.getPerspectiveTransform(src, dst)
table = cv2.warpPerspective(wood, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
mask = cv2.warpPerspective(np.full((TH, TW), 255, np.uint8), M, (W, H))
img[mask > 0] = table[mask > 0]
# table edge
cv2.line(img, (int(W * 0.08), horizon), (int(W * 0.92), horizon), (40, 62, 88), 6)

# a notebook (right) and a mug (left) with soft shadows
def soft_shadow(poly, blur=41, strength=0.45):
    m = np.zeros((H, W), np.float32)
    cv2.fillPoly(m, [np.int32(poly)], 1.0)
    m = cv2.GaussianBlur(m, (blur, blur), 0)
    img[:] = (img * (1 - strength * m[..., None])).astype(np.uint8)

nb = np.float32([[W * 0.70, H * 0.33], [W * 0.95, H * 0.32], [W * 1.02, H * 0.47], [W * 0.73, H * 0.49]])
soft_shadow(nb + [14, 18])
cv2.fillPoly(img, [np.int32(nb)], (70, 58, 152))
cv2.polylines(img, [np.int32(nb)], True, (40, 30, 100), 3)
cx, cy = int(W * 0.17), int(H * 0.36)
soft_shadow(cv2.ellipse2Poly((cx + 30, cy + 28), (86, 44), 0, 0, 360, 10), 61, 0.5)
cv2.ellipse(img, (cx, cy + 70), (82, 40), 0, 0, 180, (205, 210, 214), -1)
cv2.rectangle(img, (cx - 82, cy - 40), (cx + 82, cy + 70), (205, 210, 214), -1)
cv2.ellipse(img, (cx, cy - 40), (82, 40), 0, 0, 360, (225, 228, 232), -1)
cv2.ellipse(img, (cx, cy - 40), (70, 32), 0, 0, 360, (40, 52, 70), -1)
cv2.ellipse(img, (cx + 92, cy + 8), (26, 36), 0, -90, 90, (205, 210, 214), 12)

# camera look: vignette, a little noise and blur
vy, vx = np.mgrid[0:H, 0:W].astype(np.float32)
r = np.hypot((vx - W / 2) / W, (vy - H / 2) / H)
img = (img * (1 - 0.35 * r[..., None] ** 2)).astype(np.float32)
img += rng.normal(0, 3, img.shape)
img = cv2.GaussianBlur(np.clip(img, 0, 255).astype(np.uint8), (3, 3), 0)

os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
cv2.imwrite(os.path.splitext(out)[0] + '.png', img)
yuv = cv2.cvtColor(img, cv2.COLOR_BGR2YUV_I420)
with open(out, 'wb') as f:
    f.write(f'YUV4MPEG2 W{W} H{H} F30:1 Ip A1:1 C420jpeg\n'.encode())
    for _ in range(2):
        f.write(b'FRAME\n')
        f.write(yuv.tobytes())
print(out, W, H)
