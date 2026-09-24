// 标签页模型（纯逻辑，便于单测）：打开/关闭/脏标记/保存状态；Monaco model 由视图层持有
import type { Fingerprint } from "../../shared/types.js";

export interface TabState {
  path: string;              // 远端绝对路径
  name: string;
  language: string;
  dirty: boolean;
  fingerprint: Fingerprint | null;
  encoding: string;
  newline: string;
}

export class TabsModel {
  private tabs: TabState[] = [];
  private activePath: string | null = null;
  private readonly listeners = new Set<() => void>();

  list(): TabState[] {
    return [...this.tabs];
  }

  active(): TabState | null {
    return this.tabs.find((t) => t.path === this.activePath) ?? null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  open(tab: TabState): TabState {
    const existing = this.tabs.find((t) => t.path === tab.path);
    if (existing) {
      this.activePath = existing.path;
      this.emit();
      return existing;
    }
    this.tabs.push(tab);
    this.activePath = tab.path;
    this.emit();
    return tab;
  }

  activate(path: string): void {
    if (this.tabs.some((t) => t.path === path)) {
      this.activePath = path;
      this.emit();
    }
  }

  setDirty(path: string, dirty: boolean): void {
    const tab = this.tabs.find((t) => t.path === path);
    if (!tab || tab.dirty === dirty) return;
    tab.dirty = dirty;
    this.emit();
  }

  setFingerprint(path: string, fingerprint: Fingerprint): void {
    const tab = this.tabs.find((t) => t.path === path);
    if (!tab) return;
    tab.fingerprint = fingerprint;
    this.emit();
  }

  close(path: string): void {
    const idx = this.tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    this.tabs.splice(idx, 1);
    if (this.activePath === path) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1] ?? null;
      this.activePath = next?.path ?? null;
    }
    this.emit();
  }

  closeOthers(path: string): void {
    this.tabs = this.tabs.filter((t) => t.path === path);
    this.activePath = this.tabs[0]?.path ?? null;
    this.emit();
  }

  closeRight(path: string): void {
    const idx = this.tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    this.tabs = this.tabs.slice(0, idx + 1);
    if (!this.tabs.some((t) => t.path === this.activePath)) this.activePath = path;
    this.emit();
  }

  dirtyTabs(): TabState[] {
    return this.tabs.filter((t) => t.dirty);
  }

  move(from: number, to: number): void {
    if (from < 0 || to < 0 || from >= this.tabs.length || to >= this.tabs.length || from === to) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this.emit();
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}
