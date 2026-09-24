// store 订阅/更新（总纲 §10.3）
import { describe, expect, it, vi } from "vitest";
import { createStore } from "../../src/renderer/app/store";

describe("createStore", () => {
  it("get 返回初始状态", () => {
    const store = createStore({ count: 0 });
    expect(store.get()).toEqual({ count: 0 });
  });

  it("set 合并补丁并通知订阅者", () => {
    const store = createStore({ a: 1, b: 2 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ a: 10 });
    expect(store.get()).toEqual({ a: 10, b: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("退订函数生效", () => {
    const store = createStore({ a: 1 });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.set({ a: 2 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("退订其它订阅者不影响剩余订阅", () => {
    const store = createStore({ a: 1 });
    const l1 = vi.fn();
    const l2 = vi.fn();
    const off1 = store.subscribe(l1);
    store.subscribe(l2);
    off1();
    store.set({ a: 2 });
    expect(l1).not.toHaveBeenCalled();
    expect(l2).toHaveBeenCalledTimes(1);
  });
});
