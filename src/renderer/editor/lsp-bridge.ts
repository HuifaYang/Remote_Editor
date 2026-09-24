// Monaco ⇄ LSP 适配（总纲 §5.5.3）：补全 / 跳转定义 / 悬浮 + 诊断经 setModelMarkers 上屏。
// 禁止自己画波浪线；语言服务不可用时静默降级为 Monaco 内置词补全。
import type * as monaco from "monaco-editor";
import { toMonacoCompletion, toMonacoLocation, toMonacoMarker } from "../../shared/lsp-map.js";
import type { LspDiagnosticEvent } from "../../shared/types.js";

/** 固定 owner（§13 坑 7）：换文件先清空旧标记，避免上一个文件的波浪线残留 */
const MARKER_OWNER = "lsp";
const LANGUAGES = ["cpp", "python"];

export class LspBridge {
  private readonly disposables: monaco.IDisposable[] = [];
  private readonly tracked = new Map<string, monaco.IDisposable[]>();
  private readonly offDiagnostics: () => void;

  constructor(private readonly m: typeof monaco) {
    for (const language of LANGUAGES) {
      this.disposables.push(this.m.languages.registerCompletionItemProvider(language, {
        triggerCharacters: [".", ">", ":", "<", "#", "/"],
        provideCompletionItems: async (model, position) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
            startColumn: word.startColumn, endColumn: position.column,
          };
          try {
            const items = await window.api.lsp.completion(model.uri.toString(), position.lineNumber - 1, position.column - 1);
            return { suggestions: items.map((item) => ({ ...toMonacoCompletion(item), range })) };
          } catch {
            return { suggestions: [] };
          }
        },
      }));
      this.disposables.push(this.m.languages.registerDefinitionProvider(language, {
        provideDefinition: async (model, position) => {
          try {
            const locations = await window.api.lsp.definition(model.uri.toString(), position.lineNumber - 1, position.column - 1);
            return locations.map((l) => {
              const mapped = toMonacoLocation(l);
              return { uri: this.m.Uri.parse(mapped.uri), range: mapped.range };
            });
          } catch {
            return null;
          }
        },
      }));
      this.disposables.push(this.m.languages.registerHoverProvider(language, {
        provideHover: async (model, position) => {
          try {
            const text = await window.api.lsp.hover(model.uri.toString(), position.lineNumber - 1, position.column - 1);
            return text ? { contents: [{ value: text }] } : null;
          } catch {
            return null;
          }
        },
      }));
    }
    this.offDiagnostics = window.api.on("event:diagnostics", (e) => this.onDiagnostics(e as LspDiagnosticEvent));
  }

  /** 打开文件时调用：didOpen + 订阅 doChange；非 file 协议（Monaco 示例文档）直接跳过 */
  track(model: monaco.editor.ITextModel): void {
    if (model.uri.scheme !== "file") return;
    const uri = model.uri.toString();
    if (this.tracked.has(uri)) return;
    const subs: monaco.IDisposable[] = [
      model.onDidChangeContent(() => {
        window.api.lsp.changed(uri, model.getValue(), model.getVersionId());
      }),
    ];
    void window.api.lsp.ensure(uri)
      .then(() => window.api.lsp.open(uri, model.getValue(), model.getVersionId()))
      .catch(() => { /* 未连接 / 语言服务未装 → 降级为词补全，不弹框 */ });
    this.tracked.set(uri, subs);
  }

  /** 保存成功后调用（全文同步） */
  saved(model: monaco.editor.ITextModel): void {
    const uri = model.uri.toString();
    if (!this.tracked.has(uri)) return;
    window.api.lsp.save(uri, model.getValue());
  }

  /** 关闭标签时调用：didClose + 清掉诊断标记 */
  release(model: monaco.editor.ITextModel): void {
    const uri = model.uri.toString();
    const subs = this.tracked.get(uri);
    if (!subs) return;
    for (const d of subs) d.dispose();
    this.tracked.delete(uri);
    this.m.editor.setModelMarkers(model, MARKER_OWNER, []);
    window.api.lsp.close(uri);
  }

  dispose(): void {
    this.offDiagnostics();
    for (const subs of this.tracked.values()) for (const d of subs) d.dispose();
    this.tracked.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private onDiagnostics(event: LspDiagnosticEvent): void {
    for (const model of this.m.editor.getModels()) {
      if (!sameUri(model.uri.toString(), event.uri)) continue;
      this.m.editor.setModelMarkers(model, MARKER_OWNER, event.diagnostics.map(toMonacoMarker));
    }
  }
}

function sameUri(a: string, b: string): boolean {
  const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
  return decode(a) === decode(b);
}
