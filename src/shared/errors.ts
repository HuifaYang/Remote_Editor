// 统一错误类型（总纲 §9）：所有异步函数失败必须抛 AppError，渲染进程按 code 映射中文文案
import type { AppErrorCode, AppErrorShape } from "./types.js";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly detail?: string;
  /** 底层 SFTP 状态码（仅 sftp/not-found 场景有），给宿主 FileSystemProvider 做精确错误映射 */
  readonly sftpCode?: number;

  constructor(code: AppErrorCode, message: string, detail?: string, sftpCode?: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
    this.sftpCode = sftpCode;
  }

  /** 跨 IPC 传输前转成可序列化的形状 */
  toShape(): AppErrorShape {
    return { code: this.code, message: this.message, detail: this.detail, sftpCode: this.sftpCode };
  }
}

/** 把任意异常归类为 AppError（已经是 AppError 则原样返回） */
export function toAppError(err: unknown, fallbackCode: AppErrorCode = "unknown"): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError(fallbackCode, message);
}

/** 错误码 → 中文文案（渲染进程提示框用，文案不得改写） */
export const ERROR_TEXT: Record<AppErrorCode, string> = {
  "auth": "认证失败",
  "auth-passphrase-required": "该私钥有口令",
  "timeout": "连接超时",
  "network": "网络不可达",
  "host-key": "主机公钥校验失败",
  "ssh": "SSH 错误",
  "sftp": "文件传输错误",
  "not-found": "远端路径不存在",
  "git": "Git 命令失败",
  "mirror": "环境镜像同步失败",
  "lsp": "语言服务错误",
  "invalid-input": "输入无效",
  "unsupported": "当前环境不支持该功能",
  "unknown": "未知错误",
};
