// 轻量 UI 基座（不引 UI 库）：统一按钮、图标按钮、表单字段和空态结构
import { icon } from "../app/icons.js";

export type ButtonVariant = "default" | "primary" | "secondary" | "danger" | "ghost";

export function uiButton(opts: {
  label: string;
  variant?: ButtonVariant;
  icon?: string;
  title?: string;
  disabled?: boolean;
  onClick?: () => void;
}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `ui-btn ${opts.variant ?? "default"}`;
  btn.disabled = Boolean(opts.disabled);
  if (opts.title) btn.title = opts.title;
  if (opts.icon) btn.appendChild(icon(opts.icon, opts.label));
  const label = document.createElement("span");
  label.textContent = opts.label;
  btn.appendChild(label);
  if (opts.onClick) btn.addEventListener("click", opts.onClick);
  return btn;
}

export function uiIconButton(opts: {
  icon: string;
  label: string;
  title?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `ui-icon-btn icon-btn${opts.danger ? " danger" : ""}`;
  btn.disabled = Boolean(opts.disabled);
  btn.title = opts.title ?? opts.label;
  btn.setAttribute("aria-label", opts.label);
  btn.appendChild(icon(opts.icon, opts.label));
  if (opts.onClick) btn.addEventListener("click", opts.onClick);
  return btn;
}

export function emptyState(opts: {
  icon: string;
  title: string;
  description?: string;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
}): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "ui-empty";
  const iconEl = document.createElement("div");
  iconEl.className = "ui-empty-icon";
  iconEl.appendChild(icon(opts.icon, opts.title));
  const title = document.createElement("div");
  title.className = "ui-empty-title";
  title.textContent = opts.title;
  wrap.append(iconEl, title);
  if (opts.description) {
    const desc = document.createElement("div");
    desc.className = "ui-empty-desc";
    desc.textContent = opts.description;
    wrap.appendChild(desc);
  }
  if (opts.actionLabel) {
    const actions = document.createElement("div");
    actions.className = "ui-empty-actions";
    actions.appendChild(uiButton({
      label: opts.actionLabel,
      variant: "primary",
      disabled: opts.actionDisabled,
      onClick: opts.onAction,
    }));
    wrap.appendChild(actions);
  }
  return wrap;
}

export function formField(opts: {
  label: string;
  control: HTMLElement;
  hint?: string;
  error?: string;
}): HTMLElement {
  const field = document.createElement("div");
  field.className = `ui-field${opts.error ? " error" : ""}`;
  const label = document.createElement("label");
  label.className = "ui-field-label";
  label.textContent = opts.label;
  if (opts.control.id) label.htmlFor = opts.control.id;
  const control = document.createElement("div");
  control.className = "ui-field-control";
  control.appendChild(opts.control);
  field.append(label, control);
  if (opts.hint) {
    const hint = document.createElement("div");
    hint.className = "ui-field-hint";
    hint.textContent = opts.hint;
    field.appendChild(hint);
  }
  if (opts.error) {
    const error = document.createElement("div");
    error.className = "ui-field-error";
    error.textContent = opts.error;
    field.appendChild(error);
  }
  return field;
}

export function spinner(label = "加载中…"): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "ui-loading";
  const dot = document.createElement("span");
  dot.className = "ui-spinner";
  const text = document.createElement("span");
  text.textContent = label;
  wrap.append(dot, text);
  return wrap;
}

export interface ContextMenuItem {
  label: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** 统一右键/下拉菜单：视口内定位、键盘导航、Esc/外点关闭。 */
export function openContextMenu(items: ContextMenuItem[], x: number, y: number): () => void {
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;

  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `context-item${item.danger ? " danger" : ""}`;
    btn.disabled = Boolean(item.disabled);
    btn.setAttribute("role", "menuitem");
    if (item.icon) btn.appendChild(icon(item.icon, item.label));
    const label = document.createElement("span");
    label.className = "context-label";
    label.textContent = item.label;
    btn.appendChild(label);
    if (item.shortcut) {
      const shortcut = document.createElement("kbd");
      shortcut.textContent = item.shortcut;
      btn.appendChild(shortcut);
    }
    btn.onclick = () => {
      close();
      item.onClick();
    };
    buttons.push(btn);
    menu.appendChild(btn);
  }

  const close = (): void => {
    menu.remove();
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (!menu.contains(event.target as Node)) close();
  };

  menu.addEventListener("keydown", (event) => {
    const enabled = buttons.filter((btn) => !btn.disabled);
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = enabled[(current + delta + enabled.length) % enabled.length];
      next?.focus();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? enabled[0] : enabled[enabled.length - 1])?.focus();
    }
  });

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  setTimeout(() => {
    document.addEventListener("pointerdown", onPointerDown, true);
    buttons.find((btn) => !btn.disabled)?.focus();
  }, 0);
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
  return close;
}
