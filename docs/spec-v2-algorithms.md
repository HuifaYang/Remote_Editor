# 分册 1 · 纯函数算法规格（逐算法：伪代码 + 输入输出样例）

> 本分册对应 `src/shared/` 全部文件。**全部是纯函数**：无 IO、无全局状态、无随机。
> 每个算法都给了「必须的行为」+「输入输出样例」，样例要原样写进测试。
> 实现语言 TypeScript，函数签名不得改。测试文件名见 §10.1 主规格。

---

## A1 `paths.ts` · `normalizeRemotePath(path: string, home: string): string`

**必须的行为**（按顺序处理）：
1. 去首尾空白；
2. 空串 → 返回 `home.rstrip("/")`（home 也空 → `/`）；
3. `~` 或 `~/x` → 把 `~` 换成 `home.rstrip("/")`；
4. 非 `/` 开头的相对路径 → 前缀 `home.rstrip("/") + "/"`；
5. 折叠 `.` 与 `..`（逐段处理，`..` 超出根时停在 `/`）；
6. 去掉尾部 `/`（根 `/` 除外）。

**伪代码**：
```
function normalizeRemotePath(path, home):
    raw = trim(path); base = home 不以 / 结尾
    if raw == "": return base or "/"
    if raw == "~": return base or "/"
    if raw startsWith "~/": raw = base + raw[1:]
    if not raw.startsWith("/"): raw = (base or "") + "/" + raw
    parts = []
    for seg in raw.split("/"):
        if seg == "" or seg == ".": continue
        if seg == "..": parts.pop() if parts else nothing; continue
        parts.push(seg)
    return "/" + parts.join("/")
```

**样例（必须写进测试）**：

| 输入 `path` | 输入 `home` | 输出 |
| --- | --- | --- |
| `"~/ros2_ws/src/"` | `"/home/le"` | `"/home/le/ros2_ws/src"` |
| `"/home/le/../le/x/./y//"` | `"/home/le"` | `"/home/le/x/y"` |
| `""` | `"/home/le"` | `"/home/le"` |
| `""` | `""` | `"/"` |
| `"~"` | `"/home/le"` | `"/home/le"` |
| `"a/b"` | `"/home/le"` | `"/home/le/a/b"` |
| `"/../../etc"` | `"/home/le"` | `"/etc"` |
| `"/"` | `"/home/le"` | `"/"` |

**附加函数** `shellQuote(s: string): string`：用单引号包裹，内部 `'` 替换为 `'\''`。
样例：`"it's"` → `'it'\''s'`；`"-Wall"` → `'-Wall'`；`""` → `''`。

---

## A2 `git-status.ts` · porcelain 解析

**输入**：`git status --porcelain -uall` 的 stdout（换行分隔）。
**输出**：`{ files: Map<string, GitFileStatus>, untrackedDirs: string[] }`（key = 仓库内相对路径）。

**逐行规则**（按顺序，缺一不可）：
1. 行长度 < 4 → 跳过；
2. `indexStatus = line[0]`，`worktreeStatus = line[1]`，`name = line.slice(3).trim()`；
3. 含 `" -> "` → 取 `->` **右侧**（rename 的新路径）；
4. 首尾 `"` 剥掉（git 的引号转义路径；本项目不做八进制反转义，剥引号即可）；
5. `name` 以 `/` 结尾 → 未跟踪目录折叠：记入 `untrackedDirs`（去尾 `/`），同时该目录记 `change=added`；**不**进 files；
6. 否则算 `letter` 与 `change`：

| `indexStatus + worktreeStatus` | letter | change |
| --- | --- | --- |
| `??`（文件） | `U` | `added` |
| `A ` / `AM` / `A?` | `A` | `added` |
| ` D` / `D ` | `D` | `deleted` |
| `R ` / `RM` | `R` | `modified` |
| ` M` / `MM` / ` M` | `M` | `modified` |
| `UU` / `AA` / `DD` | `!` | `modified` |
| 其它（两列都是空格或无法识别） | `""` | `null`（不入 files） |

**样例输入**：
```
 M src/main.c
A  src/new.c
?? untracked_dir/
R  old.c -> new.c
 D "quoted name.c"
```
**样例输出**：
```
files:
  "src/main.c"        → { letter:"M", change:"modified", index:" ",  worktree:"M" }
  "src/new.c"         → { letter:"A", change:"added",     index:"A", worktree:" " }
  "new.c"             → { letter:"R", change:"modified",  index:"R", worktree:" " }
  "quoted name.c"     → { letter:"D", change:"deleted",   index:" ", worktree:"D" }
untrackedDirs: ["untracked_dir"]
```

---

## A3 `git-status.ts` · 目录继承色传播 `propagate(absolutePath, change, root)`

**必须的行为**：把一个文件的变更向上传播到它的每一级父目录，直到仓库根（**含根**）。
同一目录被多个子项命中时取**优先级最高**的 change，优先级：

```
modified(3) > added(2) > deleted(1)
```

**伪代码**：
```
function propagate(abs, change, root):
    parent = dirname(abs)
    while parent == root or parent startsWith root + "/":
        dirs[parent] = merge(dirs[parent], change)   // merge 取 priority 大者
        if parent == root: break
        parent = dirname(parent)
```

**样例**：root=`/ws`，文件 `/ws/a/b/c.c` 为 `modified`，文件 `/ws/a/d.c` 为 `added`：
```
dirs = { "/ws/a/b": "modified", "/ws/a": "modified", "/ws": "modified", "/ws/a"(再合并 added → 仍 modified) }
```

---

## A4 `git-status.ts` · 本地更新（保存/删除后不重扫仓库）

```ts
markSaved(path: string, clean: boolean): boolean       // 返回 false = 不在快照范围，调用方需重新拉快照
markRemoved(path: string): boolean
markClean(path: string): boolean
```

**必须的行为**：
1. 先用 `covers(path)` 判范围（`scope` 之内才算）；不在范围 → 返回 `false`；
2. `markSaved(path, clean=true)` = `markClean(path)`；
3. `markSaved(path, clean=false)`：原先是 `added`（未跟踪）→ 保持 `added/U`；否则置 `modified/M`，并**重建目录色**；
4. `markClean(path)`：从 `files/letters/_statuses` 删掉，写一份「已知干净」状态（`_statuses[path] = clean`），重建目录色；
5. `markRemoved(path)`：命中 untracked 目录内的文件 → 直接摘掉；跟踪文件 → 置 `deleted/D`，重建目录色；完全没命中（干净文件或被忽略）→ 返回 `false`（交给远端兜底）；
6. 重建目录色 = 重新对 `files + untrackedDirs` 跑 A3。

**样例**：`markSaved("/ws/a.c", clean=true)` 前 files=`{"/ws/a.c": modified}` → 后 files 空、dirs 只剩无色（重算后为空）。

---

## A5 `git-status.ts` · 路径换算 `keyFor(path: string): string`（**符号链接场景，必写测试**）

**背景**：文件树里的路径是「用户打开工作目录时的写法」，快照的键是「仓库根 + git 相对路径」。工作目录经符号链接打开时两者前缀不同（`git rev-parse --show-toplevel` 给的是解析后的真实路径），不换算会导致**整棵树静默失去着色**。

**必须的行为**（顺序执行，任一步命中即返回）：
1. `path` 直接命中 `files` 或 `dirs` → 原样返回；
2. `posixpath.normpath(path)` 命中 → 返回规范化后的；
3. `tail = path 相对 scope 的尾巴`（`path == scope` → `""`；不在 scope 下 → 返回 `path` 不换算）；
4. `tail == ""` → 返回 `root`（若 `root` 在 `dirs` 里）；
5. 按 `"/" + tail` 在 `files` 里找后缀匹配：**恰好 1 个** → 返回该 key；
6. 0 个或多个 → **不猜**，返回原 `path`。

**样例**（必须写进测试）：
```
root = "/data/ws", scope = "/home/me/ws"
files  = { "/data/ws/a/b.c": modified }
dirs   = { "/data/ws/a": modified, "/data/ws": modified }

keyFor("/home/me/ws/a/b.c")  → "/data/ws/a/b.c"      # tail="a/b.c" 唯一命中
keyFor("/home/me/ws/a")      → "/data/ws/a"          # tail="a" 唯一命中
keyFor("/home/me/ws")        → "/data/ws"            # tail="" 走规则 4
keyFor("/elsewhere/x.c")     → "/elsewhere/x.c"      # 不在 scope，原样
```
撞车样例：
```
files = { "/w/a/pkg/x.c": modified, "/w/b/pkg/x.c": modified }, scope = "/home/me/ws"
keyFor("/home/me/ws/pkg/x.c") → "/home/me/ws/pkg/x.c"   # 两个后缀命中 → 不猜
```

---

## A6 `diff-parser.ts` · `git diff` → 行级标记 + hunk 明细

**输入**：`git diff --no-color --unified=3 -M <path>` 的 stdout。
**输出**：`GitDiff`（§5.0）。

**必须的行为**：
1. 只解析 `@@ -a,b +c,d @@` 之后的 hunk 内容；新文件行号用 `+` 侧，删除文件标记 `isDeletedFile=true`；
2. ` `（上下文行）→ 新旧行号都 +1，无标记；
3. `+`（新增行）→ 新行号 +1，记 `addedLines` 与 hunk.added；
4. `-`（删除行）→ 旧行号 +1，记 `deletedLines` 与 hunk.removed；
5. `modifiedLines` = 「替换块」的推断：一个 `-` 块后紧跟 `+` 块 → 该 `+` 块算 `modifiedLines`（不再算 added），对应 `-` 块不算 deletedLines 而算 `deletedLines`（保留，UI 上仍画红）；若 `-` 块后是上下文行 → 保持 deletedLines。
6. 行号是**当前工作区文件**的 1-based 行号。

**样例**：
```
@@ -1,3 +1,4 @@
 line1
-old line
+new line A
+new line B
 line3
```
→ `addedLines=[2,3]`（"new line A" 是替换 → `modifiedLines=[2]`，"new line B" 是纯新增 → `addedLines=[3]`），
  `deletedLines=[2]`，`hunks=[{startLine:2, removed:["old line"], added:["new line A","new line B"]}]`。

（实现者按上面的替换块规则落：A 落 `modifiedLines`，B 落 `addedLines`，`removed/added` 原文保留给浮层用。）

---

## A7 `graph.ts` · 提交图泳道布局 `layout(commits: CommitInfo[]): GraphRow[]`

**必须的行为**（逐提交处理，自上而下）：
1. `lane` = 正在等待该提交的泳道；没有 → 复用空闲泳道（最左的空位），没有空位则新开一条（追加到最右）；
2. `topLanes` = **插入前**所有非空泳道（新分支顶端不该从上面连线下来）；
3. 第一父提交写回本泳道，其余父提交各占一条（已有的泳道就合并进去，不再新开）；
4. `mergeLanes`：两条泳道等同一个提交 → 保留**最左**那条，其余置空（**只置空，不做整体左移**，否则已算好的行内序号会变）；
5. `parentLanes` = 合并**后**各父提交所在泳道的集合；
6. `bottomLanes` = 合并后所有非空泳道。

**worked example（必须写进测试）**：提交 `m` 有两个父 `p1,p2`；`p1`、`p2` 都指向 `base`：
```
行  提交   lane  top     bottom   parentLanes
m   m      0     ()      (0,1)    (0,1)      ← 两个父各占一条
p1  p1     0     (0,1)   (0,1)    (0,)
p2  p2     1     (0,1)   (0,)     (0,)       ← p2 并回 lane 0
base base  0     (0,)    ()       ()
```
线性历史（3 个提交各一个父）→ 全部 `lane=0`，首行 `topLanes=()`，末行 `bottomLanes=()`。

---

## A8 `mirror/manifest.ts` · manifest 与差集

**manifest.json schema**（存在镜像根）：
```json
{ "version": 1, "workspace": "/home/le/ros2_ws/src", "syncedAt": 1730000000,
  "entries": [ { "path": "src/a.cpp", "size": 123, "mtime": 1729990000 } ] }
```
`path` 是**相对镜像根**的 posix 路径。

**`diffManifest(old, new)` 必须的行为**：
- `changed` = new 里有、old 没有，或 `size/mtime` 不同的路径；
- `removed` = old 里有、new 没有的路径；
- 两边都一样的不返回。

---

## A8b `mirror/manager.ts` · 增量同步（F5，源码与 sysroot 通用）

**输入**：上次同步的远端时间戳 `syncedAt`（epoch 秒）、排除规则。
**输出**：变更文件的 tar 流 + 当前全量清单。

**必须的行为**：
1. **时间戳一律取远端时钟**：每次 sync 开始时先取 `date +%s` 记下（同一台板子自己跟自己比，
   禁止用工作机时钟——两边时钟不同步会导致漏拉/全量拉）。
2. 一条 exec 复合命令完成（往返预算不变，仍是 1 条）：
   ```
   cd <workspace> && find . -type f -newermt '@<syncedAt>' \
     -not -path './build/*' -not -path './install/*' -not -path './log/*' \
     -not -path './.git/*' -not -path './.cache/*' -not -name '*.pyc' \
     -not -path '*/__pycache__/*' -print0 | tar --null -czf - -T - ; \
   find . -type f <同样排除> -printf '%p %s %T@\n'
   ```
   tar 流走 **stdout** 解压覆盖进镜像（与全量同一套解包代码）；文件清单走 **stderr**
   （ssh2 的 exec 两个流是分开的，别把文本清单混进 gzip 流里）。
3. 用清单生成新 manifest；`removed` = 旧 manifest 有、新清单没有 → **本地删除**对应文件。
4. sysroot 增量同理：对已收集的 sysroot 目录集合跑同样的 `find -newermt`（排除 `*.a`/`*.so*`）。
5. `find` 不支持 `-newermt`（能力探测失败）→ **退化为全量重传**并在进度文案注明
   `远端 find 过旧，本次为全量同步`；禁止为了增量改成逐文件 SFTP。

---

## A9 `mirror/manager.ts` · compile_commands.json 收集与重写（**最容易做错，必须写测试**）

**输入**：远端 `build/**/compile_commands.json`（每个文件是 JSON 数组）。
**输出**：镜像根的 `compile_commands.json`（数组 = 所有条目拼接）。

**必须的行为**：
1. 逐条目重写 `directory` 与 `file` 里的**远端工作目录前缀**为本地镜像前缀：
   ```
   remotePrefix = "/home/le/ros2_ws/src"   （= 远端仓库根/工作目录）
   localPrefix  = "/Users/me/.config/RemoteCodeEditor/mirror/host1/abc123"
   "/home/le/ros2_ws/src/a.cpp" → "/Users/me/.config/RemoteCodeEditor/mirror/host1/abc123/a.cpp"
   ```
   **只替换前缀匹配的开头部分**，不匹配的原样保留。
2. 合并顺序：按收集到的文件路径字典序，条目顺序保持文件内原序。
3. 找不到任何 compile_commands.json → 写镜像根 `compile_flags.txt`：
   ```
   -std=c++17
   -I<localPrefix>
   -I<localPrefix>/include
   ```
4. `command` / `args` 里的 **`-I`/`-isystem`/`-iquote` 路径按三分规则重写**（覆盖旧版「原样保留」的说法，
   原样保留有真实 bug：工作机自己装了 ROS 时 `/opt/ros/humble/include` 会命中**本机**的 ROS、补全串版本）：
   - 属于远端工作目录前缀 → 重写到**镜像源码**对应路径；
   - 属于本次 sysroot 收集集合（总纲 §5.3 第 8 条）→ 重写到 `<镜像>/_sysroot/<原绝对路径去掉根斜杠>`；
   - 两者都不属于 → **整条删除该 `-I`**（隔离工作机环境，防止串本地头文件；记日志 `已丢弃本机不可映射的 -I: <路径>`）。
   其它含远端路径的参数（如 `directory`/`file`/`-include` 的文件实参）按第 1 条做前缀替换。
5. **target 三元组**：给 clangd 启动参数追加 `--target=<triplet>`（远端 `gcc -dumpmachine`，如 `aarch64-linux-gnu`）；取不到时用 `aarch64-linux-gnu` 并记日志警告。

**样例输入**（build/pkg1/compile_commands.json）：
```json
[ { "directory": "/home/le/ros2_ws/src", "command": "g++ -I/home/le/ros2_ws/src/include -c a.cpp",
    "file": "/home/le/ros2_ws/src/a.cpp" } ]
```
**样例输出**（localPrefix=`/mirror/x`）：
```json
[ { "directory": "/mirror/x", "command": "g++ -I/mirror/x/include -c a.cpp", "file": "/mirror/x/a.cpp" } ]
```

---

## A10 `search.ts` · 结果解析

**输入**：grep stdout。
**规则**：每行 `路径:行号:内容`（`partition(":")` 最多切 2 刀：路径、行号、其余全算内容）；行号非数字 → 跳过该行；总条数达 500 截断。

**样例**：
```
/ws/src/a.c:12:int handle_dock(int x) {
/ws/docs/b.md:3:handle_dock 的说明
```
→ `[ {path:"/ws/src/a.c", line:12, text:"int handle_dock(int x) {"}, {path:"/ws/docs/b.md", line:3, text:"handle_dock 的说明"} ]`
