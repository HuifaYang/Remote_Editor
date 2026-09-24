// Monaco 加载与主题注册（总纲 §13 坑 1：不引打包器，AMD loader 从 node_modules 异步加载）
import type * as monaco from "monaco-editor";

declare global {
  interface Window {
    // Monaco 自带的 AMD loader
    require?: {
      config(cfg: { paths: Record<string, string> }): void;
      (deps: string[], onOk: () => void, onErr?: (err: unknown) => void): void;
    };
    MonacoEnvironment?: monaco.Environment;
    monaco?: typeof monaco;
  }
}

// index.html 位于 dist/renderer/，node_modules 在其上两级（开发与打包布局一致）
const VS_PATH = "../../node_modules/monaco-editor/min/vs";

export function loadMonaco(): Promise<typeof monaco> {
  return new Promise((resolve, reject) => {
    const req = window.require;
    if (!req) {
      reject(new Error("Monaco loader 未加载"));
      return;
    }
    // file:// 下加载独立 Worker 受限：基础编辑用空 blob worker 兜底。
    // 规格未覆盖：Monaco 官方在 Electron 的推荐即此；补全/诊断走自研 LSP 客户端（M3），不依赖内置 worker。
    window.MonacoEnvironment = {
      getWorker: () => new Worker(
        URL.createObjectURL(new Blob(["self.onmessage = () => { /* 空 worker */ }"], { type: "text/javascript" })),
      ),
    };
    req.config({ paths: { vs: VS_PATH } });
    req(["vs/editor/editor.main"],
      () => {
        const m = window.monaco;
        if (m) resolve(m); else reject(new Error("Monaco 加载后全局对象缺失"));
      },
      (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Monaco 主题随应用主题（U6：深色/浅色两套，颜色取自 tokens.css，不落第二份色值） */
export function defineMonacoThemes(m: typeof monaco): void {
  m.editor.defineTheme("rce-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": cssVar("--bg-editor"),
      "editor.foreground": cssVar("--fg"),
      "editorLineNumber.foreground": cssVar("--fg-muted"),
      "editor.lineHighlightBackground": cssVar("--bg-hover"),
    },
  });
  m.editor.defineTheme("rce-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": cssVar("--bg-editor"),
      "editor.foreground": cssVar("--fg"),
      "editorLineNumber.foreground": cssVar("--fg-muted"),
      "editor.lineHighlightBackground": cssVar("--bg-hover"),
    },
  });
}

/** M1 示例代码：验证 Monaco 能编辑（验收标准） */
const SAMPLE = `// RemoteCodeEditor V2 —— M1 工程骨架
// 这这段文字可以在 Monaco 里直接编辑。
#include <chrono>
#include <rclcpp/rclcpp.hpp>

class RobotNode : public rclcpp::Node {
public:
  RobotNode() : Node("robot_node") {
    timer_ = create_wall_timer(std::chrono::milliseconds(100),
                               [this]() { tick(); });
  }

private:
  void tick() { RCLCPP_INFO(get_logger(), "tick"); }
  rclcpp::TimerBase::SharedPtr timer_;
};
`;

export function createEditor(m: typeof monaco, container: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  const model = m.editor.createModel(SAMPLE, "cpp");
  return m.editor.create(container, {
    model,
    theme: document.documentElement.dataset.theme === "light" ? "rce-light" : "rce-dark",
    fontSize: 13,
    fontFamily: '"JetBrains Mono", Consolas, monospace',
    lineNumbers: "on",
    minimap: { enabled: true },
    renderWhitespace: "selection",
    automaticLayout: true,
  });
}
