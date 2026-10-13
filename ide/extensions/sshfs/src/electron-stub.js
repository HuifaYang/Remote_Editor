// 打包桩：src/main/** 里的主进程代码（日志模块）会 `require("electron")`，
// 而扩展宿主里没有 electron 模块。esbuild 打包时用 alias 把它指到这里（见 ide/tools/build-extension.mjs），
// 这样我们的 SSH 层 / 镜像层 / 语言服务层可以原样复用，不用为扩展再抄一份。
"use strict";

const os = require("node:os");
const path = require("node:path");

const userData = process.env.RCE_EXT_USER_DATA || path.join(os.tmpdir(), "rce-extension-host");

module.exports = {
  app: {
    getPath(name) {
      return name === "temp" ? os.tmpdir() : userData;
    },
    getAppPath() {
      return userData;
    },
    isPackaged: false,
  },
};
