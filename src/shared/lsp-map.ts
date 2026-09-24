// LSP → Monaco 形状映射（纯函数，总纲 §5.5.3；主进程与渲染进程共用，便于单测）
import type { LspCompletionItem, LspDiagnostic, LspLocation } from "./types.js";

/** Monaco CompletionItemKind 取值（monaco.languages.CompletionItemKind） */
const KIND_TABLE: Record<number, number> = {
  1: 18,   // Text
  2: 0,    // Method
  3: 1,    // Function
  4: 2,    // Constructor
  5: 3,    // Field
  6: 4,    // Variable
  7: 5,    // Class
  8: 7,    // Interface
  9: 8,    // Module
  10: 9,   // Property
  11: 12,  // Unit
  12: 13,  // Value
  13: 15,  // Enum
  14: 17,  // Keyword
  15: 27,  // Snippet
  16: 19,  // Color
  17: 20,  // File
  18: 21,  // Reference
  19: 23,  // Folder
  20: 16,  // EnumMember
  21: 14,  // Constant
  22: 6,   // Struct
  23: 10,  // Event
  24: 11,  // Operator
  25: 24,  // TypeParameter
};

export interface MonacoCompletion {
  label: string;
  kind: number;
  detail?: string;
  documentation?: string;
  insertText: string;
  insertTextRules?: number;
  sortText?: string;
  filterText?: string;
}

/** Monaco 的 IRange 是扁平形状（startLineNumber…），不是嵌套的 start/end */
export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
export interface MonacoLocation { uri: string; range: MonacoRange }
export interface MonacoMarker {
  severity: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source?: string;
  code?: string;
}

export function toMonacoCompletion(item: LspCompletionItem): MonacoCompletion {
  const out: MonacoCompletion = {
    label: item.label,
    kind: item.kind === undefined ? 18 : KIND_TABLE[item.kind] ?? 18,
    insertText: item.insertText ?? item.label,
  };
  if (item.detail !== undefined) out.detail = item.detail;
  if (item.documentation !== undefined) out.documentation = item.documentation;
  if (item.sortText !== undefined) out.sortText = item.sortText;
  if (item.filterText !== undefined) out.filterText = item.filterText;
  // LSP Snippet(2) → Monaco InsertAsSnippet(4)
  if (item.insertTextFormat === 2) out.insertTextRules = 4;
  return out;
}

export function toMonacoRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): MonacoRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

export function toMonacoLocation(location: LspLocation): MonacoLocation {
  return { uri: location.uri, range: toMonacoRange(location.range) };
}

/** LSP 1=Error 2=Warning 3=Info 4=Hint → Monaco MarkerSeverity 8/4/2/1 */
export function toMonacoSeverity(severity?: number): number {
  switch (severity) {
    case 1: return 8;
    case 2: return 4;
    case 3: return 2;
    case 4: return 1;
    default: return 8;
  }
}

export function toMonacoMarker(d: LspDiagnostic): MonacoMarker {
  const marker: MonacoMarker = {
    severity: toMonacoSeverity(d.severity),
    message: d.message,
    ...toMonacoRange(d.range),
  };
  if (d.source !== undefined) marker.source = d.source;
  if (d.code !== undefined) marker.code = String(d.code);
  return marker;
}
