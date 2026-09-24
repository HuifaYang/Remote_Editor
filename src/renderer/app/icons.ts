// Codicons 图标（resources/codicons/，CC-BY 4.0）。
// 注意：CSS 变量里的相对 url() 在 Chromium 里的解析基准不可靠（实测会解析到 dist/ 下），
// 必须先用 new URL(..., document.baseURI) 转成绝对地址再塞进变量。
export function icon(name: string, title = ""): HTMLElement {
  const el = document.createElement("span");
  el.className = "icon";
  const url = new URL(`../../resources/codicons/${name}.svg`, document.baseURI).href;
  el.style.setProperty("--icon-url", `url("${url}")`);
  if (title) el.title = title;
  return el;
}
