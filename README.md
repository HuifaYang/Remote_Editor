# RemoteCodeEditor V2

轻量级 SSH 远程代码编辑器（Electron + TypeScript + Monaco），面向低性能嵌入式 ARM 板卡：
**板卡零部署、零常驻进程**，语言服务在工作机上对着本地环境镜像运行。

完整实现规格见本仓库 `docs/spec-v2*.md`（总纲 + 5 个分册），开发记录见 `docs/devlog.md`。

## 当前版本说明

- **当前仓库版本就是 V2**：Electron + TypeScript + Monaco + ssh2，仓库根目录直接运行。
- V1（Python + PySide6）已从当前工作区移除；历史代码仍在 Git 提交记录中，不再作为当前代码维护。
- 不要把 V1 的 `app/`、`assets/`、Python 测试或脚本混回当前分支。
- UI 已按 V2 规格完成现代化重构：自绘标题栏、双层主菜单、活动栏/侧边栏、欢迎页、主机表单、设置、搜索、Git、终端和统一空态。

## 运行要求

- Node.js 22+（本仓库当前使用 npm / TypeScript / Vitest）
- Linux 开发机可直接 `npm start`
- Windows 打包由 electron-builder / CI 负责

## 常用命令

```bash
npm install          # 装依赖
npm start            # 编译并启动
npm run lint         # 0 告警
npm test             # 全绿
npm run typecheck    # tsc 全量类型检查，0 错误
npm run build        # 出 Windows/Linux 安装包（macOS 暂缓，见总纲 §1.4）
npm run build:dir    # 只出未打包目录（快速验证）
```

## 内置语言服务资源

- `resources/clangd/{linux,win,mac}/` 只提交目录说明和 `.gitkeep`。
- clangd 官方二进制体积很大，**不进 Git**；本机打包时可临时放入对应目录。
- 正式发布包应通过 Release/CI 产物携带 clangd，并附 LLVM Apache-2.0 许可。

## 里程碑状态（如实版）

- M1 工程骨架：已实现。
- M2 SSH/SFTP/Git/搜索远端层：已实现并有假 SSH 集成测试。
- M3 环境镜像 + LSP：实现完成；真机验收（RK3566/RK3588 上的补全、跳转、诊断和进程占用）仍待做。
- M4 文件与编辑外壳：已实现。
- M5 Git 与搜索：已实现。
- M6 终端、设置、打包和 UI 收尾：已实现；Windows 干净机器安装验证仍待做。

当前仍待人工验收：

1. 真机 SSH 全链路（连接 → 打开目录 → 编辑 → 保存 → 搜索 → Git → 终端）。
2. 真机 LSP（补全、F12、波浪线、板子上无残留语言服务进程）。
3. Windows 干净机器安装与启动。
