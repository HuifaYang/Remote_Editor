// `git diff` → 行级标记 + hunk 明细（分册 1 · A6）：纯函数
import type { GitDiff } from "./types.js";

/**
 * 解析 `git diff --no-color --unified=3 -M <path>` 的 stdout。
 * 行号一律是当前工作区文件的 1-based 行号。
 * 替换块规则：一个 `-` 块后紧跟 `+` 块 → 逐行配对，配上的 `+` 行算 modified，
 * 多出来的 `+` 行算 added；`-` 行始终进 deletedLines（UI 画红）。
 */
export function parseGitDiff(stdout: string, opts?: { deletedFile?: boolean }): GitDiff {
  const addedLines: number[] = [];
  const modifiedLines: number[] = [];
  const deletedLines: number[] = [];
  const hunks: GitDiff["hunks"] = [];
  const isDeletedFile = opts?.deletedFile ?? /^deleted file mode/m.test(stdout);

  let newLine = 0;
  let hunk: GitDiff["hunks"][number] | null = null;
  let hunkStart: number | null = null;   // hunk 内第一个变更行的新行号
  let pendingRemoved = 0;                // 当前未配对的 `-` 连续块长度

  for (const raw of stdout.split("\n")) {
    // 旧文件行号不需要（输出一律新文件视角），只取 `+c,d` 的 c
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      newLine = parseInt(header[1], 10);
      hunk = { startLine: newLine, removed: [], added: [] };
      hunkStart = null;
      pendingRemoved = 0;
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;                 // diff 头（diff --git / --- / +++ 等）跳过
    if (raw.startsWith("\\")) continue;  // "\ No newline at end of file"
    const tag = raw[0];
    const text = raw.slice(1);
    if (tag === " ") {
      pendingRemoved = 0;                // 上下文行隔断 `-`/`+` 配对
      newLine++;
    } else if (tag === "-") {
      if (hunkStart === null) hunkStart = newLine;
      pendingRemoved++;
      hunk.removed.push(text);
      deletedLines.push(newLine);
    } else if (tag === "+") {
      if (hunkStart === null) hunkStart = newLine;
      if (pendingRemoved > 0) {
        modifiedLines.push(newLine);     // 与 `-` 块逐行配对 → modified
        pendingRemoved--;
      } else {
        addedLines.push(newLine);        // 多出来的 `+` 行 → added
      }
      hunk.added.push(text);
      newLine++;
    }
    if (hunkStart !== null) hunk.startLine = hunkStart;
  }
  return { addedLines, modifiedLines, deletedLines, hunks, isDeletedFile };
}
