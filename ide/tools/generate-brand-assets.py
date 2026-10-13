#!/usr/bin/env python3
"""生成“织码 WeaveCode”品牌资产。

输出：
  resources/brand/weavecode-mark.svg
  resources/brand/weavecode-lockup-dark.svg
  resources/brand/weavecode-lockup-light.svg
  resources/brand/weavecode-icon-1024.png
  resources/brand/weavecode-icon-512.png
  resources/brand/weavecode-icon-256.png
  resources/brand/weavecode-lockup-dark.png
  resources/brand/weavecode-lockup-light.png
  resources/icon.png
  resources/icon.ico
  resources/brand/weavecode.icns（Pillow 支持时）
"""
from __future__ import annotations

import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "resources" / "brand"
BRAND.mkdir(parents=True, exist_ok=True)

S = 2048
MARGIN = 96
RADIUS = 430
CJK_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
CJK_BLACK = "/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc"
LATIN_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
LATIN_MONO = "/usr/share/fonts/truetype/noto/NotoSansMono-Bold.ttf"

NAVY_TOP = (8, 15, 32)
NAVY_BOTTOM = (20, 47, 86)
CYAN = (70, 220, 255)
MINT = (112, 242, 174)
WHITE = (244, 250, 255)
INK = (8, 15, 32)


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size=size)


def lerp(a: int, b: int, t: float) -> int:
    return int(round(a + (b - a) * t))


def gradient_square(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    img = Image.new("RGB", (size, size), top)
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        draw.line((0, y, size, y), fill=(lerp(top[0], bottom[0], t), lerp(top[1], bottom[1], t), lerp(top[2], bottom[2], t)))
    return img


def rounded_mask(size: int, margin: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((margin, margin, size - margin, size - margin), radius=radius, fill=255)
    return mask


def glow_layer(size: int) -> Image.Image:
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # 中央柔光，让青绿色缠绕线有“发光但不霓虹刺眼”的质感。
    d.ellipse((size * 0.18, size * 0.25, size * 0.82, size * 0.88), fill=(48, 210, 220, 42))
    return layer.filter(ImageFilter.GaussianBlur(size * 0.08))


def draw_polyline(draw: ImageDraw.ImageDraw, points, fill, width: int):
    draw.line(points, fill=fill, width=width, joint="curve")
    for p in points:
        r = width // 2
        draw.ellipse((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=fill)


def draw_mark(canvas: Image.Image, scale: float = 1.0, center: tuple[float, float] | None = None, glowing: bool = True):
    """在 canvas 上画缠绕 W 主标记。坐标基于 512，再乘 scale。"""
    size = canvas.width
    if center is None:
        center = (size / 2, size / 2)
    ox, oy = center
    def pt(x: float, y: float):
        return (ox + (x - 256) * scale, oy + (y - 256) * scale)

    if glowing:
        glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        # 先画宽一点的模糊光晕。
        p1 = [pt(150, 166), pt(214, 354), pt(256, 246)]
        p2 = [pt(362, 166), pt(298, 354), pt(256, 246)]
        draw_polyline(gd, p1, (*CYAN, 95), int(58 * scale))
        draw_polyline(gd, p2, (*MINT, 95), int(58 * scale))
        gl = glow.filter(ImageFilter.GaussianBlur(max(8, int(30 * scale))))
        canvas.alpha_composite(gl)

    d = ImageDraw.Draw(canvas)
    # 外侧代码括号，弱化到“看得出是代码工具”，不抢主 W。
    bracket_width = max(4, int(10 * scale))
    bracket_color = (205, 235, 255, 165)
    d.line([pt(112, 202), pt(82, 256), pt(112, 310)], fill=bracket_color, width=bracket_width, joint="curve")
    d.line([pt(400, 202), pt(430, 256), pt(400, 310)], fill=bracket_color, width=bracket_width, joint="curve")

    # 两条缠绕带：青色 / 薄荷色。
    width = max(10, int(37 * scale))
    highlight = max(2, int(7 * scale))
    p1 = [pt(150, 166), pt(214, 354), pt(256, 246)]
    p2 = [pt(362, 166), pt(298, 354), pt(256, 246)]
    draw_polyline(d, p1, (*CYAN, 255), width)
    draw_polyline(d, p2, (*MINT, 255), width)
    # 高光让交叉更像编织纤维。
    draw_polyline(d, [pt(156, 170), pt(214, 334), pt(247, 251)], (255, 255, 255, 86), highlight)
    draw_polyline(d, [pt(356, 170), pt(298, 334), pt(265, 251)], (255, 255, 255, 86), highlight)

    # 交叉节点：小菱形，像编织结，而不是黑色圆孔。
    cx, cy = pt(256, 246)
    r = max(8, int(24 * scale))
    diamond = [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]
    d.polygon(diamond, fill=(9, 22, 42, 255), outline=(235, 255, 252, 190))
    sr = max(3, int(5 * scale))
    d.ellipse((cx - sr, cy - sr, cx + sr, cy + sr), fill=(240, 255, 252, 245))

    # 端点小圆，形成“节点 / 远程连接”的感觉。
    for p, color in [((150, 166), CYAN), ((362, 166), MINT), ((214, 354), CYAN), ((298, 354), MINT)]:
        r = max(5, int(14 * scale))
        d.ellipse((pt(*p)[0] - r, pt(*p)[1] - r, pt(*p)[0] + r, pt(*p)[1] + r), fill=(*color, 255))


def app_icon(size: int = 2048) -> Image.Image:
    margin = int(size * (MARGIN / 2048))
    radius = int(size * (RADIUS / 2048))
    base = gradient_square(size, NAVY_TOP, NAVY_BOTTOM).convert("RGBA")
    base.alpha_composite(glow_layer(size))
    draw_mark(base, scale=size / 512 * 0.82)
    # 细微内描边。
    d = ImageDraw.Draw(base)
    d.rounded_rectangle((margin, margin, size - margin, size - margin), radius=radius, outline=(255, 255, 255, 38), width=max(2, size // 512))
    base.putalpha(rounded_mask(size, margin, radius))
    return base


def draw_tracking_text(draw: ImageDraw.ImageDraw, xy, text: str, fnt, fill, tracking: int):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + tracking
    return x


def lockup(dark: bool, mark_size: int = 420) -> Image.Image:
    W, H = 2400, 820
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    mark = app_icon(900).resize((mark_size, mark_size), Image.LANCZOS)
    img.alpha_composite(mark, (80, (H - mark_size) // 2))
    text_color = WHITE if dark else INK
    sub_color = (170, 225, 245, 255) if dark else (40, 105, 145, 255)
    d = ImageDraw.Draw(img)
    d.text((590, 150), "织码", font=font(CJK_BLACK, 250), fill=text_color)
    draw_tracking_text(d, (610, 445), "WEAVECODE", font(LATIN_BOLD, 72), sub_color, 14)
    d.text((612, 555), "远端 · 本地 · 智能", font=font(CJK_BOLD, 42), fill=(160, 210, 230, 220) if dark else (80, 115, 140, 220))
    return img


def save_svg():
    mark = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#080f20"/>
      <stop offset="1" stop-color="#142f56"/>
    </linearGradient>
    <linearGradient id="cyan" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#46dcff"/>
      <stop offset="1" stop-color="#2aa9e8"/>
    </linearGradient>
    <linearGradient id="mint" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#70f2ae"/>
      <stop offset="1" stop-color="#2ecf9d"/>
    </linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect x="24" y="24" width="464" height="464" rx="108" fill="url(#bg)" stroke="#ffffff22" stroke-width="2"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)">
    <path d="M112 202 L82 256 L112 310" stroke="#cdeBff" stroke-opacity=".45" stroke-width="7"/>
    <path d="M400 202 L430 256 L400 310" stroke="#cdeBff" stroke-opacity=".45" stroke-width="7"/>
    <path d="M150 166 L214 354 L256 246" stroke="url(#cyan)" stroke-width="36"/>
    <path d="M362 166 L298 354 L256 246" stroke="url(#mint)" stroke-width="36"/>
  </g>
  <circle cx="256" cy="246" r="21" fill="#09162a"/>
  <circle cx="256" cy="246" r="8" fill="#f0fffc"/>
</svg>'''
    (BRAND / "weavecode-mark.svg").write_text(mark, encoding="utf-8")
    for dark, name in [(True, "weavecode-lockup-dark.svg"), (False, "weavecode-lockup-light.svg")]:
        color = "#f4faff" if dark else "#080f20"
        sub = "#aae1f5" if dark else "#286991"
        svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 410">
  <g transform="translate(24 24) scale(.707)">{mark[mark.index('<defs>'):]}</g>
  <text x="292" y="182" fill="{color}" font-family="Noto Sans CJK SC, sans-serif" font-size="126" font-weight="900">织码</text>
  <text x="302" y="260" fill="{sub}" font-family="DejaVu Sans, sans-serif" font-size="38" font-weight="700" letter-spacing="10">WEAVECODE</text>
  <text x="304" y="312" fill="{sub}" font-family="Noto Sans CJK SC, sans-serif" font-size="22">远端 · 本地 · 智能</text>
</svg>'''
        (BRAND / name).write_text(svg, encoding="utf-8")


def main():
    save_svg()
    icon = app_icon(S)
    icon_1024 = icon.resize((1024, 1024), Image.LANCZOS)
    icon_512 = icon.resize((512, 512), Image.LANCZOS)
    icon_256 = icon.resize((256, 256), Image.LANCZOS)
    icon_192 = icon.resize((192, 192), Image.LANCZOS)
    icon_150 = icon.resize((150, 150), Image.LANCZOS)
    icon_70 = icon.resize((70, 70), Image.LANCZOS)
    icon_1024.save(BRAND / "weavecode-icon-1024.png")
    icon_512.save(BRAND / "weavecode-icon-512.png")
    icon_256.save(BRAND / "weavecode-icon-256.png")
    icon_192.save(BRAND / "weavecode-icon-192.png")
    icon_150.save(BRAND / "weavecode-icon-150.png")
    icon_70.save(BRAND / "weavecode-icon-70.png")
    icon_1024.save(ROOT / "resources" / "icon.png")
    icon.resize((256, 256), Image.LANCZOS).save(
        ROOT / "resources" / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    lockup(True).save(BRAND / "weavecode-lockup-dark.png")
    lockup(False).save(BRAND / "weavecode-lockup-light.png")
    try:
        icon_512.save(BRAND / "weavecode.icns", format="ICNS")
        print("ICNS: OK")
    except Exception as exc:  # Pillow 的 ICNS writer 对尺寸有平台限制
        print(f"ICNS: skipped ({exc})")
    print("Wrote brand assets to", BRAND)


if __name__ == "__main__":
    main()
