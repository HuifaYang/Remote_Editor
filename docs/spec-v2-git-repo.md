# 分册 5 · Git 仓库管理（暂存区 + 仓库级操作）

> 本分册**扩展并部分覆盖**主规格的 SCM 规格：`docs/spec-v2-ui.md` 的 **U4「源代码管理」**按本分册改造（「更改」单组 → 「暂存的更改 / 更改」两组），其余 U4 条目不变。API 以本分册为准（在主规格 §5.4 `GitRemote` 上追加）。

---

## G1 范围（做什么 / 不做什么）

**做**：
1. **暂存区**：逐文件暂存 / 撤销暂存、全部暂存 / 全部撤销、分组显示（已暂存 N / 更改 M）。
2. **提交语义**：默认只提交已暂存内容；无暂存时弹确认（见 G4）。
3. **远程仓库管理**：查看 `origin` 等远程的 fetch/push 地址、新增 / 删除 / 修改地址。
4. **stash**：列表 / 存入 / 弹出 / 丢弃。
5. **标签**：列表 / 创建（附注标签）/ 删除。
6. **克隆 / 初始化**：`git clone` 到远端目录、`git init`。
7. **分支管理**：新建分支、删除本地分支、把某分支合并到当前分支。
8. `.gitignore`：当作**普通文件**用编辑器改（不写专用 API）。

**不做**（明确排除，实现者不要做）：worktree、submodule、交互式 rebase、冲突解决器（只提示用户去编辑器/终端处理）、GitHub/GitLab 账号登录（远端只有 SSH）。

---

## G2 API（追加到 `src/main/session/git.ts`，签名是契约）

```ts
// —— 暂存区 ——
stage(directory: string, paths: string[]): Promise<void>        // 相对仓库根路径
unstage(directory: string, paths: string[]): Promise<void>

// —— 远程仓库 ——
remotes(directory: string): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>>
addRemote(directory: string, name: string, url: string): Promise<void>
removeRemote(directory: string, name: string): Promise<void>
setRemoteUrl(directory: string, name: string, url: string): Promise<void>

// —— stash ——
stashList(directory: string): Promise<Array<{ index: number; message: string; date: string }>>
stashSave(directory: string, message: string): Promise<void>
stashPop(directory: string, index?: number): Promise<void>
stashDrop(directory: string, index: number): Promise<void>

// —— 标签 ——
tags(directory: string): Promise<Array<{ name: string; hash: string; message: string; date: string }>>
createTag(directory: string, name: string, message: string): Promise<void>   // 附注标签
deleteTag(directory: string, name: string): Promise<void>

// —— 分支管理 ——
createBranch(directory: string, name: string, opts?: { checkout?: boolean }): Promise<void>
deleteBranch(directory: string, name: string): Promise<void>       // 仅本地分支
mergeBranch(directory: string, name: string): Promise<string>      // 合并到当前分支，返回输出

// —— 克隆 / 初始化 ——
clone(url: string, targetDir: string, opts?: { branch?: string }): Promise<void>
init(directory: string): Promise<void>
```

---

## G3 命令映射（逐 API → git 命令，**照此拼**）

| API | 命令 | 备注 |
| --- | --- | --- |
| `stage` | `git add -- <q(path1)> <q(path2)> …` | 至少一个路径，空数组抛 `invalid-input` |
| `unstage` | `git restore --staged -- <paths>` | **git < 2.23 回退** `git reset HEAD -- <paths>`（`restore` 报 `unknown command`/`restore` 不存在时重试一次） |
| `remotes` | `git remote -v` | 解析 `name\tfetchUrl (fetch)` / `name\tpushUrl (push)` 两行合并 |
| `addRemote` | `git remote add <q(name)> <q(url)>` | name 只允许 `[A-Za-z0-9_.-]+`，否则 `invalid-input` |
| `removeRemote` | `git remote remove <q(name)>` | |
| `setRemoteUrl` | `git remote set-url <q(name)> <q(url)>` | |
| `stashList` | `git stash list --date=iso` | 解析 `stash@{N}\ton <branch>: <msg>` |
| `stashSave` | `git stash push -m <q(message)>` | git < 2.13 回退 `git stash save <q(message)>` |
| `stashPop` | `git stash pop [stash@{N}]` | index 省略 = pop 最新 |
| `stashDrop` | `git stash drop stash@{N}` | |
| `tags` | `git for-each-ref --sort=-creatordate --format=%(refname:short)%09%(objectname:short)%09%(contents:subject)%09%(creatordate:iso) refs/tags` | |
| `createTag` | `git tag -a <q(name)> -m <q(message)>` | name 校验同分支名规则（见下） |
| `deleteTag` | `git tag -d <q(name)>` | |
| `createBranch` | `git branch <q(name)> [<q(current)>]` + `opts.checkout` 时 `git checkout <q(name)>` | |
| `deleteBranch` | `git branch -d <q(name)>` | 失败（未合并）时**不**自动 `-D`，抛 `git` 错误并在文案里说明 |
| `mergeBranch` | `git merge --no-ff <q(name)>` | 冲突时不自动处理，抛 `git` 错误 |
| `clone` | `git clone [--branch <q(branch)>] <q(url)> <q(targetDir)>` | 长任务：`timeoutMs=0`（不限时），进度通过 `event:progress` 报 |
| `init` | `git init <q(targetDir)>` | |

**名字校验**（分支名 / 远程名 / 标签名共用）：非空、不以 `-` 开头、不含空格与 `~^:?*[\\`、不以 `.lock` 结尾、不含 `..`；违反抛 `invalid-input`（文案 `名称无效：<原因>`）。

---

## G4 UI 规格（改造 U4 + 新增对话框）

### G4.1 SCM 面板「更改」改为两组

```
[折叠箭头] 暂存的更改 (3)                    [全部撤销 ↓] [刷新]
   ✓ main.cpp            src/pkg           M
   ✓ config.yaml         config            M
[折叠箭头] 更改 (2)                         [全部暂存 ↑] [刷新]
   + __init__.py         tea_bt_py          U
   + setup.py            tea_bt_py          M
```

- 组头顺序：`暂存的更改`（上）、`更改`（下）；计数在标题后（弱化）。
- 行 = 文件类型图标 + 文件名（优先占宽）+ 弱化相对目录 + 行右端彩色字母 + **行尾操作按钮**（悬停出现）：
  - 「更改」组的行 → `↑`（暂存该文件），tooltip `暂存更改`；
  - 「暂存的更改」组的行 → `↓`（撤销暂存），tooltip `撤销暂存`。
- 组头右侧按钮：`全部暂存 ↑`（在「更改」组）、`全部撤销 ↓`（在「暂存的更改」组）；都置灰时（对应组为空）。
- 分组归属规则（按 porcelain 两列）：`indexStatus != ' '` 的进「暂存的更改」，`worktreeStatus != ' '` 且 index 为空格的进「更改」；两列都有内容（如 `MM`）→ **两组都出现**（同一文件两条行，VSCode 行为）。
- 点行 = 打开文件；点击操作按钮 = 执行 stage/unstage（1 条 git 命令）→ **本地更新快照**（不重扫）→ 刷新两组与状态栏。

### G4.2 提交语义

- 「✓ 提交」= 只提交**已暂存**内容（`git commit -m`，**不**执行 `add -A`）。
- 无暂存但有更改 → 弹确认框（见 U8 表格新增行）：
  - 标题 `提交`，正文 `没有已暂存的更改。\n\n是否暂存全部更改并提交？`，按钮 `取消` / `暂存全部并提交`（accent）。
- 下拉菜单**新增第 4 项**（顺序）：`提交(修改)` `提交和推送` `提交和同步` `提交所有更改`。
  - `提交所有更改` = `git add -A` + `git commit -m`（保留旧的一键全量提交习惯），tooltip `暂存全部更改后提交`。
  - `提交(修改)` / `提交和推送` / `提交和同步` 的语义与主规格一致，但**提交部分只含已暂存内容**（`提交所有更改` 是唯一的全量入口）。

### G4.3 「仓库管理…」对话框（无边框外壳，标题 `仓库管理`，宽 520、高 560）

四个分组（`QGroupBox` 式弱化小标题），点开哪组**才**拉哪组的数据（每组 1 条 git 命令）：

1. **远程仓库**：表格 `名称 | fetch 地址 | push 地址` + 按钮 `新增…` `修改地址…` `删除`。
   - `新增…` / `修改地址…` 弹小输入框（名称 + URL）。
2. **暂存的更改**：列表 + `全部撤销`；下方 `更改` 列表 + `全部暂存`（同 G4.1 的行，可在此批量操作）。
3. **标签**：列表 `名称 | 短哈希 | 说明 | 时间` + 按钮 `新建…`（名称 + 说明）`删除`（确认框）。
4. **分支**：列表 `名称 | 类型(本地/远程) | 上游` + 按钮 `新建…`（名称 + `创建后切换` 勾选）`删除`（仅本地，确认框）`合并到当前分支…`（选分支 → 确认框 → 执行 merge）。
   - 当前分支行**加粗 + 打勾**；远程分支行的删除/合并按钮**禁用**。

**stash 入口**：SCM 面板顶栏 `⋯` 菜单（见 G4.4）+ 仓库管理对话框底部按钮行 `暂存当前更改…`（输入说明）`查看暂存…`（弹列表，每条带 `弹出` / `丢弃`）。

### G4.4 SCM 面板顶栏 `⋯` 菜单

`仓库管理…`｜`暂存当前更改…`｜`查看暂存…`｜分隔｜`克隆仓库…`｜`在当前目录初始化仓库`

- `克隆仓库…`：输入框 `仓库地址`（如 `git@github.com:org/repo.git`）+ `目标目录`，执行 `git clone`（长任务，状态栏进度 `正在克隆…`，完成后打开该目录）。
- `在当前目录初始化仓库`：确认框 `确定在 <路径> 初始化 Git 仓库吗？`（按钮 `取消`/`初始化`）。

---

## G5 错误与提示文案（逐字使用）

| 场景 | 文案 |
| --- | --- |
| 无暂存提交 | `没有已暂存的更改。\n\n是否暂存全部更改并提交？` |
| 删除未合并分支 | `删除失败：分支 "<名>" 尚未合并。\n\n如需强制删除，请在终端执行 git branch -D。` |
| 合并冲突 | `合并冲突：请在编辑器或终端中解决冲突后提交。\n\n<git 输出摘要>` |
| 名称无效 | `名称无效：<原因>` |
| 克隆失败 | `克隆失败：<原因>` |
| stash 弹出失败 | `弹出暂存失败：<原因>`（工作区有冲突时提示先保存/提交） |
| 标签创建失败 | `创建标签失败：<原因>` |

---

## G6 性能预算（追加到主规格 §7）

| 操作 | 远端往返上限 |
| --- | --- |
| 暂存 / 撤销暂存（单文件或批量） | **1 条 git 命令**，之后本地更新快照 |
| 打开仓库管理对话框 | **0 条**（点开分组才拉，每组 1 条） |
| stash 存/弹/丢 | 各 1 条 |
| 标签 新建/删除 | 各 1 条 |
| 分支 新建/删除/合并 | 各 1~2 条（新建+切换 = 2 条） |
| 克隆 | 1 条（长任务，进度回调） |

---

## G7 测试清单（追加到分册 4）

### `tests/unit/git-staging.test.ts`
1. `test_stage_runs_add_with_quoted_paths` — Given 两个路径（含空格）Then 命令含 `git add -- 'a b.c' 'c.c'`。
2. `test_stage_rejects_empty_paths`。
3. `test_unstage_prefers_restore_then_falls_back_to_reset` — Given `restore` 报 unknown command Then 重试 `git reset HEAD --`。
4. `test_commit_without_staged_asks_confirmation`（UI）— 无暂存 → 确认框出现；取消后不执行任何 git 命令。
5. `test_commit_all_changes_option_runs_add_a` — 菜单第 4 项 → 命令序 `add -A` → `commit`。
6. `test_stage_updates_snapshot_locally` — 暂存后不重扫（断言 `git status` 调用数为 0）。

### `tests/unit/git-remotes.test.ts`
1. `test_remotes_parses_fetch_and_push_rows`。
2. `test_add_remote_validates_name` — `bad name` 抛 `invalid-input`。
3. `test_set_remote_url_and_remove`。

### `tests/unit/git-stash.test.ts`
1. `test_stash_list_parses_entries`。
2. `test_stash_save_uses_push_with_fallback` — git <2.13 回退 `stash save`。
3. `test_stash_pop_with_index` / `test_stash_drop_with_index`。

### `tests/unit/git-tags.test.ts`
1. `test_tags_parses_for_each_ref_output`。
2. `test_create_tag_uses_annotated` — 命令含 `tag -a <name> -m <msg>`。
3. `test_delete_tag` / `test_tag_name_validation`。

### `tests/unit/git-branches-admin.test.ts`
1. `test_create_branch_with_checkout` — 2 条命令（branch → checkout）。
2. `test_delete_branch_rejects_unmerged_without_force` — 抛 `git` 且文案含 `尚未合并`。
3. `test_merge_branch_uses_no_ff` — 命令含 `merge --no-ff`。
4. `test_branch_name_validation`（同 G3 规则的正反例）。

### `tests/unit/git-clone-init.test.ts`
1. `test_clone_command_with_branch_option`。
2. `test_init_command`。

### `tests/ui/scm-staging.test.ts`
1. `test_two_groups_split_by_porcelain_columns` — `MM` 文件两组都出现。
2. `test_stage_button_moves_row_between_groups`。
3. `test_group_header_buttons_enabled_only_when_nonempty`。

---

## G8 里程碑调整

主规格 §12 的 **M5** 内容追加：`暂存区分组 + 逐文件暂存/撤销、仓库管理对话框（远程/stash/标签/分支）、克隆/初始化入口`；M5 验收追加：`G7 全部用例绿`。
