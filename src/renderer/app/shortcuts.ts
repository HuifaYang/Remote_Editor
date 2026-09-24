// 快捷键表（分册 2 U10 / §6.5）：渲染进程 keydown，禁止 globalShortcut（会抢全局）
export interface ShortcutHandlers {
  save?: () => void;
  saveAll?: () => void;
  closeTab?: () => void;
  nextTab?: () => void;
  openFolder?: () => void;
  newFile?: () => void;
  toggleSidebar?: () => void;
  togglePanel?: () => void;
  zoomIn?: () => void;
  zoomOut?: () => void;
  zoomReset?: () => void;
  find?: () => void;
  replace?: () => void;
  gotoLine?: () => void;
  searchAll?: () => void;
  triggerCompletion?: () => void;
  refreshMirror?: () => void;
  refreshGit?: () => void;
  newTerminal?: () => void;
  openSettings?: () => void;
}

export interface ShortcutSpec {
  key: string;                  // 小写，如 "s" / "`" / "="
  ctrl?: boolean;
  shift?: boolean;
  run: keyof ShortcutHandlers;
}

export function shortcutTable(): ShortcutSpec[] {
  return [
    { key: "s", ctrl: true, run: "save" },
    { key: "s", ctrl: true, shift: true, run: "saveAll" },
    { key: "w", ctrl: true, run: "closeTab" },
    { key: "tab", ctrl: true, run: "nextTab" },
    { key: "o", ctrl: true, run: "openFolder" },
    { key: "n", ctrl: true, run: "newFile" },
    { key: "b", ctrl: true, run: "toggleSidebar" },
    { key: "j", ctrl: true, run: "togglePanel" },
    { key: "=", ctrl: true, run: "zoomIn" },
    { key: "-", ctrl: true, run: "zoomOut" },
    { key: "0", ctrl: true, run: "zoomReset" },
    { key: "f", ctrl: true, run: "find" },
    { key: "h", ctrl: true, run: "replace" },
    { key: "g", ctrl: true, run: "gotoLine" },
    { key: "f", ctrl: true, shift: true, run: "searchAll" },
    { key: " ", ctrl: true, run: "triggerCompletion" },
    { key: "f5", ctrl: false, run: "refreshMirror" },
    { key: "f5", ctrl: false, shift: true, run: "refreshGit" },
    { key: "`", ctrl: true, run: "togglePanel" },
    { key: "`", ctrl: true, shift: true, run: "newTerminal" },
    { key: ",", ctrl: true, run: "openSettings" },
  ];
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey?: boolean;
  shiftKey: boolean;
  altKey?: boolean;
}

/** 命中判断（纯函数，便于单测）：只按 Ctrl（macOS 上 Cmd 也算） */
export function matchShortcut(event: KeyLike, specs: ShortcutSpec[] = shortcutTable()): ShortcutSpec | null {
  const ctrl = event.ctrlKey || event.metaKey === true;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  for (const spec of specs) {
    if (spec.key !== key) continue;
    if ((spec.ctrl ?? false) !== ctrl) continue;
    if ((spec.shift ?? false) !== event.shiftKey) continue;
    return spec;
  }
  return null;
}

/** 挂到 window；输入框里的系统按键（Ctrl+C/V 等）不拦 */
export function installShortcuts(handlers: ShortcutHandlers): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    const spec = matchShortcut(e);
    if (!spec) return;
    const fn = handlers[spec.run];
    if (!fn) return;
    if (e.key === "Tab" && e.ctrlKey && isTextInput(e.target)) return;   // 让编辑器/输入框自己处理
    e.preventDefault();
    fn();
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable === true;
}
