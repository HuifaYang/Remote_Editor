import { describe, expect, it } from "vitest";
import { createScmService } from "../../ide/extensions/sshfs/src/scm.js";

class TestUri {
  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
  ) {}

  static from(value: { scheme: string; authority?: string; path?: string }): TestUri {
    return new TestUri(value.scheme, value.authority || "", value.path || "/");
  }

  static joinPath(base: TestUri, ...parts: string[]): TestUri {
    const path = `${base.path.replace(/\/+$/, "")}/${parts.join("/").replace(/^\/+/, "")}`;
    return new TestUri(base.scheme, base.authority, path);
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

class TestEventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

class TestFileDecoration {
  constructor(
    readonly badge?: string,
    readonly tooltip?: string,
    readonly color?: TestThemeColor,
  ) {}
}

class TestThemeColor {
  constructor(readonly id: string) {}
}

function snapshot(clean: boolean) {
  return {
    root: "/ws",
    branch: "main",
    scope: "/ws",
    files: clean ? {} : {
      "/ws/src/main.cpp": {
        path: "src/main.cpp",
        indexStatus: " ",
        worktreeStatus: "M",
        letter: "M",
        change: "modified",
      },
    },
    dirs: clean ? {} : { "/ws/src": "modified" },
    untrackedDirs: [],
    fetchedAt: Date.now(),
    complete: true,
    label: clean ? "Git: main" : "Git: main · 1 处变更",
    headCommit: clean ? "new-head" : "old-head",
    workspacePrefix: "",
  };
}

describe("远端 SCM 资源管理器装饰", () => {
  it("提交后刷新时通知旧文件和目录失效", async () => {
    let clean = false;
    let decorationProvider: {
      onDidChangeFileDecorations: (listener: (uris: TestUri[]) => void) => { dispose: () => void };
      provideFileDecoration: (uri: TestUri) => TestFileDecoration | undefined;
    };

    const sourceControl = {
      rootUri: new TestUri("sshfs", "u@host:22", "/ws"),
      inputBox: { value: "", placeholder: "" },
      actionButton: undefined,
      count: 0,
      createResourceGroup: () => ({ resourceStates: [] }),
      dispose: () => {},
    };
    const vscode = {
      Uri: TestUri,
      EventEmitter: TestEventEmitter,
      FileDecoration: TestFileDecoration,
      ThemeColor: TestThemeColor,
      window: {
        registerFileDecorationProvider(provider: typeof decorationProvider) {
          decorationProvider = provider;
          return { dispose: () => {} };
        },
      },
      scm: {
        createSourceControl: () => sourceControl,
      },
    };
    const git = {
      repoInfo: async () => ({ isRepository: true, root: "/ws", branch: "main" }),
      treeStatus: async () => snapshot(clean),
      branches: async () => [],
    };
    const session = { git };
    const service = createScmService(vscode, {
      log: () => {},
      sessionOf: () => session,
    });

    await service.attach(sourceControl.rootUri);
    const fileUri = TestUri.joinPath(sourceControl.rootUri, "src/main.cpp");
    const dirUri = TestUri.joinPath(sourceControl.rootUri, "src");
    expect(decorationProvider!.provideFileDecoration(fileUri)?.badge).toBe("M");
    expect(decorationProvider!.provideFileDecoration(dirUri)).toBeDefined();

    const changed: string[] = [];
    decorationProvider!.onDidChangeFileDecorations((uris) => {
      changed.push(...uris.map((uri) => uri.toString()));
    });
    clean = true;
    await service.refreshAll();

    expect(decorationProvider!.provideFileDecoration(fileUri)).toBeUndefined();
    expect(decorationProvider!.provideFileDecoration(dirUri)).toBeUndefined();
    expect(changed).toContain(fileUri.toString());
    expect(changed).toContain(dirUri.toString());
    service.dispose();
  });
});
