// 无边框对话框（分册 2 U8）：统一模态层、焦点陷阱、Esc 与键盘可达性；禁止原生 alert/confirm
import { icon } from "../../app/icons.js";

export type Severity = "error" | "warning" | "info";

interface BaseOptions {
  title: string;
  body: string;
  severity?: Severity;
}

export interface DialogHandle {
  host: HTMLElement;
  box: HTMLElement;
  bodyEl: HTMLElement;
  buttonRow: HTMLElement;
  close: () => void;
}

let dialogSeq = 0;

/** 通用对话框骨架：body 可传字符串或自定义表单 DOM。 */
export function openDialog(opts: {
  title: string;
  body?: string | HTMLElement;
  severity?: Severity;
  className?: string;
  initialFocus?: HTMLElement | null;
  onCancel?: () => void;
}): DialogHandle {
  const host = document.createElement("div");
  host.className = "dialog-backdrop";
  host.dataset.severity = opts.severity ?? "info";

  const box = document.createElement("div");
  box.className = `dialog-box${opts.className ? ` ${opts.className}` : ""}`;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.tabIndex = -1;
  const dialogId = `dialog-${++dialogSeq}`;
  box.setAttribute("aria-labelledby", `${dialogId}-title`);

  const bar = document.createElement("div");
  bar.className = "dialog-title";
  const title = document.createElement("span");
  title.id = `${dialogId}-title`;
  title.textContent = opts.title;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "dialog-x ui-icon-btn";
  closeBtn.title = "关闭";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.appendChild(icon("close", "关闭"));
  bar.append(title, closeBtn);

  const bodyEl = document.createElement("div");
  bodyEl.className = "dialog-body";
  if (typeof opts.body === "string") bodyEl.textContent = opts.body;
  else if (opts.body) bodyEl.appendChild(opts.body);

  const buttonRow = document.createElement("div");
  buttonRow.className = "dialog-buttons";
  box.append(bar, bodyEl, buttonRow);
  host.appendChild(box);

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    host.remove();
    previousFocus?.focus();
  };
  const cancel = (): void => {
    close();
    opts.onCancel?.();
  };

  closeBtn.onclick = cancel;
  host.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = [...box.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.body.appendChild(host);
  setTimeout(() => (opts.initialFocus ?? focusablesIn(box)[0] ?? box).focus(), 0);
  return { host, box, bodyEl, buttonRow, close };
}

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )].filter((el) => !el.closest(".hidden"));
}

function button(label: string, primary: boolean, danger = false): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `dialog-btn ui-btn${primary ? " primary" : ""}${danger ? " danger" : ""}`;
  el.textContent = label;
  return el;
}

/** 提示框（好） */
export function showMessage(opts: BaseOptions & { okText?: string }): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      p.close();
      resolve();
    };
    const p = openDialog({ ...opts, onCancel: finish });
    const ok = button(opts.okText ?? "好", true);
    ok.onclick = finish;
    p.buttonRow.appendChild(ok);
    setTimeout(() => ok.focus(), 0);
  });
}

/** 确认框（取消 / 确定） */
export function confirmDialog(opts: BaseOptions & { okText: string; cancelText?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      p.close();
      resolve(value);
    };
    const p = openDialog({ ...opts, onCancel: () => finish(false) });
    const cancel = button(opts.cancelText ?? "取消", false);
    const ok = button(opts.okText, true, opts.danger);
    cancel.onclick = () => finish(false);
    ok.onclick = () => finish(true);
    p.buttonRow.append(cancel, ok);
    setTimeout(() => ok.focus(), 0);
  });
}

/** 单行输入框（新建 / 重命名 / 转到行） */
export function promptDialog(opts: BaseOptions & { label: string; value?: string; okText?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      p.close();
      resolve(value);
    };
    const content = document.createElement("div");
    content.className = "prompt-form";
    const label = document.createElement("label");
    label.className = "dialog-label";
    label.textContent = opts.label;
    const input = document.createElement("input");
    input.className = "dialog-input ui-input";
    input.value = opts.value ?? "";
    label.htmlFor = input.id = `prompt-${++dialogSeq}`;
    content.append(label, input);
    const p = openDialog({
      ...opts,
      body: content,
      initialFocus: input,
      onCancel: () => finish(null),
    });
    const cancel = button("取消", false);
    const ok = button(opts.okText ?? "确定", true);
    cancel.onclick = () => finish(null);
    ok.onclick = () => finish(input.value.trim() || null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value.trim() || null);
      }
    };
    p.buttonRow.append(cancel, ok);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

/** 多选一（冲突处理：重新加载 / 覆盖 / 取消） */
export function chooseDialog(opts: BaseOptions & { buttons: Array<{ label: string; value: string; danger?: boolean }> }): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      p.close();
      resolve(value);
    };
    const p = openDialog({ ...opts, onCancel: () => finish(null) });
    for (const b of opts.buttons) {
      const el = button(b.label, false, b.danger);
      el.onclick = () => finish(b.value);
      p.buttonRow.appendChild(el);
    }
    setTimeout(() => p.buttonRow.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(), 0);
  });
}
