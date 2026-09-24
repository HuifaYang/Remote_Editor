// 极小假 LSP 服务器（分册 4 T9）：实现 initialize/completion/definition/hover + 一条诊断推送
let buf = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, Buffer.from(chunk)]);
  drain();
});

function drain() {
  for (;;) {
    const idx = buf.indexOf("\r\n\r\n");
    if (idx < 0) return;
    const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, idx).toString("ascii"));
    if (!m) { buf = buf.subarray(idx + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < idx + 4 + len) return;
    const msg = JSON.parse(buf.subarray(idx + 4, idx + 4 + len).toString("utf8"));
    buf = buf.subarray(idx + 4 + len);
    handle(msg);
  }
}

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(msg) {
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: 1, completionProvider: {} } } });
      return;
    case "initialized":
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: "file:///mirror/x/a.cpp",
          diagnostics: [{
            range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } },
            severity: 1, source: "fake", message: "expected ';'",
          }],
        },
      });
      return;
    case "textDocument/completion":
      send({ jsonrpc: "2.0", id: msg.id, result: { isIncomplete: false, items: [{ label: "fake_complete", kind: 3, detail: "int" }] } });
      return;
    case "textDocument/definition":
      send({ jsonrpc: "2.0", id: msg.id, result: [{ uri: "file:///mirror/x/b.cpp", range: { start: { line: 9, character: 2 }, end: { line: 9, character: 8 } } }] });
      return;
    case "textDocument/hover":
      send({ jsonrpc: "2.0", id: msg.id, result: { contents: { kind: "markdown", value: "**fake hover**" } } });
      return;
    case "shutdown":
      send({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    case "exit":
      process.exit(0);
      return;
    default:
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
}
