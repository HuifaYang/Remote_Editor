# UI 图标（Codicons）

这里的 SVG 来自 VSCode 官方图标集 [vscode-codicons](https://github.com/microsoft/vscode-codicons)，
许可以 **CC-BY 4.0**（见 `LICENSE-codicons.txt`）。VSCode 的活动栏 / 工具栏 / 状态栏图标
就是这一套，16/24px 网格、统一描边粗细，比手绘线条工整得多。

## 用法

所有图标都是 `fill="currentColor"`，渲染时注入主题色（见 `app/ui/icons.py`）。
新增图标：从上游 `src/icons/` 拷一个 SVG 进来，再在 `app/ui/icons.py` 的
`_CODICON_MAP` 里登记「项目图标名 → SVG 文件名」即可；没有登记的图标名会回退到
原来的 QPainter 手画实现。

## 为什么是 SVG 而不是图标字体

项目约定「不引入图标字体 / 不新增第三方依赖」，SVG 走 PySide6 自带的 `QtSvg`
渲染，打包脚本已 `--add-data assets`，不需要额外改动。
