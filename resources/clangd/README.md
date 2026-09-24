# 内置 clangd 占位目录（总纲 §5.5 第 0 条）

各平台官方 clangd 二进制在本地打包或 CI 发布时放到对应子目录：

- `win/` —— Windows x64（clangd.exe + 依赖 dll）
- `linux/` —— Linux x64
- `mac/` —— macOS（暂缓出包，总纲 §1.4）

这些二进制体积很大，**不提交进 Git**；`.gitignore` 已排除 `clangd` / `clangd.exe`。
electron-builder 按 `extraResources` 把 `resources/clangd/${os}` 打进安装包的 `clangd/`。
发布前注意附带 LLVM 的 Apache-2.0 许可文件。
