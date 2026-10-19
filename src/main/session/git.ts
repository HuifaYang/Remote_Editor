// 远端 Git（总纲 §5.4，行为参照旧代码 app/git/）：往返预算是硬约束
import { AppError } from "../../shared/errors.js";
import { parseGitDiff } from "../../shared/diff-parser.js";
import { layout } from "../../shared/graph.js";
import { parsePorcelain, TreeStatus } from "../../shared/git-status.js";
import { normalizeRemotePath, shellQuote } from "../../shared/paths.js";
import type { BranchInfo, CommitInfo, GitDiff, GitFileStatus, GitTreeStatus, GraphRow } from "../../shared/types.js";
import type { SSHConnection } from "./connection.js";

/** 名称校验（分册 5 G3）：分支/远程/标签共用 */
function validateName(name: string): void {
  if (!name || name.startsWith("-")) throw new AppError("invalid-input", "名称无效", "名称不能为空或以 - 开头");
  if (/[~^:?*[\\]\\s]/.test(name)) throw new AppError("invalid-input", "名称无效", "名称包含非法字符");
  if (name.endsWith(".lock")) throw new AppError("invalid-input", "名称无效", "名称不能以 .lock 结尾");
  if (name.includes("..")) throw new AppError("invalid-input", "名称无效", "名称不能包含 ..");
}

const EMPTY_DIFF: GitDiff = { addedLines: [], modifiedLines: [], deletedLines: [], hunks: [], isDeletedFile: false };

export class GitRemote {
  /** 每个工作目录的最新快照（保存/删除后本地更新，不重扫仓库） */
  private readonly trees = new Map<string, TreeStatus>();

  constructor(private readonly conn: SSHConnection) {}

  /** 当前快照（供 UI 复用：打开 SCM 面板 0 远端请求） */
  treeFor(directory: string): TreeStatus | undefined {
    return this.trees.get(normalizeRemotePath(directory, "/"));
  }

  private async mustExec(command: string, cwd: string, what: string): Promise<string> {
    const r = await this.conn.exec(command, { cwd });
    if (r.code !== 0) throw new AppError("git", `${what}失败`, r.stderr.trim() || r.stdout.trim());
    return r.stdout;
  }

  async repoInfo(directory: string): Promise<{ isRepository: boolean; root: string; branch: string }> {
    const dir = normalizeRemotePath(directory, "/");
    const r = await this.conn.exec("git rev-parse --show-toplevel --abbrev-ref HEAD", { cwd: dir });
    if (r.code !== 0) return { isRepository: false, root: "", branch: "" };
    const [root = "", branch = ""] = r.stdout.split("\n").map((s) => s.trim());
    return { isRepository: true, root, branch };
  }

  /** 往返预算 = 2 条命令（rev-parse 合并 + status），多一条即返工（§5.4.1） */
  async treeStatus(directory: string): Promise<GitTreeStatus> {
    const dir = normalizeRemotePath(directory, "/");
    // 一条命令同时拿 root / branch / HEAD / 工作区前缀 / upstream。历史图与 Quick Diff
    // 都需要这些信息；尤其是 /home → /robotdata 这种 canonical root 与打开路径不一致时，
    // workspacePrefix 能避免 UI 路径被错误地拿 canonical root 做前缀判断。
    const info = await this.mustExec(
      "git rev-parse --show-toplevel --abbrev-ref HEAD; "
      + "git rev-parse --verify HEAD 2>/dev/null || true; "
      + "git rev-parse --show-prefix 2>/dev/null || true; "
      + "git rev-parse --symbolic-full-name @{u} 2>/dev/null || true; "
      + "git rev-parse @{u} 2>/dev/null || true",
      dir,
      "读取仓库信息",
    );
    const lines = info.split("\n").map((s) => s.trim());
    const [root = "", branch = "", headCommit = "", workspacePrefix = "", upstreamRef = "", upstreamCommit = ""] = lines;
    if (!root) throw new AppError("git", "不是 Git 仓库", dir);
    const status = await this.mustExec("git status --porcelain -uall", root, "git status");
    const tree = TreeStatus.fromParsed(root, dir, branch, parsePorcelain(status));
    this.trees.set(dir, tree);
    const snapshot = tree.toSnapshot();
    return {
      ...snapshot,
      headCommit: headCommit || undefined,
      workspacePrefix: workspacePrefix || undefined,
      upstreamRef: upstreamRef || undefined,
      upstreamCommit: upstreamCommit || undefined,
    };
  }

  /**
   * 行级差异。往返预算（§5.4.2）：
   * 快照判「未变更」→ 0 条 git 命令；未跟踪文件（有内容）→ 0 条；已修改 → 1 条 git diff。
   */
  async fileDiff(directory: string, relPath: string, content?: string, status?: GitFileStatus): Promise<GitDiff> {
    if (status && status.change === null) return { ...EMPTY_DIFF };
    if (status?.letter === "U") {
      if (content === undefined) throw new AppError("invalid-input", "未跟踪文件需要提供当前内容");
      const lines = content.length > 0 ? content.split("\n") : [];
      return {
        addedLines: lines.map((_, i) => i + 1),
        modifiedLines: [],
        deletedLines: [],
        hunks: lines.length > 0 ? [{ startLine: 1, removed: [], added: lines }] : [],
        isDeletedFile: false,
      };
    }
    const root = normalizeRemotePath(directory, "/");
    const stdout = await this.mustExec(`git diff --no-color --unified=3 -M -- ${shellQuote(relPath)}`, root, "git diff");
    return parseGitDiff(stdout, { deletedFile: status?.change === "deleted" });
  }


  /** 默认提交（分册 5 G4.2）：只提交已暂存内容，不执行 add -A */
  async commitStaged(directory: string, message: string, opts?: { amend?: boolean }): Promise<string> {
    const root = normalizeRemotePath(directory, "/");
    if (!opts?.amend && !message) throw new AppError("invalid-input", "提交信息不能为空");
    const cmd = opts?.amend
      ? message ? `git commit --amend -m ${shellQuote(message)}` : "git commit --amend --no-edit"
      : `git commit -m ${shellQuote(message)}`;
    return (await this.mustExec(cmd, root, "提交")).trim();
  }

  /** commitAll = git add -A + git commit（§5.4.4）；amend 空信息时 --no-edit */
  async commitAll(directory: string, message: string, opts?: { amend?: boolean }): Promise<string> {
    const root = normalizeRemotePath(directory, "/");
    if (!opts?.amend && !message) throw new AppError("invalid-input", "提交信息不能为空");
    await this.mustExec("git add -A", root, "暂存");
    const cmd = opts?.amend
      ? message ? `git commit --amend -m ${shellQuote(message)}` : "git commit --amend --no-edit"
      : `git commit -m ${shellQuote(message)}`;
    return (await this.mustExec(cmd, root, "提交")).trim();
  }

  /** 无上游分支时自动 `git push -u origin <branch>`（§5.4.5）；push 输出走 stderr，故合并返回 */
  async push(directory: string): Promise<string> {
    const root = normalizeRemotePath(directory, "/");
    let r = await this.conn.exec("git push", { cwd: root });
    if (r.code !== 0 && /no upstream branch|has no upstream branch/.test(r.stderr)) {
      const branch = (await this.mustExec("git rev-parse --abbrev-ref HEAD", root, "读取当前分支")).trim();
      r = await this.conn.exec(`git push -u origin ${shellQuote(branch)}`, { cwd: root });
    }
    if (r.code !== 0) throw new AppError("git", "推送失败", r.stderr.trim());
    return (r.stdout + r.stderr).trim();
  }

  /** pull（失败退 --rebase）→ push（§5.4 签名注释） */
  async sync(directory: string): Promise<string> {
    const root = normalizeRemotePath(directory, "/");
    const r = await this.conn.exec("git pull", { cwd: root });
    if (r.code !== 0) {
      const rebased = await this.conn.exec("git pull --rebase", { cwd: root });
      if (rebased.code !== 0) throw new AppError("git", "同步失败（拉取）", rebased.stderr.trim());
    }
    return this.push(root);
  }

  /** `git branch -a`（板子 git 可能很老，不用 --format） */
  async branches(directory: string): Promise<BranchInfo[]> {
    const root = normalizeRemotePath(directory, "/");
    // 用 for-each-ref 而不是 git branch -a：需要每个分支的 commit hash（revision）与 upstream。
    // CodeOSS 的历史图用 ref.revision 去定位提交与配色，缺了它整张图会退化（只剩一条线）。
    const format = "%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)";
    const stdout = await this.mustExec(
      `git for-each-ref --format=${shellQuote(format)} refs/heads refs/remotes`,
      root,
      "读取分支列表",
    );
    const out: BranchInfo[] = [];
    for (const raw of stdout.split("\n")) {
      if (!raw.trim()) continue;
      const [refname = "", revision = "", head = "", upstream = ""] = raw.split("\0");
      if (!refname) continue;
      // refs/remotes/origin/HEAD 是符号引用，跳过（否则图里会多一个 origin/HEAD 别名）
      if (refname.endsWith("/HEAD")) continue;
      const remote = refname.startsWith("refs/remotes/");
      const name = refname.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
      out.push({ name, current: head.trim() === "*", remote, upstream, detached: false, revision });
    }
    return out;
  }

  /** 用 checkout 不用 switch（板子 git 可能很老，§5.4.6）；分支名以 - 开头或为空 → invalid-input */
  async switchBranch(directory: string, name: string): Promise<string> {
    if (!name || name.startsWith("-")) throw new AppError("invalid-input", "分支名无效", name);
    const root = normalizeRemotePath(directory, "/");
    const r = await this.conn.exec(`git checkout ${shellQuote(name)}`, { cwd: root });
    if (r.code !== 0) throw new AppError("git", "切换分支失败", r.stderr.trim());
    return (r.stdout + r.stderr).trim();
  }

  /** 检出某个提交（游离 HEAD）——历史图上"检出此提交" */
  async checkoutRev(directory: string, rev: string): Promise<string> {
    const root = normalizeRemotePath(directory, "/");
    const r = await this.conn.exec(`git checkout ${shellQuote(rev)}`, { cwd: root });
    if (r.code !== 0) throw new AppError("git", "检出提交失败", r.stderr.trim());
    return (r.stdout + r.stderr).trim();
  }

  /** 撤销某条提交（生成一条反向提交，不改历史） */
  async revert(directory: string, rev: string): Promise<string> {
    const root = normalizeRemotePath(directory, "/");
    await this.mustExec(`git revert --no-edit ${shellQuote(rev)}`, root, "撤销提交");
    return "";
  }

  /** 硬重置到某条提交（会丢改动，调用方必须先确认） */
  async resetHard(directory: string, rev: string): Promise<string> {
    const root = normalizeRemotePath(directory, "/");
    await this.mustExec(`git reset --hard ${shellQuote(rev)}`, root, "重置到提交");
    return "";
  }

  /** 一条 git log → CommitInfo[] → 泳道布局（§5.4.7） */
  async logGraph(directory: string, limit = 200, refs: readonly string[] = [], skip = 0): Promise<GraphRow[]> {
    const root = normalizeRemotePath(directory, "/");
    const format = "%H%x00%P%x00%an%x00%ad%x00%s%x00%D";
    const uniqueRefs = [...new Set(refs.filter((ref) => typeof ref === "string" && ref.length > 0))];
    const revisions = uniqueRefs.length > 0
      ? uniqueRefs.map(shellQuote).join(" ")
      : "--all";
    const skipArgs = skip > 0 ? ` --skip=${Math.floor(skip)}` : "";
    const stdout = await this.mustExec(
      // --topo-order（而不是 --date-order）：CodeOSS 的图渲染器按数组顺序 + parentIds 重建泳道，
      // 要求严格拓扑序（子提交一定排在父提交之前）。date-order 在有多分支/合并时会打乱顺序，
      // 渲染器对不上就塌成一条线。内置 git 扩展也用的是 topo-order。
      `git log --topo-order --decorate=full --max-count=${Math.floor(limit)}${skipArgs} --pretty=format:${shellQuote(format)} ${revisions}`,
      root,
      "读取提交历史",
    );
    const commits: CommitInfo[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [hash = "", parents = "", author = "", date = "", subject = "", refs = ""] = line.split("\0");
      if (!hash) continue;
      commits.push({
        hash,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        author,
        date,
        subject,
        refs: refs ? refs.split(",").map((s) => s.trim()).filter(Boolean) : [],
      });
    }
    return layout(commits);
  }

  /**
   * 某个提交改了哪些文件（历史图里点开一条提交时用）。
   * `--root` 让仓库的第一个提交也能列出全部文件；rename 会带出旧路径，交给上层裁成新路径。
   */
  async commitChanges(directory: string, rev: string, parentId?: string): Promise<Array<{ status: string; path: string }>> {
    const root = normalizeRemotePath(directory, "/");
    // 合并提交有多个父提交，git diff-tree 默认不会输出；历史图已经给了首父，直接做两树比较。
    const command = parentId
      ? `git diff --name-status -r ${shellQuote(parentId)} ${shellQuote(rev)}`
      : `git diff-tree --no-commit-id --name-status -r --root ${shellQuote(rev)}`;
    const out = await this.mustExec(
      command,
      root,
      "读取提交变更",
    );
    const files: Array<{ status: string; path: string }> = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const status = (parts[0] || "").trim();
      // R100\told\tnew / C100\told\tnew：取新路径
      const file = (parts.length > 2 ? parts[parts.length - 1] : parts[1] || "").trim();
      if (file) files.push({ status: status.charAt(0) || "M", path: file });
    }
    return files;
  }

  // ---- M5：暂存区 / 逐文件操作（每次一条命令，路径一律 shellQuote）----

  /** 暂存指定文件：git add -- <paths> */
  async stage(directory: string, paths: string[]): Promise<void> {
    if (paths.length === 0) throw new AppError("invalid-input", "至少选择一个文件");
    const root = normalizeRemotePath(directory, "/");
    await this.mustExec(`git add -- ${paths.map(shellQuote).join(" ")}`, root, "暂存文件");
    this.markStaged(root, paths, true);
  }

  /** 全部暂存 */
  async stageAll(directory: string): Promise<void> {
    const root = normalizeRemotePath(directory, "/");
    await this.mustExec("git add -A", root, "暂存全部更改");
    void this.treeStatus(root).catch(() => { /* 本地更新失败下次刷新兜底 */ });
  }

  /** 取消暂存指定文件 */
  async unstage(directory: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const root = normalizeRemotePath(directory, "/");
    const restore = await this.conn.exec(`git restore --staged -- ${paths.map(shellQuote).join(" ")}`, { cwd: root });
    if (restore.code !== 0) {
      const reset = await this.conn.exec(`git reset HEAD -- ${paths.map(shellQuote).join(" ")}`, { cwd: root });
      if (reset.code !== 0) throw new AppError("git", "取消暂存失败", reset.stderr.trim());
    }
    this.markStaged(root, paths, false);
  }

  /** 全部取消暂存（HEAD 还没有提交时 git restore 会失败，退化为 reset） */
  async unstageAll(directory: string): Promise<void> {
    const root = normalizeRemotePath(directory, "/");
    const r = await this.conn.exec("git restore --staged .", { cwd: root });
    if (r.code !== 0) {
      const fallback = await this.conn.exec("git reset -q", { cwd: root });
      if (fallback.code !== 0) throw new AppError("git", "取消全部暂存失败", fallback.stderr.trim());
    }
    void this.treeStatus(root).catch(() => { /* 同上 */ });
  }

  /** 丢弃工作区修改（会丢内容，UI 必须二次确认） */
  async discard(directory: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const root = normalizeRemotePath(directory, "/");
    await this.mustExec(`git restore -- ${paths.map(shellQuote).join(" ")}`, root, "丢弃修改");
    void this.treeStatus(root).catch(() => { /* 同上 */ });
  }

  /** 移除未跟踪文件/目录（丢弃新增文件用） */
  async clean(directory: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const root = normalizeRemotePath(directory, "/");
    await this.mustExec(`git clean -fd -- ${paths.map(shellQuote).join(" ")}`, root, "删除未跟踪文件");
    void this.treeStatus(root).catch(() => { /* 同上 */ });
  }

  // ---- M5：仓库管理（远程 / stash / 标签 / 分支 / 克隆 / 初始化）----

  async stashList(directory: string): Promise<Array<{ index: number; message: string; date: string }>> {
    const root = normalizeRemotePath(directory, "/");
    const out = await this.mustExec("git stash list --date=iso", root, "读取 stash");
    return out.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
      const m = /^stash@\{(\d+)\}.*: (.*)$/.exec(line);
      const index = m ? Number(m[1]) : -1;
      const message = m ? m[2] : line;
      return { index, message, date: "" };
    });
  }

  async stashSave(directory: string, message: string): Promise<void> {
    const root = normalizeRemotePath(directory, "/");
    const r = await this.conn.exec(`git stash push -m ${shellQuote(message)}`, { cwd: root });
    if (r.code !== 0) {
      const fallback = await this.conn.exec(`git stash save ${shellQuote(message)}`, { cwd: root });
      if (fallback.code !== 0) throw new AppError("git", "stash 存入失败", fallback.stderr.trim());
    }
  }

  async stashPop(directory: string, index?: number): Promise<void> {
    const root = normalizeRemotePath(directory, "/");
    const spec = index === undefined ? "" : ` stash@{${index}}`;
    const r = await this.conn.exec(`git stash pop${spec}`, { cwd: root });
    if (r.code !== 0) throw new AppError("git", "弹出暂存失败：请先保存或提交工作区更改。", r.stderr.trim());
  }

  async stashDrop(directory: string, index: number): Promise<void> {
    const root = normalizeRemotePath(directory, "/");
    const r = await this.conn.exec(`git stash drop stash@{${index}}`, { cwd: root });
    if (r.code !== 0) throw new AppError("git", "丢弃暂存失败", r.stderr.trim());
  }

  async tags(directory: string): Promise<Array<{ name: string; hash: string; message: string; date: string }>> {
    const root = normalizeRemotePath(directory, "/");
    const format = "%(refname:short)%09%(objectname:short)%09%(contents:subject)%09%(creatordate:iso)";
    const out = await this.mustExec(
      `git for-each-ref --sort=-creatordate --format=${shellQuote(format)} refs/tags`,
      root,
      "读取标签",
    );
    return out.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name = "", hash = "", message = "", date = ""] = line.split("\t");
      return { name, hash, message, date };
    });
  }

  async createTag(directory: string, name: string, message: string): Promise<void> {
    validateName(name);
    const root = normalizeRemotePath(directory, "/");
    await this.mustExec(`git tag -a ${shellQuote(name)} -m ${shellQuote(message)}`, root, "创建标签");
  }

  async deleteTag(directory: string, name: string): Promise<void> {
    validateName(name);
    const root = normalizeRemotePath(directory, "/");
    await this.mustExec(`git tag -d ${shellQuote(name)}`, root, "删除标签");
  }

  async remotes(directory: string): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>> {
    const root = normalizeRemotePath(directory, "/");
    const out = await this.mustExec("git remote -v", root, "读取远程仓库");
    const seen = new Map<string, { fetchUrl: string; pushUrl: string }>();
    for (const line of out.split("\n")) {
      const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
      if (!m) continue;
      const [, name, url, kind] = m;
      const item = seen.get(name) ?? { fetchUrl: "", pushUrl: "" };
      if (kind === "fetch") item.fetchUrl = url;
      if (kind === "push") item.pushUrl = url;
      seen.set(name, item);
    }
    return [...seen].map(([name, v]) => ({ name, ...v }));
  }

  async removeRemote(directory: string, name: string): Promise<void> {
    validateName(name);
    const root = normalizeRemotePath(directory, "/");
    await this.mustExec(`git remote remove ${shellQuote(name)}`, root, "删除远程仓库");
  }

  async setRemoteUrl(directory: string, name: string, url: string): Promise<void> {
    validateName(name);
    const root = normalizeRemotePath(directory, "/");
    await this.mustExec(`git remote set-url ${shellQuote(name)} ${shellQuote(url)}`, root, "修改远程地址");
  }

  async addRemote(directory: string, name: string, url: string): Promise<void> {
    const root = normalizeRemotePath(directory, "/");
    await this.mustExec(`git remote add ${shellQuote(name)} ${shellQuote(url)}`, root, "添加远程仓库");
  }

  async fetch(directory: string): Promise<string> {
    const root = normalizeRemotePath(directory, "/");
    return this.mustExec("git fetch --all --prune", root, "fetch");
  }

  /** 克隆到指定目录（在父目录执行，目标目录不能已存在内容） */
  async clone(url: string, targetDir: string, opts?: { branch?: string }): Promise<string> {
    const target = normalizeRemotePath(targetDir, "/");
    const parent = target.slice(0, target.lastIndexOf("/")) || "/";
    const name = target.slice(target.lastIndexOf("/") + 1);
    const branch = opts?.branch ? `--branch ${shellQuote(opts.branch)} ` : "";
    const r = await this.conn.exec(`git clone ${branch}-- ${shellQuote(url)} ${shellQuote(name)}`, { cwd: parent });
    if (r.code !== 0) throw new AppError("git", "克隆失败", r.stderr.trim() || r.stdout.trim());
    return (r.stdout + r.stderr).trim();
  }

  async createBranch(directory: string, name: string, opts?: { checkout?: boolean }): Promise<void> {
    validateName(name);
    const root = normalizeRemotePath(directory, "/");
    await this.mustExec(`git branch ${shellQuote(name)}`, root, "创建分支");
    if (opts?.checkout) await this.mustExec(`git checkout ${shellQuote(name)}`, root, "切换分支");
  }

  async deleteBranch(directory: string, name: string): Promise<void> {
    validateName(name);
    const root = normalizeRemotePath(directory, "/");
    const r = await this.conn.exec(`git branch -d ${shellQuote(name)}`, { cwd: root });
    if (r.code !== 0) {
      throw new AppError("git", `删除失败：分支 "${name}" 尚未合并。\n\n如需强制删除，请在终端执行 git branch -D。`, r.stderr.trim());
    }
  }

  async mergeBranch(directory: string, name: string): Promise<string> {
    validateName(name);
    const root = normalizeRemotePath(directory, "/");
    const r = await this.conn.exec(`git merge --no-ff ${shellQuote(name)}`, { cwd: root });
    if (r.code !== 0) throw new AppError("git", "合并冲突：请在编辑器或终端中解决冲突后提交。", r.stderr.trim());
    return (r.stdout + r.stderr).trim();
  }

  async init(directory: string): Promise<string> {
    const root = normalizeRemotePath(directory, "/");
    return this.mustExec("git init", root, "初始化仓库");
  }

  /** 暂存状态本地更新（暂存/取消暂存后不重扫仓库，§7 预算） */
  private markStaged(root: string, paths: string[], staged: boolean): void {
    const tree = this.trees.get(root);
    if (!tree) return;
    for (const p of paths) tree.markStaged(p, staged);
  }
}
