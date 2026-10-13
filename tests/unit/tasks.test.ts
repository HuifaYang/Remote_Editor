// 分册 4：远端 tasks.json 的纯函数回归。TaskProvider 本身靠 E2E 真跑 CodeOSS，
// 这里覆盖依赖图校验与 problemMatcher 解析，避免“字段塞了但没执行/没进 Problems”。
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tasks = require("../../ide/extensions/sshfs/src/tasks.js") as {
  commandOf: (def: Record<string, unknown>, folder: unknown) => string;
  cwdOf: (def: Record<string, unknown>, folder: unknown) => string;
  problemMatchersOf: (def: Record<string, unknown>) => unknown[];
  dependsOnOf: (def: Record<string, unknown>) => string[];
  dependsOrderOf: (def: Record<string, unknown>) => string;
  parseTaskProblems: (output: string, def: Record<string, unknown>) => Array<Record<string, unknown>>;
  validateDependencyGraph: (defs: Map<string, Record<string, unknown>>, root: string) => void;
};

const folder = { uri: { path: "/ws" } };

describe("远端任务纯函数", () => {
  it("test_command_env_args_and_workspace_variables", () => {
    expect(tasks.commandOf({
      command: "sh -c 'echo ${workspaceFolderBasename}'",
      args: ["a b", "${workspaceFolder}/x"],
      options: { env: { FOO: "x y" } },
    }, folder)).toBe("FOO='x y' sh -c 'echo ws' 'a b' '/ws/x'");
    expect(tasks.cwdOf({ options: { cwd: "src" } }, folder)).toBe("/ws/src");
  });

  it("test_depends_on_supports_string_and_object_forms", () => {
    expect(tasks.dependsOnOf({ dependsOn: ["a", { label: "b" }, { taskName: "c" }] })).toEqual(["a", "b", "c"]);
    expect(tasks.dependsOrderOf({ dependsOrder: "sequence" })).toBe("sequence");
    expect(tasks.dependsOrderOf({})).toBe("parallel");
  });

  it("test_problem_matcher_normalizes_single_and_array_forms", () => {
    expect(tasks.problemMatchersOf({ problemMatcher: "$msCompile" })).toEqual(["$msCompile"]);
    expect(tasks.problemMatchersOf({ problemMatcher: ["$gcc", "$tsc"] })).toEqual(["$gcc", "$tsc"]);
    expect(tasks.problemMatchersOf({ problemMatchers: ["$gcc"] })).toEqual(["$gcc"]);
  });

  it("test_parse_mscompile_and_gcc_problems", () => {
    expect(tasks.parseTaskProblems("src/main.c(3,7): error C1234: bad call\n", { problemMatcher: "$msCompile" }))
      .toEqual([{ file: "src/main.c", line: 3, column: 7, severity: "error", code: "C1234", message: "bad call" }]);
    expect(tasks.parseTaskProblems("src/main.c:9:2: warning: unused\n", { problemMatcher: "$gcc" }))
      .toEqual([{ file: "src/main.c", line: 9, column: 2, severity: "warning", code: undefined, message: "unused" }]);
  });

  it("test_parse_inline_problem_matcher", () => {
    const def = {
      problemMatcher: {
        pattern: {
          regexp: "^(.+):(\\d+):(\\d+): (error|warning): (.*)$",
          file: 1,
          line: 2,
          column: 3,
          severity: 4,
          message: 5,
        },
      },
    };
    expect(tasks.parseTaskProblems("src/a.c:5:2: error: custom\n", def))
      .toEqual([{ file: "src/a.c", line: 5, column: 2, severity: "error", code: undefined, message: "custom" }]);
  });

  it("test_dependency_graph_accepts_valid_dag_and_rejects_cycle_or_missing", () => {
    const valid = new Map<string, Record<string, unknown>>([
      ["build", { label: "build", dependsOn: ["compile", "lint"] }],
      ["compile", { label: "compile", dependsOn: ["prepare"] }],
      ["lint", { label: "lint" }],
      ["prepare", { label: "prepare" }],
    ]);
    expect(() => tasks.validateDependencyGraph(valid, "build")).not.toThrow();

    const cyclic = new Map<string, Record<string, unknown>>([
      ["a", { label: "a", dependsOn: ["b"] }],
      ["b", { label: "b", dependsOn: ["a"] }],
    ]);
    expect(() => tasks.validateDependencyGraph(cyclic, "a")).toThrow(/依赖成环/);
    expect(() => tasks.validateDependencyGraph(valid, "missing")).toThrow(/不存在/);
  });
});
