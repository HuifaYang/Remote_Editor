import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // tests/ui 下的用例在文件顶部用 `// @vitest-environment happy-dom` 单独声明
  },
});
