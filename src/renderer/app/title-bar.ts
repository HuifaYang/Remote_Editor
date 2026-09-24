// 自绘标题栏（总纲 §6.1）：≡ 菜单 + 标题 + 窗口按钮；菜单为左侧分组 + 右侧命令的现代双层结构
import { icon } from "./icons.js";

export interface TitleBarActions {
  openFolder?: () => void;
  newFile?: () => void;
  newFolder?: () => void;
  save?: () => void;
  saveAll?: () => void;
  closeTab?: () => void;
  quit?: () => void;
  undo?: () => void;
  redo?: () => void;
  cut?: () => void;
  copy?: () => void;
  paste?: () => void;
  find?: () => void;
  replace?: () => void;
  searchAll?: () => void;
  gotoLine?: () => void;
  viewFiles?: () => void;
  viewSearch?: () => void;
  viewScm?: () => void;
  viewHosts?: () => void;
  toggleSidebar?: () => void;
  togglePanel?: () => void;
  zoomIn?: () => void;
  zoomOut?: () => void;
  zoomReset?: () => void;
  themeDark?: () => void;
  themeLight?: () => void;
  newTerminal?: () => void;
  killTerminal?: () => void;
  clearTerminal?: () => void;
  openSettings?: () => void;
  openShortcuts?: () => void;
  about?: () => void;
}

interface MenuCommand {
  label: string;
  shortcut?: string;
  run?: () => void;
}
type MenuEntry = MenuCommand | "separator";
interface MenuGroup {
  id: string;
  label: string;
  entries: MenuEntry[];
}

export function mountTitleBar(container: HTMLElement, actions: TitleBarActions = {}): void {
  const bar = document.createElement("div");
  bar.className = "titlebar";

  const menuWrap = document.createElement("div");
  menuWrap.className = "menu-wrap";
  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "titlebar-btn menu-btn";
  menuBtn.title = "菜单";
  menuBtn.setAttribute("aria-label", "菜单");
  menuBtn.setAttribute("aria-haspopup", "menu");
  menuBtn.setAttribute("aria-expanded", "false");
  menuBtn.textContent = "≡";

  const dropdown = document.createElement("div");
  dropdown.className = "menu-dropdown hidden";
  dropdown.setAttribute("role", "menu");

  const groups = menuGroups(actions);
  let activeGroup = 0;
  let activeItem = 0;

  const renderMenu = (): void => {
    dropdown.textContent = "";
    const nav = document.createElement("div");
    nav.className = "menu-nav";
    nav.setAttribute("role", "tablist");
    groups.forEach((group, index) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `menu-nav-item${index === activeGroup ? " active" : ""}`;
      tab.textContent = group.label;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", index === activeGroup ? "true" : "false");
      tab.onclick = () => {
        activeGroup = index;
        activeItem = 0;
        renderMenu();
        focusCommand(0);
      };
      nav.appendChild(tab);
    });

    const panel = document.createElement("div");
    panel.className = "menu-panel";
    panel.setAttribute("role", "menu");
    let commandIndex = 0;
    for (const entry of groups[activeGroup].entries) {
      if (entry === "separator") {
        const sep = document.createElement("div");
        sep.className = "menu-separator";
        panel.appendChild(sep);
        continue;
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "menu-action";
      item.setAttribute("role", "menuitem");
      item.disabled = !entry.run;
      item.tabIndex = commandIndex === activeItem ? 0 : -1;
      const label = document.createElement("span");
      label.className = "menu-action-label";
      label.textContent = entry.label;
      item.appendChild(label);
      if (entry.shortcut) {
        const shortcut = document.createElement("kbd");
        shortcut.textContent = entry.shortcut;
        item.appendChild(shortcut);
      }
      item.onclick = () => {
        closeMenu();
        entry.run?.();
      };
      item.onmouseenter = () => {
        activeItem = commandIndex;
        updateRovingFocus(panel);
      };
      commandIndex += 1;
      panel.appendChild(item);
    }
    dropdown.append(nav, panel);
  };

  const commandButtons = (): HTMLButtonElement[] => [...dropdown.querySelectorAll<HTMLButtonElement>(".menu-action:not(:disabled)")];
  const focusCommand = (index: number): void => {
    const buttons = commandButtons();
    if (buttons.length === 0) return;
    activeItem = Math.max(0, Math.min(index, buttons.length - 1));
    buttons[activeItem].focus();
  };
  const updateRovingFocus = (panel: HTMLElement): void => {
    [...panel.querySelectorAll<HTMLButtonElement>(".menu-action")].forEach((btn, index) => {
      btn.tabIndex = index === activeItem ? 0 : -1;
    });
  };
  const openMenu = (): void => {
    renderMenu();
    dropdown.classList.remove("hidden");
    menuBtn.setAttribute("aria-expanded", "true");
    setTimeout(() => focusCommand(0), 0);
  };
  const closeMenu = (): void => {
    dropdown.classList.add("hidden");
    menuBtn.setAttribute("aria-expanded", "false");
  };

  menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (dropdown.classList.contains("hidden")) openMenu();
    else closeMenu();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menuWrap.contains(event.target as Node)) closeMenu();
  });
  dropdown.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      menuBtn.focus();
      return;
    }
    const navItems = [...dropdown.querySelectorAll<HTMLButtonElement>(".menu-nav-item")];
    const onNav = navItems.includes(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowRight" && onNav) {
      event.preventDefault();
      focusCommand(0);
      return;
    }
    if (event.key === "ArrowLeft" && !onNav) {
      event.preventDefault();
      navItems[activeGroup]?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (onNav) {
        activeGroup = (activeGroup + (event.key === "ArrowDown" ? 1 : groups.length - 1)) % groups.length;
        activeItem = 0;
        renderMenu();
        navItems[activeGroup]?.focus();
      } else {
        focusCommand(activeItem + (event.key === "ArrowDown" ? 1 : -1));
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusCommand(event.key === "Home" ? 0 : commandButtons().length - 1);
    }
  });

  menuWrap.append(menuBtn, dropdown);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "RemoteCodeEditor";

  const minBtn = makeWinButton("chrome-minimize", "最小化", () => window.api.window.minimize());
  const maxBtn = makeWinButton("chrome-maximize", "最大化", () => window.api.window.toggleMaximize());
  const closeBtn = makeWinButton("close", "关闭", () => window.api.window.close());
  closeBtn.classList.add("close");

  // 最大化状态切换恢复图标
  window.api.on("window-state", (...args: unknown[]) => {
    const { maximized } = args[0] as { maximized: boolean };
    maxBtn.replaceChildren(icon(maximized ? "chrome-restore" : "chrome-maximize", maximized ? "还原" : "最大化"));
  });

  // 双击标题栏空白 = 最大化/还原（拖动由 -webkit-app-region: drag 负责）
  bar.addEventListener("dblclick", (e) => {
    if (e.target === bar || (e.target as HTMLElement).classList.contains("title")) {
      window.api.window.toggleMaximize();
    }
  });

  bar.append(menuWrap, title, minBtn, maxBtn, closeBtn);
  container.appendChild(bar);
}

function menuGroups(actions: TitleBarActions): MenuGroup[] {
  return [
    {
      id: "file",
      label: "文件",
      entries: [
        { label: "新建文件", shortcut: "Ctrl+N", run: actions.newFile },
        { label: "新建文件夹…", run: actions.newFolder },
        { label: "打开远程文件夹…", shortcut: "Ctrl+O", run: actions.openFolder },
        "separator",
        { label: "保存", shortcut: "Ctrl+S", run: actions.save },
        { label: "全部保存", shortcut: "Ctrl+Shift+S", run: actions.saveAll },
        "separator",
        { label: "关闭标签", shortcut: "Ctrl+W", run: actions.closeTab },
        { label: "退出", shortcut: "Ctrl+Q", run: actions.quit },
      ],
    },
    {
      id: "edit",
      label: "编辑",
      entries: [
        { label: "撤销", shortcut: "Ctrl+Z", run: actions.undo },
        { label: "重做", shortcut: "Ctrl+Y", run: actions.redo },
        "separator",
        { label: "剪切", shortcut: "Ctrl+X", run: actions.cut },
        { label: "复制", shortcut: "Ctrl+C", run: actions.copy },
        { label: "粘贴", shortcut: "Ctrl+V", run: actions.paste },
        "separator",
        { label: "查找", shortcut: "Ctrl+F", run: actions.find },
        { label: "替换", shortcut: "Ctrl+H", run: actions.replace },
        { label: "在工作区中搜索…", shortcut: "Ctrl+Shift+F", run: actions.searchAll },
        { label: "转到行…", shortcut: "Ctrl+G", run: actions.gotoLine },
      ],
    },
    {
      id: "view",
      label: "查看",
      entries: [
        { label: "资源管理器", shortcut: "Ctrl+Shift+E", run: actions.viewFiles },
        { label: "搜索", shortcut: "Ctrl+Shift+F", run: actions.viewSearch },
        { label: "源代码管理", shortcut: "Ctrl+Shift+G", run: actions.viewScm },
        { label: "远程主机", shortcut: "Ctrl+Shift+R", run: actions.viewHosts },
        "separator",
        { label: "收起侧边栏", shortcut: "Ctrl+B", run: actions.toggleSidebar },
        { label: "收起面板", shortcut: "Ctrl+J", run: actions.togglePanel },
        "separator",
        { label: "放大", shortcut: "Ctrl+=", run: actions.zoomIn },
        { label: "缩小", shortcut: "Ctrl+-", run: actions.zoomOut },
        { label: "重置缩放", shortcut: "Ctrl+0", run: actions.zoomReset },
        "separator",
        { label: "深色主题", run: actions.themeDark },
        { label: "浅色主题", run: actions.themeLight },
      ],
    },
    {
      id: "terminal",
      label: "终端",
      entries: [
        { label: "新建终端", shortcut: "Ctrl+Shift+`", run: actions.newTerminal },
        { label: "终止当前终端", run: actions.killTerminal },
        { label: "清屏", run: actions.clearTerminal },
      ],
    },
    {
      id: "help",
      label: "帮助",
      entries: [
        { label: "快捷键一览", run: actions.openShortcuts },
        { label: "关于", run: actions.about },
      ],
    },
  ];
}

function makeWinButton(iconName: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "titlebar-btn";
  btn.type = "button";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.appendChild(icon(iconName, title));
  btn.addEventListener("click", onClick);
  return btn;
}
