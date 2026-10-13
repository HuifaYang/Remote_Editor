/* eslint 配置：eslint 8 + eslintrc 格式（规格 §3 指定 .eslintrc.cjs） */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { es2022: true, node: true, browser: true },
  // ide/ = 上游 CodeOSS 源码 + 我们的扩展（纯 JS），不纳入本仓库 lint（上游自带 eslint 配置）
  ignorePatterns: ["dist/", "release/", "node_modules/", "resources/codicons/", "ide/"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "off"
  }
};
