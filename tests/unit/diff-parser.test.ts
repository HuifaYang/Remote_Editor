// T2.11/12 + §10.1 diff-parser 行：git diff 解析（样例来自分册 1 · A6）
import { describe, expect, it } from "vitest";
import { parseGitDiff } from "../../src/shared/diff-parser";

describe("parseGitDiff（A6）", () => {
  it("test_diff_parser_maps_modified_and_added", () => {
    // Given 一个替换块（-1 行 +2 行）When 解析 Then 配对行算 modified、多余行算 added
    const stdout = [
      "diff --git a/f.c b/f.c",
      "--- a/f.c",
      "+++ b/f.c",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-old line",
      "+new line A",
      "+new line B",
      " line3",
      "",
    ].join("\n");
    const diff = parseGitDiff(stdout);
    expect(diff.modifiedLines).toEqual([2]);      // "new line A" 是替换
    expect(diff.addedLines).toEqual([3]);         // "new line B" 是纯新增
    expect(diff.deletedLines).toEqual([2]);       // 被删行仍画红
    expect(diff.hunks).toEqual([{ startLine: 2, removed: ["old line"], added: ["new line A", "new line B"] }]);
    expect(diff.isDeletedFile).toBe(false);
  });
  it("test_diff_parser_marks_deleted_file", () => {
    // Given deleted file 头的 diff Then isDeletedFile=true，且没有任何新增行
    const stdout = [
      "diff --git a/f.c b/f.c",
      "deleted file mode 100644",
      "--- a/f.c",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line1",
      "-line2",
      "",
    ].join("\n");
    const diff = parseGitDiff(stdout);
    expect(diff.isDeletedFile).toBe(true);
    expect(diff.addedLines).toEqual([]);
    expect(diff.modifiedLines).toEqual([]);
  });
  it("test_diff_parser_mid_file_pure_deletion", () => {
    // Given 中段纯删除（`-` 块后是上下文行）Then 保持 deletedLines（A6 规则 5 后半句）
    const stdout = [
      "@@ -1,3 +1,2 @@",
      " line1",
      "-gone",
      " line3",
      "",
    ].join("\n");
    const diff = parseGitDiff(stdout);
    expect(diff.deletedLines).toEqual([2]);   // 删除位置 = 下一新行所在处
    expect(diff.addedLines).toEqual([]);
    expect(diff.modifiedLines).toEqual([]);
  });
  it("test_diff_parser_status_override_marks_deleted", () => {
    const diff = parseGitDiff("", { deletedFile: true });
    expect(diff.isDeletedFile).toBe(true);
  });
});
