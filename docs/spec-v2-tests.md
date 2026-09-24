# 分册 4 · 测试全清单（逐条用例，缺一条 = 未完成）

> 测试框架：`vitest`。命名规则：`<被测模块>.test.ts`。
> 每条用例按 `Given / When / Then` 三段写（注释里写明即可）。
> **验收命令**：`npm run lint`（0 告警）+ `npm test`（全绿）+ `npm run typecheck`（0 错误）。

---

## T1 `tests/unit/paths.test.ts`

1. `test_normalize_expands_tilde_with_home` — Given `home="/home/le"` When `normalize("~/ros2_ws/src/")` Then `"/home/le/ros2_ws/src"`。
2. `test_normalize_collapses_dot_segments` — Given `"/home/le/../le/x/./y//"` Then `"/home/le/x/y"`。
3. `test_normalize_relative_uses_home` — Given `"a/b"` Then `"/home/le/a/b"`。
4. `test_normalize_empty_returns_home` — Given `""` Then `"/home/le"`；home 也空 → `"/"`。
5. `test_normalize_root_stays_root` — Given `"/"` Then `"/"`。
6. `test_normalize_clamps_above_root` — Given `"/../../etc"` Then `"/etc"`。
7. `test_shell_quote_escapes_single_quotes` — Given `"it's"` Then `'it'\''s'`。
8. `test_shell_quote_protects_leading_dash` — Given `"-Wall"` Then `'-Wall'`。

## T2 `tests/unit/git-status.test.ts`

1. `test_parse_basic_states` — M/A/D/R 各一行为例，断言 letter 与 change（样例见分册 1 A2）。
2. `test_parse_rename_takes_new_path` — `R  old.c -> new.c` → key=`new.c`。
3. `test_parse_quoted_path` — ` D "quoted name.c"` → key=`quoted name.c`。
4. `test_parse_untracked_dir_goes_to_untracked_dirs` — `?? dir/` → 不进 files，进 untrackedDirs。
5. `test_propagate_reaches_root_with_priority` — 样例见 A3（modified 优先于 added）。
6. `test_mark_saved_clean_removes_and_recomputes_dirs` — Given 一个 modified 文件 When `markSaved(clean=true)` Then files 空、dirs 重算为空。
7. `test_mark_saved_keeps_untracked_added` — Given untracked `U` When `markSaved(clean=false)` Then 仍是 `U`。
8. `test_mark_removed_marks_tracked_deleted` — Given tracked `M` When `markRemoved` Then `D`。
9. `test_key_for_maps_symlinked_workspace` — 样例见 A5（4 个断言）。
10. `test_key_for_refuses_ambiguous_tail` — 样例见 A5 撞车例，返回原路径。
11. `test_diff_parser_maps_modified_and_added` — 样例见 A6。
12. `test_diff_parser_marks_deleted_file` — diff 只有删除行 → `isDeletedFile=true`。

## T3 `tests/unit/graph.test.ts`

1. `test_linear_history_uses_one_lane` — 3 个单父提交，断言 lane 全 0、首行 topLanes=()、末行 bottomLanes=()。
2. `test_two_branch_tips_get_separate_lanes` — 两个提交都指向同一 base → lane=[0,1,0]。
3. `test_merge_gets_two_parent_lanes` — worked example 见 A7，逐字段断言。
4. `test_merged_lanes_collapse_left` — p2 并回 lane 0 后 bottomLanes=(0,)。
5. `test_empty_input_returns_empty`。

## T4 `tests/unit/mirror.test.ts`

1. `test_tar_command_excludes_artifacts` — 断言命令串含 `--exclude=./build` `--exclude=./install` `--exclude=./log` `--exclude=./.git` `--exclude=./.cache` `--exclude=./__pycache__` `--exclude='*.pyc'`。
2. `test_manifest_diff_finds_changed_and_removed` — 样例见 A8。
3. `test_local_path_maps_relative_to_workspace` — Given workspace `/home/le/ws`、localPrefix `/mirror/x` When `localPathOf("/home/le/ws/a/b.c")` Then `"/mirror/x/a/b.c"`。
4. `test_compile_commands_paths_are_rewritten` — 样例见 A9。
4b. `test_compile_commands_unmappable_include_is_dropped` — Given `-I/opt/ros/humble/include` 不在 sysroot 收集集合
    Then 重写后**不含**该 `-I`（防止命中工作机本机环境，见 A9 第 4 条）；在集合内则重写到 `_sysroot/`。
5. `test_compile_flags_fallback_when_no_compile_commands` — Given 空收集结果 Then 生成 `compile_flags.txt` 且含 `-std=c++17`。
6. `test_sync_streams_without_buffering_whole_tar` — 用可读流 mock 断言 `pipeline` 被调用（而非全量 concat）。
7. `test_sysroot_collects_include_dirs_from_compile_commands` — Given `-I/opt/ros/humble/include`、`-isystem /usr/include` Then 镜像任务含这两个目录（落到 `_sysroot/…`）。
8. `test_sysroot_appends_target_triplet` — clangd 启动参数含 `--target=aarch64-linux-gnu`。
9. `test_python_env_paths_are_mirrored_and_on_pythonpath` — Given `sys.path` 含 `/opt/ros/humble/lib/python3.10/site-packages` Then `_pyenv` 下有该目录且 pylsp 启动 `PYTHONPATH` 含 `_pyenv`。
10. `test_sysroot_tar_excludes_libraries` — 断言 tar 排除 `*.a`/`*.so*`（只留头文件）。
11. `test_incremental_sync_uses_remote_clock_and_single_command` — Given 上次 `syncedAt` Then F5 只发 1 条 exec，
    命令含 `-newermt '@<syncedAt>'`（远端时钟，禁止用本地 `Date.now()`）。
12. `test_incremental_sync_removes_deleted_files_locally` — Given 旧 manifest 含 `a.c`、新清单没有
    Then 镜像里 `a.c` 被删除（A8b 第 3 条）。
13. `test_incremental_falls_back_to_full_when_find_too_old` — Given 能力探测失败 Then 走全量 tar 且进度文案含 `全量同步`。
14. `test_pyenv_tar_excludes_native_extensions` — 断言 `_pyenv` 打包排除 `*.so`/`*.pyd`。

## T5 `tests/unit/search.test.ts`

1. `test_command_uses_extended_mode_for_regex` — `regex:true` → 含 `-E`、不含 `-F`。
2. `test_command_uses_fixed_mode_for_plain` — `regex:false` → 含 `-F`。
3. `test_command_case_insensitive_flag` — `caseSensitive:false` → 含 `-i`。
4. `test_keyword_starting_with_dash_is_quoted` — `"-Wall"` → 命令串含 `-e '-Wall'`。
5. `test_exit_code_1_is_empty_not_error` — Given grep 退出码 1 Then 返回 `[]` 不抛错。
6. `test_parse_line_number_and_text` — 样例见 A10。
7. `test_results_capped_at_500`。

## T6 `tests/unit/connection.test.ts`（mock `ssh2`）

1. `test_explicit_key_only_uses_that_key` — Given `privateKeyPath` Then 不做默认私钥探测、`agent:false`。
2. `test_default_named_keys_are_tried_first` — Given 无显式私钥、本机有 `id_ed25519` Then `lookForKeys=true`。
3. `test_no_default_named_keys_skips_discovery` — Given 只有 `id_ed25519_github` Then `lookForKeys=false` 且直接抛 `auth`。
4. `test_no_authentication_methods_maps_to_auth_error` — Given ssh2 抛 `No supported authentication methods available` Then 错误码 `auth`（**不得**是 `ssh`）。
5. `test_timeout_maps_to_timeout_error`。
6. `test_passphrase_required_maps_to_its_code`。
7. `test_exec_uses_quoted_cwd` — Given `cwd="/a b"` Then 命令前缀 `cd '/a b' &&`。
8. `test_sftp_calls_are_serialized` — 并发 3 个 `readFile` → SFTP 调用严格串行（断言调用序号不重叠）。

## T7 `tests/unit/git.test.ts`（mock exec）

1. `test_tree_status_uses_two_commands` — 断言 `exec` 恰好 2 次（rev-parse 合并 + status）。
2. `test_clean_file_diff_uses_zero_git_commands` — Given 快照判「未变更」 Then 打开文件 0 条 git 命令。
3. `test_commit_all_stages_then_commits` — 断言命令序 = `add -A` → `commit -m`。
4. `test_commit_amend_empty_message_uses_no_edit` — 断言含 `--amend --no-edit`。
5. `test_push_sets_upstream_when_missing` — Given push 报 `no upstream branch` Then 重试 `push -u origin <branch>`。
6. `test_sync_pulls_then_pushes` — 断言 `pull` 在 `push` 之前。
7. `test_switch_branch_rejects_dash_prefix` — `"-x"` 抛 `invalid-input`。
8. `test_branches_parses_detached_head`。
9. `test_log_graph_returns_layouted_rows` — 返回 `GraphRow[]` 且含 lane 字段。

## T8 `tests/unit/lsp-client.test.ts`

1. `test_frame_handles_partial_header` — 分片到达的 `Content-Length` 头能正确拼接。
2. `test_frame_handles_multiple_messages_in_one_chunk` — 粘包。
3. `test_content_length_counts_bytes_not_chars` — 含中文的消息，`Content-Length` = `Buffer.byteLength`。
4. `test_initialize_handshake_order` — `initialize` → `initialized` → 就绪。
5. `test_completion_maps_to_monaco_shape` — LSP CompletionItem → Monaco SuggestionItem（含 kind 映射）。
6. `test_definition_maps_location_to_range`。
7. `test_hover_returns_markdown_string`。
8. `test_diagnostics_event_is_forwarded`。

## T9 `tests/integration/`（假 SSH 服务端，进程内 `ssh2` Server）

1. `test_connect_list_read_save_roundtrip` — 全链路；保存后服务端文件内容更新，且临时文件被 rename 覆盖（断言不残留 `.rce-tmp-*`）。
2. `test_mirror_sync_extracts_and_builds_manifest` — 假 tar 流 → 解压结果、manifest 内容。
3. `test_git_status_and_search_over_exec` — 假 exec 返回固定输出 → 解析结果正确。
4. `test_terminal_echo_roundtrip` — shell 通道写入 → 回显数据回传。
5. `test_auth_failure_returns_auth_code` — 假服务端只接受密码 → 断言错误码 `auth`。

## T9b `tests/unit/lsp-transports.test.ts`（两种传输都要测）
1. `test_local_transport_spawns_with_target_arg` — 本机模式启动含 `--target=<triplet>`。
2. `test_remote_transport_pipes_over_ssh_exec` — 板子模式走 SSH exec 流，JSON-RPC 双向可达。
3. `test_setting_switch_changes_transport` — 设置切「板子上」后 `ensure()` 用远端传输。

## T10 `tests/ui/`

1. `test_store_subscribe_and_set` — 订阅触发、退订生效。
2. `test_file_tree_lazy_loads_and_caches` — 首次展开 1 次 listDir、再次展开 0 次（120 秒内）。
3. `test_tabs_add_close_dirty_marker` — 新建/关闭/脏点切换。
4. `test_shortcut_table_dispatches` — 每个 §6.5 快捷键至少 1 条用例（触发正确动作）。
5. `test_search_result_click_targets_line` — 点结果 → 打开并跳行（断言目标行号）。
6. `test_commit_button_states` — 无更改禁用、有更改可点、无信息点「提交」发提示事件。

## T11 验收清单（手动，M3/M6 各一次）

- [ ] 语言服务位置 = `本机` 时，板子上 `ps -ef | grep -E "clangd|pylsp"` **没有任何进程**（补全开着也不该有）；
  `板子上` 模式是用户显式开启的例外，活动会话期间会有进程（总纲 §5.5 第 0 条）。
- [ ] 打开 C++ 文件敲 `this->` 出补全弹窗；`F12` 跳定义；写一行错代码出红色波浪线。
- [ ] 断网/断 SSH 后重连，状态栏与列表恢复正常。
- [ ] Windows / Linux 安装包在干净机器上装完即用（无 Node/无 Python 前置；macOS 暂缓出包）。
- [ ] 干净机器上打开 C++ 文件**不装任何东西**就有补全（内置 clangd 生效，见总纲 §5.5 第 0 条）。
