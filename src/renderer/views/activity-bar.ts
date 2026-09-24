// 活动栏（44px 图标列，总纲 §6.1）：M1 只建结构，视图实现随 M4/M5 挂载
import { icon } from "../app/icons.js";
import { uiStore } from "../app/store.js";

const VIEWS: Array<{ id: string; icon: string; title: string }> = [
  { id: "files", icon: "files", title: "资源管理器" },
  { id: "search", icon: "search", title: "搜索" },
  { id: "source-control", icon: "source-control", title: "源代码管理" },
  { id: "hosts", icon: "plug", title: "远程主机" },
];

export function mountActivityBar(container: HTMLElement, onViewChange: (view: string | null) => void): void {
  const bar = document.createElement("div");
  bar.className = "activity-bar";

  const buttons = new Map<string, HTMLButtonElement>();
  for (const view of VIEWS) {
    const btn = document.createElement("button");
    btn.className = "activity-btn";
    btn.title = view.title;
    btn.appendChild(icon(view.icon, view.title));
    btn.addEventListener("click", () => {
      // 点当前视图 = 收起侧边栏（VSCode 行为，总纲 §6.1）
      // 只把 next 交给主逻辑；不要在这里写 uiStore，否则主逻辑会误判“点击当前视图”并收起侧边栏
      const next = uiStore.get().sidebarView === view.id ? null : view.id;
      onViewChange(next);
    });
    buttons.set(view.id, btn);
    bar.appendChild(btn);
  }

  const spacer = document.createElement("div");
  spacer.className = "activity-spacer";
  const settingsBtn = document.createElement("button");
  settingsBtn.className = "activity-btn";
  settingsBtn.title = "设置（Ctrl+,）";
  settingsBtn.appendChild(icon("settings-gear", "设置"));
  settingsBtn.onclick = () => onViewChange("settings");

  bar.append(spacer, settingsBtn);
  container.appendChild(bar);

  uiStore.subscribe(() => {
    const active = uiStore.get().sidebarView;
    for (const [id, btn] of buttons) btn.classList.toggle("active", id === active);
  });
}
