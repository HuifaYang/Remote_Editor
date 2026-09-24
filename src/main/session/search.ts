// 全局搜索（总纲 §5.7 + 分册 1 · A10）：一条 grep 命令，往返预算 1
import { AppError } from "../../shared/errors.js";
import { shellQuote } from "../../shared/paths.js";
import type { SearchMatch } from "../../shared/types.js";
import type { SSHConnection } from "./connection.js";

const RESULT_CAP = 500;   // §5.7：结果上限 500 条

/** A10：解析 grep stdout，每行 `路径:行号:内容`（最多切 2 刀）；行号非数字跳过；500 条截断 */
export function parseSearchResults(stdout: string, cap: number = RESULT_CAP): SearchMatch[] {
  const out: SearchMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (out.length >= cap) break;
    if (!line) continue;
    const i1 = line.indexOf(":");
    if (i1 <= 0) continue;
    const i2 = line.indexOf(":", i1 + 1);
    if (i2 < 0) continue;
    const num = Number(line.slice(i1 + 1, i2));
    if (!Number.isInteger(num)) continue;
    out.push({ path: line.slice(0, i1), line: num, text: line.slice(i2 + 1) });
  }
  return out;
}

export class SearchRemote {
  constructor(private readonly conn: SSHConnection) {}

  async search(workspace: string, pattern: string, opts: { caseSensitive: boolean; regex: boolean }): Promise<SearchMatch[]> {
    if (!pattern) throw new AppError("invalid-input", "搜索关键字不能为空");
    const flags = opts.regex ? "-E" : "-F";
    const icase = opts.caseSensitive ? "" : " -i";
    // -e 保护以 - 开头的关键字；-- 之后是路径
    const cmd =
      `grep -r -n -I -m 200 ${flags}${icase}` +
      ` --exclude-dir=.git --exclude-dir=build --exclude-dir=install --exclude-dir=log` +
      ` --exclude-dir=__pycache__ --exclude-dir=node_modules` +
      ` -e ${shellQuote(pattern)} -- ${shellQuote(workspace)}`;
    const r = await this.conn.exec(cmd, { timeoutMs: 60000 });
    if (r.code === 1) return [];                     // grep 退出码 1 = 无匹配，不算失败
    if (r.code !== 0) throw new AppError("ssh", "搜索失败", r.stderr.trim());
    return parseSearchResults(r.stdout);
  }
}
