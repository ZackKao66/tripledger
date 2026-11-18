"""產生 APP 圖示（由 GitHub Actions 執行一次即可）"""
import os, subprocess
from PIL import Image, ImageDraw, ImageFont

font = subprocess.run(["fc-match", "-f", "%{file}", "Noto Serif CJK TC:style=Bold"], capture_output=True, text=True).stdout.strip()
os.makedirs("icons", exist_ok=True)

def icon(size, path, maskable=False):
    S = 1024
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bg = (22, 25, 27, 255)
    if maskable:
        d.rectangle([0, 0, S, S], fill=bg)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=bg)
    sw = int(S * 0.34); x0 = (S - sw) // 2; y0 = int(S * 0.80)
    for i, c in enumerate([(201, 103, 76), (243, 239, 230), (31, 78, 69)]):
        d.rectangle([x0 + i * sw // 3, y0, x0 + (i + 1) * sw // 3, y0 + int(S * 0.022)], fill=c + (255,))
    f = ImageFont.truetype(font, int(S * (0.42 if maskable else 0.50)))
    bb = d.textbbox((0, 0), "旅", font=f)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    d.text(((S - w) / 2 - bb[0], (S * 0.47 - h / 2) - bb[1]), "旅", font=f, fill=(243, 239, 230, 255))
    img = img.resize((size, size), Image.LANCZOS)
    if maskable:
        img = img.convert("RGB")
    img.save(path)

icon(192, "icons/icon-192.png")
icon(512, "icons/icon-512.png")
icon(512, "icons/icon-maskable-512.png", maskable=True)
icon(180, "icons/apple-touch-icon.png", maskable=True)
icon(32, "icons/favicon-32.png")
print("圖示已產生")
