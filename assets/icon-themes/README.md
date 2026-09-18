# 内置文件图标主题

每个主题一个子目录，里面放 **VSCode 文件图标主题**的 JSON 与图标本体
（Material Icon Theme 等开源主题可直接解压进来）：

```
assets/icon-themes/
  material/
    material-icons.json      # 含 iconDefinitions，文件名不限（会自动识别）
    icons/*.svg
```

程序启动后主题会出现在「设置 → 外观 → 文件图标」下拉框里
（实现见 `app/ui/icon_theme.py`）：

## 已内置

| 主题 | 版本 | 目录 | 许可 |
| --- | --- | --- | --- |
| Material Icon Theme | 5.38.1 | `material/`（`dist/material-icons.json` + `icons/`，1251 个 SVG） | MIT，见 `material/LICENSE.txt` |

目录结构保持上游 `dist/` 布局原样（加载器会在一级子目录里找主题 JSON，
并按 JSON 的 `../icons/...` 相对路径解析图标）。显示名取自上游 `package.json` 的
`displayName`，所以下拉框里是「Material Icon Theme」而不是目录名。

- 解析顺序与 VSCode 一致：精确文件名（`fileNames`）→ 最长扩展名匹配
  （`fileExtensions`，`tar.gz` 优先于 `gz`）→ 默认文件图标；
  文件夹同理还支持展开 / 收起两态（`folderNamesExpanded` / `folderExpanded`）；
- 图标支持 SVG 与 PNG，SVG 由 PySide6 自带的 `QtSvg` 渲染，不引入新依赖；
- 主题缺失、JSON 坏掉、某个类型没定义，都会**逐个回退到系统图标**，
  不影响程序运行；
- 主题 JSON 与 `icons` 目录不在同一层级时（Material Icon Theme 的 `dist/` 布局）
  也能按文件名找到图标。

## 再加主题

解压任意 `.vsix`（或主题包）后整个目录丢进本目录即可，不必改结构、也不用改代码；
目录名会成为配置里的 `icon_theme` 值。主题文件请一并放入其许可。

来源示例：https://github.com/PKief/vscode-material-icon-theme
