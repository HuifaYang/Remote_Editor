// 构建辅助：tsc 不处理 html/css，把渲染进程静态资源复制进 dist/renderer/
// （规格 §3：index.html 与 styles/ 属于 src/renderer，产物布局须保持相对路径不变）
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/renderer", { recursive: true });
cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("src/renderer/styles", "dist/renderer/styles", { recursive: true });
console.log("静态资源已复制到 dist/renderer/");
