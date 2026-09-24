// AppError 归类与文案（总纲 §9.1）
import { describe, expect, it } from "vitest";
import { AppError, ERROR_TEXT, toAppError } from "../../src/shared/errors";

describe("AppError", () => {
  it("toShape 可序列化", () => {
    const err = new AppError("auth", "认证失败", "detail");
    expect(err.toShape()).toEqual({ code: "auth", message: "认证失败", detail: "detail" });
  });

  it("toAppError 保留已有 AppError", () => {
    const err = new AppError("timeout", "超时");
    expect(toAppError(err)).toBe(err);
  });

  it("toAppError 归类裸 Error", () => {
    const err = toAppError(new Error("boom"), "ssh");
    expect(err.code).toBe("ssh");
    expect(err.message).toBe("boom");
  });

  it("每个错误码都有中文文案", () => {
    for (const text of Object.values(ERROR_TEXT)) {
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
