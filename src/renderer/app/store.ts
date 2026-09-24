// 极简状态容器（总纲 §5.9.1，禁止引库）
export interface Store<T> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T>): void {
      state = { ...state, ...patch };
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

/** 全局 UI 状态切片（总纲 §5.9.1 的 ui 切片，M1 先建骨架） */
export interface UiState {
  theme: "dark" | "light";
  sidebarView: string | null;   // files / search / source-control / hosts / null=收起
  zoom: number;                 // 0.7 ~ 2.0
}

export const uiStore = createStore<UiState>({ theme: "dark", sidebarView: null, zoom: 1 });

/** 应用状态切片（M4：连接 / 工作目录 / 保存状态 / 状态栏右半区） */
export interface AppState {
  connected: boolean;
  hostName: string;
  workspace: string;
  saveState: "saved" | "dirty" | "saving" | "failed";
  saveMessage: string;
  gitLabel: string;
  encoding: string;
  language: string;
  line: number;
  column: number;
  mirrorStale: boolean;
}

export const appStore = createStore<AppState>({
  connected: false,
  hostName: "",
  workspace: "",
  saveState: "saved",
  saveMessage: "",
  gitLabel: "",
  encoding: "utf-8",
  language: "",
  line: 1,
  column: 1,
  mirrorStale: false,
});
