"""生成应用图标（assets/icon.png 与 assets/icon.ico）。

设计含义：深色编辑器窗口 + 左侧 Git 行级标记（新增/修改/删除三色）
+ 终端提示符，直观表达「远程代码编辑器 + Git 标记」。
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ASSETS = Path(__file__).resolve().parent.parent / "assets"
SIZE = 256

BG = (30, 30, 30, 255)
PANEL = (37, 37, 38, 255)
ADDED = (63, 185, 80, 255)
MODIFIED = (227, 179, 65, 255)
DELETED = (248, 81, 73, 255)
TEXT = (212, 212, 212, 255)
ACCENT = (55, 148, 255, 255)


def build_image() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle([8, 8, SIZE - 8, SIZE - 8], radius=44, fill=BG, outline=(70, 70, 72, 255), width=4)
    draw.rectangle([28, 28, SIZE - 28, 62], fill=PANEL)

    # 左侧 Gutter 标记：新增 / 修改 / 删除
    for index, color in enumerate((ADDED, MODIFIED, DELETED)):
        top = 84 + index * 46
        draw.rounded_rectangle([40, top, 52, top + 32], radius=6, fill=color)

    # 终端提示符 ">" 与光标
    draw.line([76, 104, 108, 128], fill=TEXT, width=14)
    draw.line([108, 128, 76, 152], fill=TEXT, width=14)
    draw.rounded_rectangle([122, 140, 176, 156], radius=6, fill=ACCENT)

    # 代码行示意
    draw.rounded_rectangle([76, 176, 200, 190], radius=6, fill=(120, 120, 124, 255))
    draw.rounded_rectangle([76, 202, 160, 216], radius=6, fill=(90, 90, 94, 255))
    return image


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    image = build_image()
    png_path = ASSETS / "icon.png"
    image.save(png_path)
    image.save(ASSETS / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f"已生成 {png_path} 与 {ASSETS / 'icon.ico'}")


if __name__ == "__main__":
    main()
