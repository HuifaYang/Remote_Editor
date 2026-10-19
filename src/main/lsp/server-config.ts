// 通用语言服务器注册表：配置驱动，不把语言支持写死在 cpp/python 里。
// 这里只处理纯数据，扩展宿主从 rce.lsp.servers 读入后即可支持任意标准 LSP。

export interface LanguageServerDefinition {
  id: string;
  languageIds: string[];
  extensions: string[];
  command: string;
  args: string[];
  env: Record<string, string>;
  rootMarkers: string[];
  initializationOptions?: unknown;
  enabled: boolean;
}

export interface LanguageMatch {
  server: LanguageServerDefinition;
  /** 发给服务端的 languageId；优先使用 VSCode 已识别的语言，否则用配置里的首个 ID。 */
  languageId: string;
}

/** C++ 默认参数；保留在纯数据模块里，LspManager 和扩展侧共用同一份。 */
export const DEFAULT_CLANGD_ARGS = [
  "--background-index",
  "--completion-style=detailed",
  "--header-insertion=never",
  "--malloc-trim",
  "-j=1",
];

/** 项目边界既用于找语言服务根，也防止把用户 home 当成一个巨型项目。 */
export const DEFAULT_ROOT_MARKERS = [
  "compile_commands.json", "compile_flags.txt", "CMakeLists.txt", "Makefile",
  ".clangd", ".git", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile",
  "go.mod", "go.work", "Cargo.toml", "rust-toolchain.toml", "package.json", "tsconfig.json",
  "jsconfig.json", "deno.json", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle",
  "Gemfile", "composer.json", "mix.exs", "Package.swift", "*.csproj", "*.sln", "Makefile.am",
];

const DEFAULT_SERVERS: LanguageServerDefinition[] = [
  {
    id: "cpp",
    languageIds: ["c", "cpp"],
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".ino"],
    command: "clangd",
    args: [...DEFAULT_CLANGD_ARGS],
    env: {},
    rootMarkers: ["compile_commands.json", "compile_flags.txt", "CMakeLists.txt", "Makefile", ".clangd", ".git"],
    enabled: true,
  },
  {
    id: "python",
    languageIds: ["python"],
    extensions: [".py", ".pyi", ".pyw"],
    command: "python3",
    args: ["-m", "pylsp"],
    env: {},
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", ".git"],
    enabled: true,
  },
];

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/** 兼容旧设置里把参数塞进一个字符串的写法。只处理常见空白与引号，路径含空格时应改用 args 数组。 */
export function splitCommandLine(value: string): string[] {
  const out: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of value.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        out.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }
  if (escaped) token += "\\";
  if (token) out.push(token);
  return out;
}

function normalizeServer(id: string, raw: unknown, base?: LanguageServerDefinition): LanguageServerDefinition | null {
  const value: Record<string, unknown> = typeof raw === "string"
    ? { command: raw }
    : raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
  if (!Object.keys(value).length && !base) return null;
  if (value.enabled === false) return null;

  const commandParts = typeof value.command === "string" ? splitCommandLine(value.command) : [];
  const command = commandParts[0] ?? base?.command ?? "";
  if (!command) return null;
  const args = Array.isArray(value.args)
    ? strings(value.args)
    : commandParts.length > 1
      ? commandParts.slice(1)
      : [...(base?.args ?? [])];
  const env: Record<string, string> = { ...(base?.env ?? {}) };
  if (value.env && typeof value.env === "object" && !Array.isArray(value.env)) {
    for (const [key, item] of Object.entries(value.env as Record<string, unknown>)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === "string") env[key] = item;
    }
  }
  const languageIds = strings(value.languageIds ?? value.languages);
  const extensions = strings(value.extensions).map(normalizeExtension).filter(Boolean);
  const rootMarkers = strings(value.rootMarkers);
  return {
    id,
    languageIds: languageIds.length ? [...new Set(languageIds)] : (base?.languageIds ?? [id]),
    extensions: extensions.length ? [...new Set(extensions)] : (base?.extensions ?? []),
    command,
    args,
    env,
    rootMarkers: rootMarkers.length ? [...new Set(rootMarkers)] : (base?.rootMarkers ?? []),
    initializationOptions: value.initializationOptions ?? base?.initializationOptions,
    enabled: value.enabled !== false,
  };
}

export interface ServerConfigOverrides {
  cppCommand?: string;
  pythonCommand?: string;
}

/** 合并默认 C++/Python 与用户配置。传入 false 可显式关闭某个默认服务器。 */
export function resolveLanguageServers(raw: unknown, overrides: ServerConfigOverrides = {}): Map<string, LanguageServerDefinition> {
  const result = new Map<string, LanguageServerDefinition>();
  for (const server of DEFAULT_SERVERS) result.set(server.id, server);

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const key = id.trim();
      if (!key) continue;
      const base = result.get(key);
      if (value === false) {
        result.delete(key);
        continue;
      }
      const server = normalizeServer(key, value, base);
      if (server) result.set(key, server);
      else result.delete(key);
    }
  }

  const override = (id: string, commandLine?: string): void => {
    if (!commandLine?.trim()) return;
    const base = result.get(id);
    if (!base) return;
    const parts = splitCommandLine(commandLine);
    if (!parts.length) return;
    result.set(id, { ...base, command: parts[0], args: parts.length > 1 ? parts.slice(1) : base.args });
  };
  override("cpp", overrides.cppCommand);
  override("python", overrides.pythonCommand);
  return result;
}

/** VSCode languageId 优先，扩展名兜底；这样内置语言扩展缺失时，配置过扩展名的服务器仍能工作。 */
export function matchLanguageServer(
  servers: Iterable<LanguageServerDefinition>,
  languageId: string,
  filePath: string,
): LanguageMatch | null {
  const list: LanguageServerDefinition[] = Array.isArray(servers)
    ? servers as LanguageServerDefinition[]
    : [...servers];
  const id = String(languageId || "").toLowerCase();
  const lowerPath = String(filePath || "").toLowerCase();
  for (const server of list) {
    if (!server.enabled) continue;
    const match = server.languageIds.find((candidate) => candidate.toLowerCase() === id);
    if (match) return { server, languageId: languageId || match };
  }
  for (const server of list) {
    if (!server.enabled) continue;
    if (server.extensions.some((extension) => lowerPath.endsWith(extension))) {
      return { server, languageId: server.languageIds[0] || server.id };
    }
  }
  return null;
}

export function rootMarkersFor(servers: Iterable<LanguageServerDefinition>): Set<string> {
  const markers = new Set(DEFAULT_ROOT_MARKERS);
  for (const server of servers) for (const marker of server.rootMarkers) markers.add(marker);
  return markers;
}
