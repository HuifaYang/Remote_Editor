// 独立进程的假 SSH/SFTP 服务端：复用 tests/integration/fake-ssh-server.ts（脚本里先编译到 ide/tools/build）。
//
// 打开 realExec / realShell 后，靶机里的 exec 与 shell 都是**真的在跑**（bash + script 造 pty），
// 所以终端、搜索、SCM 都能拿它做端到端验证；路径映射规则与 SFTP 一致：远端 `/ws/x` → 临时根/ws/x。
//
// 用法：node ide/tools/fake-sshd.js <端口文件>
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { startFakeServer } = require("./build/fake-ssh-server.js");

const portFile = process.argv[2] || path.join(__dirname, "tmp", "port.txt");

/** 「另一台机器」外壳：能用私有挂载命名空间就用（把 /usr/include 盖小），不行就退化成老实跑（会慢） */
function targetWrapper() {
  if (process.env.RCE_FAKE_TARGET === "plain") return undefined;
  const script = path.join(__dirname, "fake-target.sh");
  const probe = spawnSync("unshare", ["-rm", "--propagation", "private", "bash", "-c", "true"], { timeout: 5000 });
  if (probe.status === 0) return script;
  console.warn("[fake-sshd] 用户命名空间不可用（unshare 失败），靶机退化成本机：镜像同步会把工作机的 /usr/include 也拉一遍，会慢很多");
  return undefined;
}

startFakeServer([], { realExec: true, realShell: true, shellWrapper: targetWrapper() }).then((server) => {
  const ws = path.join(server.root, "ws");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# 假远端工程\n\nhello remote\n");
  fs.writeFileSync(path.join(ws, "src", "util.c"), "#include <stdio.h>\nint add(int a, int b) { return a + b; }\n");
  fs.writeFileSync(path.join(ws, ".gitignore"), "build/\n*.o\n");
  // 远端工作区配置：命中的话说明虚拟工作区（sshfs://）能读到远端 .vscode（Remote-SSH 白拿的能力之一）
  fs.mkdirSync(path.join(ws, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".vscode", "settings.json"), JSON.stringify({ "editor.tabSize": 7 }, null, 2) + "\n");
  // 任务（tasks.json）：E2E 里用「Tasks: Run Task」跑它，验证任务是真的在**远端**跑的
  // （判据：任务会在远端工作目录里写下 task-ran.txt / task-pwd.txt）
  fs.writeFileSync(path.join(ws, ".vscode", "tasks.json"), JSON.stringify({
    version: "2.0.0",
    tasks: [
      {
        label: "rce-probe",
        type: "shell",
        command: "sh -c 'pwd > task-pwd.txt; echo 远端任务已跑 >> task-ran.txt'",
        options: { cwd: "${workspaceFolder}" },
        problemMatcher: [],
      },
      {
        label: "rce-dependency-prep",
        type: "shell",
        command: "sh -c 'printf prep > task-dependency.txt'",
        options: { cwd: "${workspaceFolder}" },
        problemMatcher: [],
      },
      {
        label: "rce-dependent",
        type: "shell",
        dependsOn: ["rce-dependency-prep"],
        dependsOrder: "sequence",
        command: "sh -c 'test \"$(cat task-dependency.txt)\" = prep && printf \"\\ndependent\\n\" >> task-dependency.txt'",
        options: { cwd: "${workspaceFolder}" },
        problemMatcher: [],
      },
      {
        label: "rce-dependent-parallel",
        type: "shell",
        dependsOn: ["rce-dependency-prep"],
        command: "sh -c 'printf \"\\nparallel\" >> task-dependency.txt'",
        options: { cwd: "${workspaceFolder}" },
        problemMatcher: [],
      },
      {
        label: "rce-cycle-a",
        type: "shell",
        dependsOn: ["rce-cycle-b"],
        command: "sh -c 'printf a > task-cycle-a-ran.txt'",
        options: { cwd: "${workspaceFolder}" },
        problemMatcher: [],
      },
      {
        label: "rce-cycle-b",
        type: "shell",
        dependsOn: ["rce-cycle-a"],
        command: "sh -c 'printf b > task-cycle-b-ran.txt'",
        options: { cwd: "${workspaceFolder}" },
        problemMatcher: [],
      },
      {
        label: "rce-problem",
        type: "shell",
        command: "printf 'src/main.c(1,1): error C9999: RCE matcher probe\\n'",
        options: { cwd: "${workspaceFolder}" },
        problemMatcher: ["$msCompile"],
      },
      {
        label: "rce-background",
        type: "shell",
        isBackground: true,
        command: "sh -c 'printf started > task-background.txt; while [ ! -f task-background-stop ]; do sleep 0.2; done; printf stopped >> task-background.txt'",
        options: { cwd: "${workspaceFolder}" },
        problemMatcher: [],
      },
    ],
  }, null, 2) + "\n");
  // compile_commands.json 用**远端绝对路径**写，专门验「镜像必须重写绝对路径」（总纲 §13 坑 2）
  fs.writeFileSync(path.join(ws, "compile_commands.json"), JSON.stringify([
    {
      directory: "/ws",
      file: "/ws/src/main.c",
      command: "gcc -c -I/usr/include -I/ws/src -o /ws/build/main.o /ws/src/main.c",
    },
  ], null, 2) + "\n");
  fs.writeFileSync(path.join(ws, "src", "main.c"),
    "#include " + JSON.stringify("<stdio.h>") + "\nint main(void) { return rce_fake_printf(\"hi\"); }\n");

  // 造一个真 git 仓库：好让 SCM 面板有内容（一个改动 + 一个未跟踪文件）
  const git = (...args) =>
    execFileSync("git", args, { cwd: ws, env: { ...process.env, GIT_AUTHOR_NAME: "rce", GIT_AUTHOR_EMAIL: "rce@x", GIT_COMMITTER_NAME: "rce", GIT_COMMITTER_EMAIL: "rce@x" } });
  try {
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "初始提交");
    fs.appendFileSync(path.join(ws, "src", "main.c"), "\n// 本地改动\n");
    fs.writeFileSync(path.join(ws, "src", "new-file.txt"), "未跟踪文件\n");
  } catch (err) {
    console.error(`[fake-sshd] 造 git 仓库失败（不影响文件系统验证）：${err && err.message}`);
  }

  fs.writeFileSync(portFile, String(server.port));
  console.log(`[fake-sshd] 127.0.0.1:${server.port} root=${server.root}`);

  const bye = () => server.close().then(() => process.exit(0));
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}).catch((err) => {
  console.error(`[fake-sshd] 起不来：${err && err.message}`);
  process.exit(1);
});
