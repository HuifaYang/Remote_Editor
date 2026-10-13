#!/usr/bin/env node
// 端到端用的**假语言服务**：clangd 在本机不一定装得上，但"语言服务桥"这条链路（镜像 → 进程 → JSON-RPC →
// provider → URI 翻译 → 诊断）必须真的跑一遍才算验证过。这个文件就是一个只会说 LSP 的极小实现，
// 参数/行为都照着 clangd 的关键面来：define / hover / documentSymbol / completion / publishDiagnostics。
//
// 用法（由扩展以进程方式拉起，命令行参数会被忽略）：
//   RCE_SPIKE_LSP_CPP=<此文件> bash ide/tools/run-e2e.sh
"use strict";

const path = require("node:path");

let buf = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

/** 从镜像文件 URI 里反推镜像根：文档是 <root>/src/main.c */
function rootOf(fileUri) {
  const p = decodeURIComponent(new URL(fileUri).pathname);
  return path.dirname(path.dirname(p));
}

// 注意参数是 (startLine, startChar, endLine, endChar)：早先写成 (line, a, b) 少了结束行，
// 结果 documentSymbol 的 range/selectionRange 相互不包含，VSCode 的 DocumentSymbol 构造直接抛
// "selectionRange must be contained in fullRange"（端到端踩过）
const range = (startLine, startChar, endLine, endChar) => ({
  start: { line: startLine, character: startChar },
  end: { line: endLine, character: endChar },
});

let opened = null;

function onMessage(msg) {
  if (msg.method === "initialize") {
    reply(msg.id, {
      capabilities: {
        textDocumentSync: 1,                       // Full
        definitionProvider: true,
        hoverProvider: true,
        documentSymbolProvider: true,
        completionProvider: { triggerCharacters: [".", ">", ":"] },
      },
      serverInfo: { name: "rce-fake-clangd", version: "0.0.1" },
    });
    return;
  }
  if (msg.method === "initialized" || msg.method === "exit") {
    if (msg.method === "exit") process.exit(0);
    return;
  }
  if (msg.method === "shutdown") {
    reply(msg.id, null);
    return;
  }
  if (msg.method === "textDocument/didOpen") {
    opened = msg.params.textDocument.uri;
    // 诊断（E2E 里验的是 DiagnosticCollection 这条回来的路）
    notify("textDocument/publishDiagnostics", {
      uri: opened,
      diagnostics: [{
        range: range(1, 0, 1, 12),
        severity: 2,
        code: "rce-fake",
        source: "rce-fake-clangd",
        message: "假语言服务：这条诊断来自镜像里的 clangd（E2E）",
      }],
    });
    return;
  }
  if (msg.method && msg.id !== undefined && msg.method.startsWith("textDocument/")) {
    const uri = (msg.params && msg.params.textDocument && msg.params.textDocument.uri) || opened;
    const root = rootOf(uri || "file:///tmp/src/main.c");
    if (msg.method === "textDocument/definition") {
      // 返回镜像里的另一个文件：验证"镜像路径 → sshfs://"的反向翻译
      reply(msg.id, [{
        uri: `file://${root}/src/util.c`,
        range: range(1, 0, 1, 3),
      }]);
      return;
    }
    if (msg.method === "textDocument/hover") {
      reply(msg.id, { contents: { kind: "markdown", value: "**假 clangd**\n\n悬浮信息来自镜像（`" + root + "`）" } });
      return;
    }
    if (msg.method === "textDocument/documentSymbol") {
      reply(msg.id, [{
        name: "main", detail: "int main()", kind: 12,
        range: range(0, 0, 2, 0), selectionRange: range(0, 4, 0, 8),
        children: [],
      }]);
      return;
    }
    if (msg.method === "textDocument/completion") {
      reply(msg.id, {
        isIncomplete: false,
        items: [
          { label: "rce_fake_printf", kind: 3, detail: "int printf(const char*, ...)" },
          { label: "rce_fake_return", kind: 14, detail: "关键字" },
        ],
      });
      return;
    }
    reply(msg.id, null);
    return;
  }
  // 服务端请求（workspace/configuration 等）：给个空结果，别让对面干等
  if (msg.id !== undefined) reply(msg.id, null);
}

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep < 0) return;
    const header = buf.subarray(0, sep).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buf = buf.subarray(sep + 4);
      continue;
    }
    const length = Number(m[1]);
    if (buf.length < sep + 4 + length) return;
    const body = buf.subarray(sep + 4, sep + 4 + length).toString("utf8");
    buf = buf.subarray(sep + 4 + length);
    try {
      onMessage(JSON.parse(body));
    } catch {
      /* 坏包丢掉，别把服务搞死 */
    }
  }
});
