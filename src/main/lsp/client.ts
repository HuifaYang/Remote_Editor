// LSP 3.17 客户端子集（总纲 §5.5.2 / §13 坑 6）：自己实现 JSON-RPC 分帧，不引库
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { AppError } from "../../shared/errors.js";
import type {
  LspCompletionItem, LspCompletionList, LspDiagnostic, LspDiagnosticEvent, LspLocation,
} from "../../shared/types.js";

/** 语言服务器进程的抽象（本机 spawn / 板子上 SSH exec 两种实现见 manager.ts） */
export interface LspTransport {
  send(data: string): void;
  onData(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code?: number) => void): void;
  kill(): Promise<void>;
}

/** 编码一条 JSON-RPC 消息；Content-Length 按**字节**算（中文必须算对） */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** 分帧缓冲：半包/粘包都要处理（T8 前两条用例） */
export class MessageBuffer {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): JsonRpcMessage[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: JsonRpcMessage[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n", 0, "ascii");
      if (headerEnd < 0) break;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) break;   // 半包：等下一块
      const body = this.buf.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buf = this.buf.subarray(bodyStart + length);
      try {
        out.push(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // 坏消息丢弃，不能让整条连接死掉
      }
    }
    return out;
  }
}

export interface LspClientOptions {
  rootUri: string;
  clientName?: string;
  /** 规格未覆盖：请求超时，默认 10 秒（补全卡住时不能把 UI 挂死） */
  timeoutMs?: number;
  diagnostics?: (event: LspDiagnosticEvent) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export class LspClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly buffer = new MessageBuffer();
  private exited = false;
  private initialized = false;

  constructor(private readonly transport: LspTransport, private readonly opts: LspClientOptions) {
    transport.onData((chunk) => this.onData(chunk));
    transport.onExit(() => this.onExit());
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** 握手：initialize → initialized（T8.4 顺序断言） */
  async start(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: this.opts.clientName ?? "RemoteCodeEditor", version: "2.0.0" },
      rootUri: this.opts.rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
          definition: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
          publishDiagnostics: {},
        },
      },
      workspaceFolders: [{ uri: this.opts.rootUri, name: "workspace" }],
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(new AppError("lsp", "语言服务已退出"));
    const id = this.nextId++;
    const timeoutMs = this.opts.timeoutMs ?? 10000;
    return new Promise<unknown>((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new AppError("lsp", `语言服务响应超时：${method}`));
        }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send(encodeMessage({ jsonrpc: "2.0", id, method, params }).toString("utf8"));
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(new AppError("lsp", "语言服务写入失败", String(err)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.exited) return;
    this.transport.send(encodeMessage({ jsonrpc: "2.0", method, params }).toString("utf8"));
  }

  // ---- 规格 §5.5 接口 ----

  async completion(uri: string, line: number, character: number): Promise<LspCompletionItem[]> {
    const result = await this.request("textDocument/completion", {
      textDocument: { uri: toFileUri(uri) },
      position: { line, character },
    });
    if (result === null || result === undefined) return [];
    const list = result as LspCompletionList | LspCompletionItem[] | null;
    const items = Array.isArray(list) ? list : Array.isArray(list?.items) ? list.items : [];
    return items.map(normalizeCompletion);
  }

  async definition(uri: string, line: number, character: number): Promise<LspLocation[]> {
    const result = await this.request("textDocument/definition", {
      textDocument: { uri: toFileUri(uri) },
      position: { line, character },
    });
    if (result === null || result === undefined) return [];
    const list = Array.isArray(result) ? result : [result];
    return list.filter(isLocation).map((l) => ({ uri: l.uri, range: l.range }));
  }

  async hover(uri: string, line: number, character: number): Promise<string | null> {
    const result = await this.request("textDocument/hover", {
      textDocument: { uri: toFileUri(uri) },
      position: { line, character },
    });
    return hoverToMarkdown(result);
  }

  didOpen(uri: string, text: string, version: number): void {
    this.notify("textDocument/didOpen", {
      textDocument: { uri: toFileUri(uri), languageId: languageIdOf(uri), version, text },
    });
  }

  /** 全文同步（§5.5.4：TextDocumentSyncKind.Full，简单可靠） */
  didChange(uri: string, text: string, version: number): void {
    this.notify("textDocument/didChange", {
      textDocument: { uri: toFileUri(uri), version },
      contentChanges: [{ text }],
    });
  }

  didSave(uri: string, text: string): void {
    this.notify("textDocument/didSave", { textDocument: { uri: toFileUri(uri) }, text });
  }

  didClose(uri: string): void {
    this.notify("textDocument/didClose", { textDocument: { uri: toFileUri(uri) } });
  }

  async dispose(): Promise<void> {
    if (this.exited) return;
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } catch {
      // 服务已死 → 直接杀
    }
    await this.transport.kill();
    this.exited = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new AppError("lsp", "语言服务已关闭"));
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    for (const msg of this.buffer.push(chunk)) this.dispatch(msg);
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      this.pending.delete(Number(msg.id));
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) pending.reject(new AppError("lsp", msg.error.message, `code=${msg.error.code}`));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
      if (params?.uri) this.opts.diagnostics?.({ uri: params.uri, diagnostics: params.diagnostics ?? [] });
      return;
    }
    // 服务端主动请求必须应答，否则 clangd 会一直等（workspace/configuration 给空数组）
    if (msg.id !== undefined && msg.method) {
      const result = msg.method === "workspace/configuration" ? [] : null;
      try {
        this.transport.send(encodeMessage({ jsonrpc: "2.0", id: msg.id, result }).toString("utf8"));
      } catch {
        // 写失败就算了，进程马上会被收掉
      }
    }
  }

  private onExit(): void {
    this.exited = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new AppError("lsp", "语言服务已退出"));
    }
    this.pending.clear();
  }
}

function normalizeCompletion(item: LspCompletionItem): LspCompletionItem {
  const doc = (item as { documentation?: unknown }).documentation;
  const documentation = typeof doc === "string" ? doc : isMarkup(doc) ? doc.value : undefined;
  const out: LspCompletionItem = { ...item, label: String(item.label ?? "") };
  if (documentation !== undefined) out.documentation = documentation;
  return out;
}

function isMarkup(v: unknown): v is { value: string } {
  return typeof v === "object" && v !== null && typeof (v as { value?: unknown }).value === "string";
}

function isLocation(v: unknown): v is LspLocation {
  const l = v as LspLocation | null;
  return !!l && typeof l.uri === "string" && typeof l.range === "object" && l.range !== null;
}

/** hover 内容可能是 string / MarkedString / MarkupContent / 数组（§5.5.2） */
export function hoverToMarkdown(result: unknown): string | null {
  if (result === null || result === undefined) return null;
  const hover = result as { contents?: unknown };
  const contents = hover.contents ?? result;
  const parts: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.trim()) parts.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) push(item);
      return;
    }
    if (isMarkup(v)) {
      if (v.value.trim()) parts.push(v.value);
    }
  };
  push(contents);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function toFileUri(uriOrPath: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uriOrPath)) return uriOrPath;
  return pathToFileURL(uriOrPath).toString();
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  return decodeURIComponent(new URL(uri).pathname);
}

export function languageIdOf(uri: string): string {
  const ext = path.extname(uriToPath(uri)).toLowerCase();
  if (ext === ".py") return "python";
  if ([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"].includes(ext)) return "cpp";
  return "plaintext";
}
