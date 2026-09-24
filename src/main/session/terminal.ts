// 终端通道（总纲 §5.6）：SSH shell + PTY，一块终端一个实例；关闭标签必须 close()
import { AppError } from "../../shared/errors.js";
import type { SSHConnection, ShellChannel } from "./connection.js";

export class TerminalChannel {
  private channel: ShellChannel | null = null;
  private dataCbs: Array<(chunk: Buffer) => void> = [];
  private closeCbs: Array<(code?: number) => void> = [];
  /** IPC 合帧缓冲（D2.4：≥16ms 或 4KB 批量发送，禁止逐字节/逐小包发送） */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly conn: SSHConnection) {}

  async open(cols: number, rows: number): Promise<void> {
    if (this.channel) return;
    const channel = await this.conn.shell({ term: "xterm-256color", cols, rows });
    this.channel = channel;
    channel.onData((chunk) => { this.push(chunk); });
    channel.onClose(() => { this.flush(); for (const cb of this.closeCbs) cb(); });
  }

  private push(chunk: Buffer): void {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= 4096) {
      this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 16);
    }
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;
    const merged = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    for (const cb of this.dataCbs) cb(merged);
  }

  write(data: string): void {
    if (!this.channel) throw new AppError("ssh", "终端尚未打开");
    this.channel.write(data);
  }

  resize(cols: number, rows: number): void {
    this.channel?.resize(cols, rows);
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataCbs.push(cb);
  }

  onClose(cb: (code?: number) => void): void {
    this.closeCbs.push(cb);
  }

  close(): void {
    this.channel?.close();
    this.channel = null;
  }
}
