// 分册 4 T8：JSON-RPC 分帧（半包/粘包/字节数）、握手顺序、报文转换、诊断转发
import { describe, expect, it } from "vitest";
import { LspClient, MessageBuffer, encodeMessage, hoverToMarkdown, type LspTransport } from "../../src/main/lsp/client";
import { toMonacoCompletion, toMonacoLocation, toMonacoMarker, toMonacoRange } from "../../src/shared/lsp-map";

interface SentMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

class FakeTransport implements LspTransport {
  readonly dataCbs: Array<(chunk: Buffer) => void> = [];
  readonly exitCbs: Array<(code?: number) => void> = [];
  readonly sent: Buffer[] = [];

  send(data: string): void { this.sent.push(Buffer.from(data)); }
  onData(cb: (chunk: Buffer) => void): void { this.dataCbs.push(cb); }
  onExit(cb: (code?: number) => void): void { this.exitCbs.push(cb); }
  kill(): Promise<void> { return Promise.resolve(); }

  pushRaw(chunk: Buffer): void { for (const cb of this.dataCbs) cb(chunk); }
  push(message: unknown): void { this.pushRaw(encodeMessage(message)); }

  messages(): SentMessage[] {
    const out: SentMessage[] = [];
    let buf = Buffer.concat(this.sent);
    for (;;) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString("ascii"))?.[1] ?? 0);
      const body = buf.subarray(headerEnd + 4, headerEnd + 4 + len);
      buf = buf.subarray(headerEnd + 4 + len);
      out.push(JSON.parse(body.toString("utf8")) as SentMessage);
    }
    return out;
  }

  last(): SentMessage {
    const all = this.messages();
    return all[all.length - 1];
  }
}

/** 起一个已握手的客户端（返回 transport 便于继续喂消息） */
async function startedClient(diagnostics?: (e: unknown) => void): Promise<{ client: LspClient; transport: FakeTransport }> {
  const transport = new FakeTransport();
  const client = new LspClient(transport, {
    rootUri: "file:///mirror/x",
    timeoutMs: 2000,
    diagnostics: diagnostics as never,
  });
  const starting = client.start();
  const init = transport.messages()[0];
  transport.push({ jsonrpc: "2.0", id: init.id, result: { capabilities: {} } });
  await starting;
  return { client, transport };
}

describe("T8.1 分帧", () => {
  it("test_frame_handles_partial_header", () => {
    // Given 同一条消息分两片到达（头也被切开）When push Then 只解析出一条完整消息
    const framed = encodeMessage({ jsonrpc: "2.0", method: "x", params: { ok: true } });
    const buffer = new MessageBuffer();
    expect(buffer.push(framed.subarray(0, 12))).toEqual([]);
    const out = buffer.push(framed.subarray(12));
    expect(out).toHaveLength(1);
    expect(out[0].method).toBe("x");
  });

  it("test_frame_handles_multiple_messages_in_one_chunk", () => {
    // Given 粘包 When push Then 两条都解析出来
    const buffer = new MessageBuffer();
    const chunk = Buffer.concat([
      encodeMessage({ jsonrpc: "2.0", method: "a" }),
      encodeMessage({ jsonrpc: "2.0", method: "b" }),
    ]);
    expect(buffer.push(chunk).map((m) => m.method)).toEqual(["a", "b"]);
  });

  it("test_content_length_counts_bytes_not_chars", () => {
    // Given 含中文的消息 When 编码 Then Content-Length = Buffer.byteLength（不是字符数）
    const framed = encodeMessage({ jsonrpc: "2.0", method: "hover", params: { text: "中文内容" } });
    const header = framed.subarray(0, framed.indexOf("\r\n\r\n")).toString("ascii");
    const declared = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
    const body = JSON.stringify({ jsonrpc: "2.0", method: "hover", params: { text: "中文内容" } });
    expect(declared).toBe(Buffer.byteLength(body, "utf8"));
    expect(declared).toBeGreaterThan(body.length - 2);
  });
});

describe("T8.2 握手与请求", () => {
  it("test_initialize_handshake_order", async () => {
    // Given 新客户端 When start Then 先 initialize 请求，收到响应后才发 initialized 通知
    const transport = new FakeTransport();
    const client = new LspClient(transport, { rootUri: "file:///mirror/x", timeoutMs: 2000 });
    const starting = client.start();
    const first = transport.messages()[0];
    expect(first.method).toBe("initialize");
    expect(transport.messages().some((m) => m.method === "initialized")).toBe(false);

    transport.push({ jsonrpc: "2.0", id: first.id, result: { capabilities: {} } });
    await starting;
    const last = transport.last();
    expect(last.method).toBe("initialized");
    expect(last.params).toEqual({});
  });

  it("test_request_rejects_on_timeout", async () => {
    const transport = new FakeTransport();
    const client = new LspClient(transport, { rootUri: "file:///x", timeoutMs: 20 });
    await expect(client.completion("file:///x/a.c", 0, 0)).rejects.toMatchObject({ code: "lsp" });
  });
});

describe("T8.3 报文转换", () => {
  it("test_completion_maps_to_monaco_shape", async () => {
    // Given clangd 返回 CompletionList When completion Then LSP kind 3 → Monaco kind 1，snippet 保留规则
    const { client, transport } = await startedClient();
    const pending = client.completion("file:///mirror/x/a.cpp", 1, 2);
    const request = transport.last();
    expect(request.method).toBe("textDocument/completion");
    transport.push({
      jsonrpc: "2.0", id: request.id,
      result: { isIncomplete: false, items: [{ label: "push_back", kind: 3, detail: "void", insertTextFormat: 2, insertText: "push_back(${1})" }] },
    });
    const items = await pending;
    expect(items).toHaveLength(1);
    const monaco = toMonacoCompletion(items[0]);
    expect(monaco).toMatchObject({ label: "push_back", kind: 1, detail: "void", insertTextRules: 4 });
  });

  it("test_definition_maps_location_to_range", async () => {
    const { client, transport } = await startedClient();
    const pending = client.definition("file:///mirror/x/a.cpp", 3, 4);
    const request = transport.last();
    transport.push({
      jsonrpc: "2.0", id: request.id,
      result: [{ uri: "file:///mirror/x/b.cpp", range: { start: { line: 9, character: 2 }, end: { line: 9, character: 8 } } }],
    });
    const locations = await pending;
    expect(toMonacoLocation(locations[0])).toEqual({
      uri: "file:///mirror/x/b.cpp",
      range: { startLineNumber: 10, startColumn: 3, endLineNumber: 10, endColumn: 9 },
    });
    expect(toMonacoRange(locations[0].range)).toEqual({ startLineNumber: 10, startColumn: 3, endLineNumber: 10, endColumn: 9 });
  });

  it("test_hover_returns_markdown_string", async () => {
    const { client, transport } = await startedClient();
    const pending = client.hover("file:///mirror/x/a.cpp", 0, 0);
    const request = transport.last();
    transport.push({ jsonrpc: "2.0", id: request.id, result: { contents: { kind: "markdown", value: "```cpp\nint a;\n```" } } });
    await expect(pending).resolves.toBe("```cpp\nint a;\n```");
    expect(hoverToMarkdown({ contents: ["a", { value: "b" }] })).toBe("a\n\nb");
    expect(hoverToMarkdown(null)).toBeNull();
  });

  it("test_did_open_uses_full_text_and_language_id", async () => {
    const { client, transport } = await startedClient();
    client.didOpen("/mirror/x/a.cpp", "int a;\n", 1);
    const msg = transport.last();
    expect(msg.method).toBe("textDocument/didOpen");
    const doc = (msg.params as { textDocument: Record<string, unknown> }).textDocument;
    expect(doc.languageId).toBe("cpp");
    expect(doc.uri).toBe("file:///mirror/x/a.cpp");

    client.didChange("/mirror/x/a.cpp", "int b;\n", 2);
    expect(transport.last().method).toBe("textDocument/didChange");
    expect((transport.last().params as { contentChanges: unknown[] }).contentChanges).toEqual([{ text: "int b;\n" }]);
  });

  it("test_diagnostics_event_is_forwarded", async () => {
    // Given 服务端推 publishDiagnostics When 客户端收到 Then 回调拿到 uri + diagnostics，并映射成 marker
    const events: Array<{ uri: string; diagnostics: unknown[] }> = [];
    const { transport } = await startedClient((e) => events.push(e as { uri: string; diagnostics: unknown[] }));
    transport.push({
      jsonrpc: "2.0", method: "textDocument/publishDiagnostics",
      params: { uri: "file:///mirror/x/a.cpp", diagnostics: [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } }, severity: 1, message: "expected ';'", source: "clang" }] },
    });
    expect(events).toHaveLength(1);
    expect(events[0].uri).toBe("file:///mirror/x/a.cpp");
    expect(toMonacoMarker(events[0].diagnostics[0] as never)).toMatchObject({
      severity: 8, message: "expected ';'", startLineNumber: 1, startColumn: 5, source: "clang",
    });
  });
});
