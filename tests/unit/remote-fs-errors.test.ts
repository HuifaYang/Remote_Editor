// SFTP 失败归类（总纲 §9 + Q1 适配点 1）：宿主 FileSystemProvider 需要靠 code/sftpCode 精确区分
// 「不存在 / 无权限」，否则 VSCode 的 createDirectory（先 stat、只把 FileNotFound 当正常）会直接失败。
import { describe, expect, it } from "vitest";
import { classifySftpError } from "../../src/main/session/remote-fs";

/** 造一个 ssh2 风格的 SFTP 错误：状态码塞在 err.code */
function sftpError(code: number, message = ""): Error {
  return Object.assign(new Error(message), { code });
}

describe("classifySftpError", () => {
  it("NO_SUCH_FILE(2) → not-found，并保留原始状态码", () => {
    const err = classifySftpError(sftpError(2), "/ws/nope");
    expect(err.code).toBe("not-found");
    expect(err.detail).toBe("/ws/nope");
    expect(err.sftpCode).toBe(2);
  });

  it("PERMISSION_DENIED(3) → sftp + 权限不足", () => {
    const err = classifySftpError(sftpError(3), "/root/x");
    expect(err.code).toBe("sftp");
    expect(err.message).toBe("权限不足");
    expect(err.sftpCode).toBe(3);
  });

  it("其它 SFTP 状态码保留服务端消息", () => {
    const err = classifySftpError(sftpError(4, "Failure"), "/ws/x");
    expect(err.code).toBe("sftp");
    expect(err.message).toBe("Failure");
    expect(err.sftpCode).toBe(4);
  });

  it("非 SFTP 错误退回 sftp 兜底码", () => {
    const err = classifySftpError(new Error("socket closed"), "/ws/x");
    expect(err.code).toBe("sftp");
    expect(err.message).toBe("socket closed");
    expect(err.sftpCode).toBeUndefined();
  });
});
