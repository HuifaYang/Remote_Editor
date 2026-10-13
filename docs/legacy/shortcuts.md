# 快捷键一览（总纲 §6.5，对齐 VSCode 默认键位）

| 快捷键 | 功能 | 快捷键 | 功能 |
| --- | --- | --- | --- |
| `Ctrl+P` | 快速打开文件（`:` 行号、`>` 命令前缀） | `Ctrl+Shift+P` | 命令面板 |
| `Ctrl+N` | 新建文件 | `Ctrl+O` | 打开远程文件夹 |
| `Ctrl+S` | 保存 | `Ctrl+Shift+S` | 另存为 |
| `Ctrl+K S` | 全部保存 | `Ctrl+W` | 关闭标签 |
| `Ctrl+Tab` / `Ctrl+PageDown` | 下一个标签 | `Ctrl+PageUp` | 上一个标签 |
| `Ctrl+Shift+T` | 重新打开已关闭的编辑器 | | |
| `Ctrl+F` | 查找（当前文件） | `Ctrl+H` | 替换 |
| `Ctrl+Shift+F` | 全局搜索 | `Ctrl+G` | 转到行 |
| `F12` | 跳转定义 | `Shift+F12` | 查找引用 |
| `Ctrl+Space` | 触发补全 | `F2` | 重命名符号（LSP） |
| `Ctrl+Shift+E` | 资源管理器 | `Ctrl+Shift+G` | 源代码管理 |
| `F5` | 刷新工作目录 + 镜像重同步 | `Shift+F5` | 刷新 Git 快照 |
| `Ctrl+B` | 收起/展开侧边栏 | `Ctrl+J` | 收起/展开底部面板 |
| ``Ctrl+` `` | 开关终端 | ``Ctrl+Shift+` `` | 新建终端 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 界面缩放 | `Ctrl+,` | 设置 |
| `Ctrl+K Ctrl+T` | 选择配色主题 | `Ctrl+K Ctrl+S` | 快捷键一览 |
| `Ctrl+Q` | 退出 | | |

> 标签页：单击文件 = 预览标签（斜体，再开新文件即替换）；双击标签 / 开始编辑 / 右键「固定」转常驻。
> 实现：详见 `src/renderer/app/shortcuts.ts`（含 `Ctrl+K` chord 表）。
