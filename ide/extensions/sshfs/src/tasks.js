// 任务（tasks）：把 `.vscode/tasks.json` 里的任务改到**远端**跑。
//
// 为什么必须自己接：
//   · 上游在**虚拟工作区**里故意把 shell/process 任务禁掉
//     （abstractTaskService.registerSupportedExecutions：isVirtual → shellExecutionSupported=false），
//     于是 tasks.json 里的任务被整批丢掉 —— 症状就是 fetchTasks() 为空、"运行任务"静默无动作。
//     那条防御是合理的（本地 shell 跑不了远端路径），但我们有**远端 shell**（SSH exec），
//     所以自己提供 TaskProvider：命令、cwd、env 全部发到板子上执行，输出流进任务终端。
//   · Remote-SSH 不用管这些，是因为它的任务跑在远端扩展宿主里（见 docs/ssh-vs-remotessh.md §2.7）。
//
// 数据流：
//   tasks.json（远端）──workspace.getConfiguration('tasks', folder)──▶ 任务定义
//     ──▶ vscode.Task + CustomExecution（本文件）──▶ SSHConnection.execStream(`cd <远端 cwd> && <命令>`)
//     ──▶ Pseudoterminal（输出进终端面板，结束码回给任务系统）
//
// dependsOn / problemMatcher 为什么也自己实现：
//   · Extension API 的 Task DTO 没有把 dependsOn 传进上游 configurationProperties，直接塞 definition 不会生效；
//   · 上游 problemMatcher 最终用 URI.file() 建 marker，在 sshfs:// 虚拟工作区里会落到 file:// 上。
//   所以这里在远端执行链里自己跑依赖图，并把匹配到的诊断创建到 sshfs:// URI 上。
"use strict";

const { shellQuote } = require("./fs-provider.js");

const TASK_TYPE = "rce-remote";
const SOURCE = "织码 WeaveCode";

/** ${workspaceFolder} 之类的变量在远端语境下自己替换（工作台不会替 CustomExecution 的任务展开变量） */
function expand(text, folder) {
  if (typeof text !== "string") return text;
  const remoteRoot = folder.uri.path || "/";
  return text
    .replace(/\$\{workspaceFolder\}/g, remoteRoot)
    .replace(/\$\{workspaceFolderBasename\}/g, remoteRoot.replace(/\/+$/, "").split("/").pop() || "")
    .replace(/\$\{userHome\}/g, "~");
}

/** 任务定义 → 远端命令行（env 前缀 + command + args，逐段安全引号） */
function commandOf(def, folder) {
  const parts = [];
  const env = def.options && def.options.env;
  if (env) {
    for (const [k, v] of Object.entries(env)) parts.push(`${k}=${shellQuote(expand(String(v), folder))}`);
  }
  const command = expand(String(def.command ?? ""), folder);
  if (command) parts.push(command);
  const args = def.args == null ? [] : Array.isArray(def.args) ? def.args : [def.args];
  for (const a of args) if (a !== undefined && a !== null && a !== "") parts.push(shellQuote(expand(String(a), folder)));
  return parts.join(" ");
}

/** 远端 cwd：默认工作区根；给了相对路径就相对工作区根 */
function cwdOf(def, folder) {
  const remoteRoot = folder.uri.path || "/";
  const raw = def.options && def.options.cwd;
  if (!raw) return remoteRoot;
  const expanded = expand(String(raw), folder);
  if (expanded.startsWith("/")) return expanded;
  return `${remoteRoot.replace(/\/+$/, "")}/${expanded}`;
}

function groupOf(vscode, group) {
  const kind = typeof group === "string" ? group : group && group.kind;
  if (kind === "build") return vscode.TaskGroup.Build;
  if (kind === "test") return vscode.TaskGroup.Test;
  if (kind === "clean") return vscode.TaskGroup.Clean;
  return undefined;
}

function taskLabelOf(def, index) {
  return String(def.label || def.taskName || def.command || `task-${index + 1}`);
}

/** 支持 tasks.json 的单/复数写法；Task 本身只接受命名 matcher 字符串，这里同时允许内联对象。 */
function problemMatchersOf(def) {
  const raw = def && (def.problemMatcher !== undefined ? def.problemMatcher : def.problemMatchers);
  if (raw === undefined || raw === null) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter((m) => m !== undefined && m !== null);
}

/** dependsOn 既可为字符串，也可为 `{ label, type }`；只支持同一个远端工作区里的任务。 */
function dependsOnOf(def) {
  const raw = def && def.dependsOn;
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .map((item) => (typeof item === "string" ? item : item && (item.label || item.taskName)))
    .filter((label) => label !== undefined && label !== null && String(label) !== "")
    .map(String);
}

function dependsOrderOf(def) {
  return def && def.dependsOrder === "sequence" ? "sequence" : "parallel";
}

function severityOf(value) {
  const text = String(value || "error").toLowerCase();
  if (text.includes("warning")) return "warning";
  if (text.includes("info") || text === "note") return "information";
  if (text.includes("hint")) return "hint";
  return "error";
}

function numberFrom(match, index) {
  if (!match || index === undefined || index === null) return undefined;
  const value = Number(match[index]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function locationFrom(match, pattern) {
  let line = numberFrom(match, pattern.line);
  let column = numberFrom(match, pattern.column);
  const location = pattern.location !== undefined && pattern.location !== null ? match[pattern.location] : undefined;
  if (location) {
    const parts = String(location).split(",").map((part) => Number(part));
    line = line || (Number.isFinite(parts[0]) ? parts[0] : undefined);
    column = column || (Number.isFinite(parts[1]) ? parts[1] : undefined);
  }
  return { line, column };
}

function regexpOf(value) {
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new RegExp(value);
  } catch {
    return null;
  }
}

const NAMED_PROBLEM_PATTERNS = {
  "$msCompile": {
    regexp: /^\s*(?:\s*\d+>)?(\S.*?)(?:\((\d+|\d+,\d+|\d+,\d+,\d+,\d+)\))?\s*:\s+(\S+\s+)?((?:fatal\s+)?error|warning|info)\s+(\w+\d+)?\s*:\s*(.*)$/i,
    file: 1,
    location: 2,
    severity: 4,
    code: 5,
    message: 6,
  },
  "$gcc": {
    regexp: /^(.+?):(\d+)(?::(\d+))?:\s*(?:fatal\s+)?(error|warning|note|info)\s*:\s*(.*)$/i,
    file: 1,
    line: 2,
    column: 3,
    severity: 4,
    message: 5,
  },
  "$clang": {
    regexp: /^(.+?):(\d+)(?::(\d+))?:\s*(?:fatal\s+)?(error|warning|note|info)\s*:\s*(.*)$/i,
    file: 1,
    line: 2,
    column: 3,
    severity: 4,
    message: 5,
  },
  "$tsc": {
    regexp: /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/i,
    file: 1,
    line: 2,
    column: 3,
    severity: 4,
    code: 5,
    message: 6,
  },
  "$tsc-watch": {
    regexp: /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/i,
    file: 1,
    line: 2,
    column: 3,
    severity: 4,
    code: 5,
    message: 6,
  },
};

function patternFor(matcher) {
  if (typeof matcher === "string") return NAMED_PROBLEM_PATTERNS[matcher] || NAMED_PROBLEM_PATTERNS[matcher.startsWith("$") ? matcher : `$${matcher}`];
  if (!matcher || typeof matcher !== "object") return null;
  const pattern = matcher.pattern;
  if (typeof pattern === "string") return NAMED_PROBLEM_PATTERNS[pattern] || NAMED_PROBLEM_PATTERNS[`$${pattern}`];
  if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) return null;
  return pattern;
}

function parseProblemLine(line, matcher) {
  const pattern = patternFor(matcher);
  if (!pattern) return null;
  const regexp = regexpOf(pattern.regexp);
  if (!regexp) return null;
  const match = regexp.exec(line);
  if (!match) return null;
  const file = pattern.file !== undefined ? match[pattern.file] : undefined;
  const message = pattern.message !== undefined ? match[pattern.message] : undefined;
  if (!file || message === undefined || message === null) return null;
  const { line: lineNumber, column } = locationFrom(match, pattern);
  return {
    file: String(file).trim(),
    line: lineNumber,
    column,
    severity: severityOf(pattern.severity !== undefined ? match[pattern.severity] : "error"),
    code: pattern.code !== undefined ? match[pattern.code] : undefined,
    message: String(message),
  };
}

/** 纯函数：输出文本 + tasks.json 定义 → 诊断（测试直接覆盖这里，不依赖 VSCode API）。 */
function parseTaskProblems(output, def) {
  const matchers = problemMatchersOf(def);
  if (matchers.length === 0 || !output) return [];
  const result = [];
  for (const line of String(output).split(/\r?\n/)) {
    for (const matcher of matchers) {
      const problem = parseProblemLine(line, matcher);
      if (problem) {
        result.push(problem);
        break;
      }
    }
  }
  return result;
}

function taskDefinitionsOf(vscode, folder) {
  const defs = vscode.workspace.getConfiguration("tasks", folder.uri).get("tasks");
  return Array.isArray(defs) ? defs.filter(isOurTask) : [];
}

function taskIndex(vscode, folder, rootDef, rootLabel) {
  const index = new Map();
  for (const def of taskDefinitionsOf(vscode, folder)) index.set(taskLabelOf(def, index.size), def);
  if (!index.has(rootLabel)) index.set(rootLabel, rootDef);
  return index;
}

/** 执行前先做完整的依赖图校验，保证循环/缺失不会先跑出半边副作用。 */
function validateDependencyGraph(defs, rootLabel) {
  const state = new Map();
  const stack = [];
  const visit = (label) => {
    if (!defs.has(label)) throw new Error(`依赖的任务不存在：${label}`);
    const current = state.get(label);
    if (current === "done") return;
    if (current === "visiting") {
      const start = stack.indexOf(label);
      const cycle = stack.slice(start).concat(label).join(" → ");
      throw new Error(`任务依赖成环：${cycle}`);
    }
    state.set(label, "visiting");
    stack.push(label);
    for (const dependency of dependsOnOf(defs.get(label))) visit(dependency);
    stack.pop();
    state.set(label, "done");
  };
  visit(rootLabel);
}

function definitionsHaveProblemMatchers(defs, rootLabel) {
  const seen = new Set();
  const visit = (label) => {
    if (seen.has(label)) return false;
    seen.add(label);
    const def = defs.get(label);
    if (!def) return false;
    if (problemMatchersOf(def).length > 0) return true;
    return dependsOnOf(def).some(visit);
  };
  return visit(rootLabel);
}

function remoteProblemUri(vscode, folder, filename) {
  let path = String(filename).replace(/\\/g, "/").replace(/^\.\//, "");
  const remoteRoot = (folder.uri.path || "/").replace(/\/+$/, "");
  if (remoteRoot && path.startsWith(`${remoteRoot}/`)) path = path.slice(remoteRoot.length + 1);
  if (path.startsWith("/")) {
    return vscode.Uri.from({ scheme: folder.uri.scheme, authority: folder.uri.authority, path });
  }
  return vscode.Uri.joinPath(folder.uri, ...path.split("/").filter(Boolean));
}

function diagnosticSeverity(vscode, severity) {
  if (severity === "warning") return vscode.DiagnosticSeverity.Warning;
  if (severity === "information") return vscode.DiagnosticSeverity.Information;
  if (severity === "hint") return vscode.DiagnosticSeverity.Hint;
  return vscode.DiagnosticSeverity.Error;
}

/** 任务终端：把 SSH exec 的 stdout/stderr 流进终端面板，结束码回传给任务系统 */
class RemoteTaskTerminal {
  constructor(vscode, deps, folder, def, index) {
    this.vscode = vscode;
    this.deps = deps;
    this.folder = folder;
    this.def = def;
    this.label = taskLabelOf(def, index);
    this.handles = new Set();
    this.problems = [];
    this.runCache = new Map();
    this.closed = false;
    this.writeEmitter = new vscode.EventEmitter();
    this.closeEmitter = new vscode.EventEmitter();
    this.onDidWrite = this.writeEmitter.event;
    this.onDidClose = this.closeEmitter.event;
  }

  write(text) {
    this.writeEmitter.fire(String(text).replace(/\r?\n/g, "\r\n"));
  }

  captureProblemOutput(chunk, output, state) {
    if (state.bytes >= 2 * 1024 * 1024) return;
    const text = chunk.toString("utf8");
    const remaining = 2 * 1024 * 1024 - state.bytes;
    const part = text.length > remaining ? text.slice(0, remaining) : text;
    output.push(part);
    state.bytes += Buffer.byteLength(part);
  }

  async runDefinition(def, stack) {
    const label = taskLabelOf(def, 0);
    if (stack.includes(label)) throw new Error(`任务依赖成环：${stack.concat(label).join(" → ")}`);
    if (this.runCache.has(label)) return this.runCache.get(label);
    const promise = this.runDefinitionOnce(def, stack);
    this.runCache.set(label, promise);
    return promise;
  }

  async runDefinitionOnce(def, stack) {
    const label = taskLabelOf(def, 0);
    const dependencies = dependsOnOf(def);
    const order = dependsOrderOf(def);
    if (order === "sequence") {
      for (const dependency of dependencies) await this.runDefinition(this.index.get(dependency), stack.concat(label));
    } else if (dependencies.length > 0) {
      const results = await Promise.allSettled(dependencies.map((dependency) => this.runDefinition(this.index.get(dependency), stack.concat(label))));
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    }

    const command = commandOf(def, this.folder);
    const cwd = cwdOf(def, this.folder);
    if (!command) {
      if (dependencies.length === 0) throw new Error(`任务「${label}」既没有 command，也没有 dependsOn`);
      return;
    }
    this.write(`\x1b[2m远端任务：${label}\x1b[0m\r\n\x1b[2m$ ${command}\x1b[0m\r\n\x1b[2m远端目录：${cwd}\x1b[0m\r\n\r\n`);
    const handle = await this.session.conn.execStream(command, { cwd });
    this.handles.add(handle);
    const problemOutput = [];
    const problemOutputState = { bytes: 0 };
    handle.stdout.on("data", (chunk) => {
      this.captureProblemOutput(chunk, problemOutput, problemOutputState);
      this.write(chunk.toString("utf8"));
    });
    const { code, stderr } = await handle.wait();
    this.handles.delete(handle);
    if (stderr && stderr.trim()) {
      this.captureProblemOutput(Buffer.from(stderr), problemOutput, problemOutputState);
      this.write(`\x1b[33m${stderr.replace(/\r?\n/g, "\r\n")}\x1b[0m`);
    }
    this.problems.push(...parseTaskProblems(problemOutput.join(""), def));
    if (code !== 0) throw new Error(`任务「${label}」失败，结束码 ${code}`);
  }

  reportProblems() {
    const diagnostics = this.deps.diagnostics;
    if (!diagnostics || this.problems.length === 0) return;
    diagnostics.clear();
    const grouped = new Map();
    for (const problem of this.problems) {
      const uri = remoteProblemUri(this.vscode, this.folder, problem.file);
      const key = uri.toString();
      if (!grouped.has(key)) grouped.set(key, { uri, items: [] });
      const startLine = Math.max(0, (problem.line || 1) - 1);
      const startColumn = Math.max(0, (problem.column || 1) - 1);
      const diagnostic = new this.vscode.Diagnostic(
        new this.vscode.Range(startLine, startColumn, startLine, startColumn + 1),
        problem.message,
        diagnosticSeverity(this.vscode, problem.severity),
      );
      diagnostic.source = "rce-remote-task";
      if (problem.code) diagnostic.code = String(problem.code);
      grouped.get(key).items.push(diagnostic);
    }
    for (const { uri, items } of grouped.values()) diagnostics.set(uri, items);
  }

  async open() {
    this.deps.log(`任务开始：${this.label}（background=${!!this.def.isBackground}）`);
    try {
      this.session = await this.deps.whenSession(this.folder.uri, 15000);
    } catch (err) {
      this.deps.log(`任务 ${this.label} 等会话失败：${err && err.message}`);
      this.write(`\x1b[31m等 SSH 会话失败：${err && err.message}\x1b[0m\r\n`);
      this.closeEmitter.fire(1);
      return;
    }
    if (!this.session) {
      this.deps.log(`任务 ${this.label} 没有 SSH 会话`);
      this.write(`\x1b[31m没有到 ${this.folder.uri.authority} 的 SSH 会话，「运行任务」前请先连接。\x1b[0m\r\n`);
      this.closeEmitter.fire(1);
      return;
    }
    try {
      this.index = taskIndex(this.vscode, this.folder, this.def, this.label);
      validateDependencyGraph(this.index, this.label);
      if (this.deps.diagnostics && definitionsHaveProblemMatchers(this.index, this.label)) this.deps.diagnostics.clear();
      await this.runDefinition(this.def, []);
      this.reportProblems();
      this.deps.log(`任务结束：${this.label}（0）`);
      this.closeEmitter.fire(0);
    } catch (err) {
      this.reportProblems();
      this.deps.log(`任务结束：${this.label}（1：${err && err.message}）`);
      this.write(`\x1b[31m${err && err.message ? err.message : String(err)}\x1b[0m\r\n`);
      this.closeEmitter.fire(1);
    }
  }

  close() {
    if (!this.closed) this.closed = true;
    for (const handle of this.handles) {
      try { handle.close(); } catch { /* 已经结束了 */ }
    }
    this.handles.clear();
  }

  handleInput(data) {
    // v1 不支持往任务里交互输入（要交互就用集成终端）
    if (data && data.includes("\u0003")) this.close();
  }

  setDimensions() {
    /* 任务输出不关心尺寸 */
  }

  dispose() {
    this.close();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

function makeTask(vscode, deps, folder, def, index) {
  const label = taskLabelOf(def, index);
  const command = commandOf(def, folder);
  const dependencies = dependsOnOf(def);
  // __folderUri：resolveTask 时用来把任务找回它属于哪个远端工作区
  const definition = { ...def, type: TASK_TYPE, label, __folderUri: folder.uri.toString() };
  const task = new vscode.Task(
    definition,
    folder,
    label,
    SOURCE,
    new vscode.CustomExecution(() => new RemoteTaskTerminal(vscode, deps, folder, definition, index)),
    // problemMatcher 由我们在远端执行链里解析，避免上游落到 file://。
    [],
  );
  task.detail = def.detail ? String(def.detail) : command || `依赖：${dependencies.join(" → ")}`;
  task.group = groupOf(vscode, def.group);
  task.isBackground = !!(def.isBackground || def.isBackgroundTask);
  task.presentationOptions = {
    echo: true,
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Shared,
    clear: false,
    close: false,
  };
  return task;
}

/** `type: "shell"`（或没写 type）的任务 = 远端 shell 任务；`type: "rce-remote"` 直接认 */
function isOurTask(def) {
  if (!def || typeof def !== "object") return false;
  const type = def.type;
  return type === undefined || type === null || type === "shell" || type === TASK_TYPE;
}

function createTaskProvider(vscode, deps) {
  const foldersOf = () => (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === "sshfs");

  return {
    /** 读每个远端工作区的 tasks.json（工作台已经替我们解析成配置，含注释也吃得下） */
    provideTasks() {
      const tasks = [];
      for (const folder of foldersOf()) {
        let defs;
        try {
          defs = vscode.workspace.getConfiguration("tasks", folder.uri).get("tasks");
        } catch (err) {
          deps.log(`读远端 tasks.json 失败（${folder.uri.toString()}）：${err && err.message}`);
          continue;
        }
        if (!Array.isArray(defs)) continue;
        for (const [i, def] of defs.entries()) {
          if (!isOurTask(def)) continue;
          try {
            tasks.push(makeTask(vscode, deps, folder, def, i));
          } catch (err) {
            deps.log(`任务「${def && def.label}」解析失败：${err && err.message}`);
          }
        }
      }
      deps.log(`任务：远端 tasks.json 提供 ${tasks.length} 个任务`);
      return tasks;
    },

    /** 「运行任务」按 label 找回来时走这里：definition 里存了原始定义，重建即可 */
    resolveTask(task) {
      const def = task.definition || {};
      const folder = (vscode.workspace.workspaceFolders || []).find((f) => f.uri.scheme === "sshfs" && f.uri.toString() === String(def.__folderUri));
      if (!folder || !isOurTask(def)) {
        deps.log(`resolveTask 失败：label=${def.label || "?"} folder=${def.__folderUri || "?"}`);
        return undefined;
      }
      return makeTask(vscode, deps, folder, def, 0);
    },
  };
}

module.exports = {
  createTaskProvider,
  TASK_TYPE,
  SOURCE,
  commandOf,
  cwdOf,
  taskLabelOf,
  problemMatchersOf,
  dependsOnOf,
  dependsOrderOf,
  parseTaskProblems,
  validateDependencyGraph,
};
