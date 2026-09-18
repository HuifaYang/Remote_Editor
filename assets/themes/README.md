# 内置配色主题

本目录放 **VSCode 格式**的主题 JSON（`{ "colors": {...}, "tokenColors": [...] }`），
程序启动时自动加载，并出现在「设置 → 外观 → 主题」与「视图 → 主题」里
（实现见 `app/ui/theme.py::load_external_themes`）。

## 已内置

| 主题 | 版本 | 许可 |
| --- | --- | --- |
| GitHub Dark / Dark Default / Dark Dimmed / Dark High Contrast / Dark Colorblind | 6.3.5 | MIT，见 `LICENSE-github-vscode-theme.txt` |
| GitHub Light / Light Default / Light High Contrast / Light Colorblind | 6.3.5 | 同上 |

启动后在主题下拉框里显示为「GitHub Dark Default」等（显示名取 JSON 里的 `name` 字段），
配置里存的是文件名派生的键（`github-dark-default`）。

## 再加主题

把任意 VSCode 主题 JSON 放进本目录即可，文件名随意。注意：

- 配置里的主题名取**文件名**（`one-dark-pro.json` → `one-dark-pro`）；
- 主题里没写到的颜色会沿用内置深色 / 浅色主题的值（按背景亮度自动挑），
  所以**不完整**的主题也能安全加载；
- `#rrggbbaa` 这类带透明度的写法会与编辑器底色合成，不会串色；
- 同名主题不会覆盖内置的 `dark` / `light`；
- 换用的主题请一并放入其许可文件。

其它常见来源：

| 主题 | 许可 | 下载 |
| --- | --- | --- |
| One Dark Pro | MIT | https://github.com/Binaryify/OneDark-Pro （取 `themes/*.json`） |
| Dracula | MIT | https://github.com/dracula/visual-studio-code （取 `themes/*.json`） |

> 注意：GitHub 主题的 **GitHub Releases 源码包**里只有 `src/*.js`（主题是构建产物，
> 需要 Node 编译）；要现成的 JSON 请取扩展市场安装后的 `themes/` 目录，
> 或下载打包好的 `.vsix` 解压。
