# 内置字体

本目录的字体随程序分发，启动时自动注册（见 `app/ui/fonts.py`），
**用户机器上不需要预装这些字体**。

## 已内置

| 字体 | 版本 | 文件 | 许可 |
| --- | --- | --- | --- |
| JetBrains Mono（等宽，编辑器默认） | 2.304 | `JetBrainsMono-{Regular,Bold,Italic,BoldItalic,Medium}.ttf` | SIL OFL 1.1，见 `OFL.txt` |

编辑器会优先使用本目录里的等宽字体（偏好顺序见 `app/ui/fonts.py::MONOSPACE_PREFERENCE`）。
中文由系统字体回退（Qt 自动按字形逐个回退），所以不必为此塞一个几十 MB 的 CJK 字体。

## 再加字体

把 `.ttf` / `.otf` / `.ttc` / `.otc` 丢进本目录即可，**不需要改代码**（文件名随意，
字体族名以文件内部为准）。目录为空或文件损坏时，程序回退到系统字体，不影响启动。

## 注意事项

分发字体必须带上许可文件（本目录已有 `OFL.txt` / `AUTHORS.txt`）。若换用别的字体，
请一并放入对应的许可文本，例如：

- Sarasa Gothic（更纱黑体，中文等宽）：https://github.com/be5invis/Sarasa-Gothic/releases
- IBM Plex Mono / Sans：https://github.com/IBM/plex
