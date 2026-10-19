// 只读 SSHFS 挂载：让本机语言服务直接、惰性地读取远端整棵文件系统。
// 目标机只需要 sshd/sftp；不安装语言服务器，也不复制源码或 sysroot。
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AppError } from "../../shared/errors.js";

export interface SshfsMountSpec {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  strictHostKey?: boolean;
  knownHostsPath?: string;
}

export interface SshfsMountOptions {
  mountPoint: string;
  spec: SshfsMountSpec;
  binary?: string;
  readOnly?: boolean;
  onLog?: (line: string) => void;
}

export class SshfsMount {
  private mounted = false;
  private child: ChildProcess | null = null;
  private readonly binary: string;

  constructor(private readonly opts: SshfsMountOptions) {
    this.binary = opts.binary || process.env.RCE_SSHFS_BIN || "sshfs";
  }

  get root(): string {
    return this.opts.mountPoint;
  }

  get isMounted(): boolean {
    return this.mounted || isMountPoint(this.opts.mountPoint);
  }

  async mount(): Promise<string> {
    if (this.isMounted) {
      this.mounted = true;
      return this.root;
    }
    fs.mkdirSync(this.opts.mountPoint, { recursive: true });
    const spec = this.opts.spec;
    const args = [
      "-p", String(spec.port),
      "-o", "reconnect",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "cache=yes",
      "-o", "kernel_cache",
      "-o", "auto_cache",
      "-o", "attr_timeout=1",
      "-o", "entry_timeout=1",
      "-o", "negative_timeout=0",
      "-o", `StrictHostKeyChecking=${spec.strictHostKey === false ? "no" : "yes"}`,
      "-o", `UserKnownHostsFile=${spec.knownHostsPath || "/dev/null"}`,
    ];
    if (this.opts.readOnly !== false) args.push("-o", "ro");
    if (spec.privateKeyPath) {
      args.push("-o", `IdentityFile=${spec.privateKeyPath}`, "-o", "IdentitiesOnly=yes");
    }
    if (spec.password || spec.passphrase) {
      args.push(
        "-o", "password_stdin",
        "-o", spec.privateKeyPath ? "PreferredAuthentications=publickey,password" : "PreferredAuthentications=password",
        "-o", "BatchMode=no",
      );
    }
    args.push(`${spec.username}@${spec.host}:/`, this.opts.mountPoint);

    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      let child: ChildProcess;
      try {
        child = spawn(this.binary, args, { stdio: ["pipe", "ignore", "pipe"] });
      } catch (err) {
        reject(this.mountError(err));
        return;
      }
      child.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
          stderr += line + "\n";
          this.opts.onLog?.(line);
        }
      });
      this.child = child;
      const deadline = Date.now() + 45000;
      let settled = false;
      const finishError = (code?: number | null): void => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        if (this.child?.exitCode === null) this.child.kill("SIGTERM");
        reject(new AppError(
          "lsp",
          `SSHFS 挂载失败（退出码 ${code ?? "unknown"}）`,
          stderr.trim() || "请确认开发机已安装 sshfs，且远端 sftp 可用",
        ));
      };
      const timer = setInterval(() => {
        if (isMountPoint(this.opts.mountPoint)) {
          settled = true;
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() >= deadline) finishError();
      }, 100);
      child.once("error", (err) => {
        if (!settled) {
          settled = true;
          clearInterval(timer);
        }
        reject(this.mountError(err));
      });
      child.once("close", (code) => {
        if (!settled || !isMountPoint(this.opts.mountPoint)) finishError(code);
      });
      // 密码/私钥口令只从内存写入子进程 stdin，不落盘、不进命令参数。
      child.stdin?.end(`${spec.password || spec.passphrase || ""}\n`);
    });
    this.mounted = true;
    this.opts.onLog?.(`SSHFS 已挂载：${spec.host}:/ → ${this.root}`);
    return this.root;
  }

  async unmount(): Promise<void> {
    if (!this.isMounted) {
      this.mounted = false;
      return;
    }
    const command = await findUnmountBinary();
    if (!command) {
      this.mounted = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const child = spawn(command, ["-u", this.opts.mountPoint], { stdio: "ignore" });
      child.once("error", () => resolve());
      child.once("close", () => resolve());
    });
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.mounted = false;
  }

  private mountError(err: unknown): AppError {
    const code = (err as { code?: string } | null)?.code;
    const hint = code === "ENOENT"
      ? "开发机缺少 sshfs。Debian/Ubuntu 可安装：sudo apt install sshfs"
      : "请确认远端 sshd 开启 sftp，且当前账号有读取权限";
    return new AppError("lsp", "无法建立语言服务只读文件视图", hint);
  }
}

export function isMountPoint(target: string): boolean {
  try {
    // 不能对 FUSE 挂载点做 realpath/stat：远端服务器与语言服务同进程时会阻塞事件循环。
    const real = path.resolve(target);
    const info = fs.readFileSync("/proc/self/mountinfo", "utf8");
    return info.split("\n").some((line) => {
      const fields = line.split(" ");
      if (fields.length < 5) return false;
      return decodeMountPath(fields[4]) === real;
    });
  } catch {
    return false;
  }
}

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
}

async function findUnmountBinary(): Promise<string | null> {
  for (const candidate of ["fusermount3", "fusermount"]) {
    if (await commandExists(candidate)) return candidate;
  }
  if (await commandExists("umount")) return "umount";
  return null;
}

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

export function mountedRemotePath(mountRoot: string, remotePath: string): string {
  const normalized = path.posix.normalize(remotePath.startsWith("/") ? remotePath : `/${remotePath}`);
  return path.join(mountRoot, ...normalized.split("/").filter(Boolean));
}

export function remotePathFromMount(mountRoot: string, localPath: string): string | null {
  const relative = path.relative(mountRoot, localPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return `/${relative.split(path.sep).join("/")}`.replace(/\/+$/, "") || "/";
}
