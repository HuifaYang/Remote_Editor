// LSP 3.17 客户端子集（总纲 §5.5.2 / §13 坑 6）：自己实现 JSON-RPC 分帧，不引库
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { AppError } from "../../shared/errors.js";
import type {
  LspCodeAction, LspCompletionItem, LspCompletionList, LspDiagnostic, LspDiagnosticEvent,
  LspDocumentHighlight, LspDocumentSymbol, LspFoldingRange, LspLocation, LspRange,
  LspSignatureHelp, LspTextEdit,
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
          declaration: {},
          typeDefinition: {},
          implementation: {},
          references: {},
          rename: { prepareSupport: true },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ["markdown", "plaintext"],
              parameterInformation: { labelOffsetSupport: true },
            },
          },
          documentHighlight: {},
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"],
              },
            },
          },
          formatting: {},
          rangeFormatting: {},
          foldingRange: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
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
    return normalizeLocations(result);
  }

  async hover(uri: string, line: number, character: number): Promise<string | null> {
    const result = await this.request("textDocument/hover", {
      textDocument: { uri: toFileUri(uri) },
      position: { line, character },
    });
    return hoverToMarkdown(result);
  }

  /** 文档符号（ui-parity E08）：层级 DocumentSymbol 与扁平 SymbolInformation 都归一化 */
  async documentSymbol(uri: string): Promise<LspDocumentSymbol[]> {
    const result = await this.request("textDocument/documentSymbol", {
      textDocument: { uri: toFileUri(uri) },
    });
    return normalizeDocumentSymbols(result);
  }

  /** 跳转类能力共用：definition / declaration / typeDefinition / implementation / references */
  private async locations(method: string, uri: string, line: number, character: number): Promise<LspLocation[]> {
    const result = await this.request(method, {
      textDocument: { uri: toFileUri(uri) },
      position: { line, character },
    });
    return normalizeLocations(result);
  }

  declaration(uri: string, line: number, character: number): Promise<LspLocation[]> {
    return this.locations("textDocument/declaration", uri, line, character);
  }

  typeDefinition(uri: string, line: number, character: number): Promise<LspLocation[]> {
    return this.locations("textDocument/typeDefinition", uri, line, character);
  }

  implementation(uri: string, line: number, character: number): Promise<LspLocation[]> {
    return this.locations("textDocument/implementation", uri, line, character);
  }

  async references(uri: string, line: number, character: number, includeDeclaration = true): Promise<LspLocation[]> {
    const result = await this.request("textDocument/references", {
      textDocument: { uri: toFileUri(uri) },
      position: { line, character },
      context: { includeDeclaration },
    });
    return normalizeLocations(result);
  }

  async prepareRename(uri: string, line: number, character: number): Promise<LspRange | null> {
    const result = await this.request("textDocument/prepareRename", {
      textDocument: { uri: toFileUri(uri) },
      position: { line, character },
    });
    if (result === null || result === undefined) return null;
    const range = (result as { range?: unknown }).range ?? result;
    return isRange(range) ? range : null;
  }

  async rename(uri: string, line: number, character: number, newName: string): Promise<Record<string, LspTextEdit[]>> {
    const result = await this.request("textDocument/rename", {
      textDocument: { uri: toFileUri(uri) },
      position: { line, character },
      newName,
    });
    if (!result || typeof result !== "object") return {};
    return normalizeWorkspaceEdit((result as { changes?: unknown }).changes);
  }

  async signatureHelp(uri: string, line: number, character: number): Promise<LspSignatureHelp | null> {
    const result = await this.request("textDocument/signatureHelp", {
      textDocument: { uri: toFileUri(uri) },
      position: { line, character },
      context: { triggerKind: 1 },
    });
    return normalizeSignatureHelp(result);
  }

  async documentHighlight(uri: string, line: number, character: number): Promise<LspDocumentHighlight[]> {
    const result = await this.request("textDocument/documentHighlight", {
      textDocument: { uri: toFileUri(uri) },
      position: { line, character },
    });
    return normalizeDocumentHighlights(result);
  }

  async codeAction(uri: string, range: LspRange, diagnostics: LspDiagnostic[]): Promise<LspCodeAction[]> {
    const result = await this.request("textDocument/codeAction", {
      textDocument: { uri: toFileUri(uri) },
      range,
      context: { diagnostics },
    });
    return normalizeCodeActions(result);
  }

  async formatting(uri: string, options: Record<string, unknown>): Promise<LspTextEdit[]> {
    const result = await this.request("textDocument/formatting", {
      textDocument: { uri: toFileUri(uri) },
      options,
    });
    return normalizeTextEdits(result);
  }

  async rangeFormatting(uri: string, range: LspRange, options: Record<string, unknown>): Promise<LspTextEdit[]> {
    const result = await this.request("textDocument/rangeFormatting", {
      textDocument: { uri: toFileUri(uri) },
      range,
      options,
    });
    return normalizeTextEdits(result);
  }

  async foldingRanges(uri: string): Promise<LspFoldingRange[]> {
    const result = await this.request("textDocument/foldingRange", {
      textDocument: { uri: toFileUri(uri) },
    });
    return normalizeFoldingRanges(result);
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
  return !!l && typeof l.uri === "string" && isRange(l.range);
}

function isRange(v: unknown): v is LspRange {
  const r = v as LspRange | null;
  return !!r && typeof r === "object" && typeof r.start?.line === "number"
    && typeof r.start?.character === "number" && typeof r.end?.line === "number" && typeof r.end?.character === "number";
}

function markupText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (isMarkup(v)) return v.value;
  if (Array.isArray(v)) {
    const parts = v.map(markupText).filter((x): x is string => typeof x === "string");
    return parts.length ? parts.join("\n\n") : undefined;
  }
  return undefined;
}

/** Location 与 LocationLink 都归一化成 { uri, range }。 */
export function normalizeLocations(result: unknown): LspLocation[] {
  if (result === null || result === undefined) return [];
  const list = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  for (const raw of list) {
    if (isLocation(raw)) {
      out.push({ uri: raw.uri, range: raw.range });
      continue;
    }
    const link = raw as { targetUri?: unknown; targetRange?: unknown; targetSelectionRange?: unknown } | null;
    if (link && typeof link.targetUri === "string") {
      const range = isRange(link.targetSelectionRange) ? link.targetSelectionRange : link.targetRange;
      if (isRange(range)) out.push({ uri: link.targetUri, range });
    }
  }
  return out;
}

function isTextEdit(v: unknown): v is LspTextEdit {
  const e = v as LspTextEdit | null;
  return !!e && isRange(e.range) && typeof e.newText === "string";
}

export function normalizeTextEdits(result: unknown): LspTextEdit[] {
  if (!Array.isArray(result)) return [];
  return result.filter(isTextEdit).map((e) => ({ range: e.range, newText: e.newText }));
}

export function normalizeWorkspaceEdit(changes: unknown): Record<string, LspTextEdit[]> {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return {};
  const out: Record<string, LspTextEdit[]> = {};
  for (const [uri, edits] of Object.entries(changes as Record<string, unknown>)) {
    const normalized = normalizeTextEdits(edits);
    if (normalized.length) out[uri] = normalized;
  }
  return out;
}

export function normalizeSignatureHelp(result: unknown): LspSignatureHelp | null {
  if (!result || typeof result !== "object") return null;
  const raw = result as { signatures?: unknown; activeSignature?: unknown; activeParameter?: unknown };
  if (!Array.isArray(raw.signatures)) return null;
  const signatures = raw.signatures.map((entry) => {
    const s = entry as { label?: unknown; documentation?: unknown; parameters?: unknown; activeParameter?: unknown };
    const parameters = Array.isArray(s.parameters) ? s.parameters.map((p) => {
      const param = p as { label?: unknown; documentation?: unknown };
      const label = typeof param.label === "string" || (Array.isArray(param.label) && param.label.length === 2)
        ? param.label as string | [number, number]
        : "";
      const info: { label: string | [number, number]; documentation?: string } = { label };
      const doc = markupText(param.documentation);
      if (doc) info.documentation = doc;
      return info;
    }) : undefined;
    const info: LspSignatureHelp["signatures"][number] = { label: String(s.label ?? "") };
    const doc = markupText(s.documentation);
    if (doc) info.documentation = doc;
    if (parameters && parameters.length) info.parameters = parameters;
    if (typeof s.activeParameter === "number") info.activeParameter = s.activeParameter;
    return info;
  }).filter((s) => s.label.length > 0);
  if (!signatures.length) return null;
  const help: LspSignatureHelp = { signatures };
  if (typeof raw.activeSignature === "number") help.activeSignature = raw.activeSignature;
  if (typeof raw.activeParameter === "number") help.activeParameter = raw.activeParameter;
  return help;
}

export function normalizeDocumentHighlights(result: unknown): LspDocumentHighlight[] {
  if (!Array.isArray(result)) return [];
  const out: LspDocumentHighlight[] = [];
  for (const raw of result) {
    const h = raw as { range?: unknown; kind?: unknown } | null;
    if (h && isRange(h.range)) out.push({ range: h.range, kind: typeof h.kind === "number" ? h.kind : undefined });
  }
  return out;
}

export function normalizeCodeActions(result: unknown): LspCodeAction[] {
  if (!Array.isArray(result)) return [];
  const out: LspCodeAction[] = [];
  for (const raw of result) {
    const a = raw as Record<string, unknown> | null;
    if (!a || typeof a.title !== "string") continue;
    const action: LspCodeAction = { title: a.title };
    if (typeof a.kind === "string") action.kind = a.kind;
    if (a.edit && typeof a.edit === "object") {
      const changes = normalizeWorkspaceEdit((a.edit as { changes?: unknown }).changes);
      if (Object.keys(changes).length) action.edit = { changes };
    }
    if (typeof a.command === "string") {
      action.command = {
        title: a.title,
        command: a.command,
        arguments: Array.isArray(a.arguments) ? a.arguments : undefined,
      };
    }
    if (a.isPreferred === true) action.isPreferred = true;
    const disabled = a.disabled as { reason?: unknown } | undefined;
    if (disabled && typeof disabled.reason === "string") action.disabled = { reason: disabled.reason };
    if (Array.isArray(a.diagnostics)) action.diagnostics = a.diagnostics as LspDiagnostic[];
    out.push(action);
  }
  return out;
}

export function normalizeFoldingRanges(result: unknown): LspFoldingRange[] {
  if (!Array.isArray(result)) return [];
  const out: LspFoldingRange[] = [];
  for (const raw of result) {
    const f = raw as { startLine?: unknown; startCharacter?: unknown; endLine?: unknown; endCharacter?: unknown; kind?: unknown; collapsedText?: unknown } | null;
    if (!f || typeof f.startLine !== "number" || typeof f.endLine !== "number") continue;
    const range: LspFoldingRange = { startLine: f.startLine, endLine: f.endLine };
    if (typeof f.startCharacter === "number") range.startCharacter = f.startCharacter;
    if (typeof f.endCharacter === "number") range.endCharacter = f.endCharacter;
    if (typeof f.kind === "string") range.kind = f.kind;
    if (typeof f.collapsedText === "string") range.collapsedText = f.collapsedText;
    out.push(range);
  }
  return out;
}

/** 归一化文档符号：层级 DocumentSymbol（range/selectionRange）与扁平 SymbolInformation（location.range）都支持 */
export function normalizeDocumentSymbols(result: unknown): LspDocumentSymbol[] {
  if (!Array.isArray(result)) return [];
  const out: LspDocumentSymbol[] = [];
  for (const raw of result) {
    const symbol = normalizeDocumentSymbol(raw);
    if (symbol) out.push(symbol);
  }
  return out;
}

function normalizeDocumentSymbol(raw: unknown): LspDocumentSymbol | null {
  const s = raw as Record<string, unknown> | null;
  if (!s || typeof s.name !== "string") return null;
  // 层级形状带 range；扁平形状把范围放在 location.range 里
  const ownRange = isRange(s.range) ? s.range : null;
  const locRange = isRange((s.location as { range?: unknown } | undefined)?.range)
    ? (s.location as { range: LspRange }).range : null;
  const range = ownRange ?? locRange;
  if (!range) return null;
  const selectionRange = isRange(s.selectionRange) ? s.selectionRange : range;
  const symbol: LspDocumentSymbol = {
    name: s.name,
    kind: typeof s.kind === "number" ? s.kind : 0,
    range,
    selectionRange,
  };
  if (typeof s.detail === "string") symbol.detail = s.detail;
  if (Array.isArray(s.children)) {
    const children = normalizeDocumentSymbols(s.children);
    if (children.length > 0) symbol.children = children;
  }
  return symbol;
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
