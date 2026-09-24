// 边缘 8px 缩放热区（总纲 §13 坑 12）：frame:false 后系统不再提供边框缩放，用透明热区 + 主进程 setBounds
const EDGES = ["top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"];

export function mountEdgeResize(container: HTMLElement): void {
  for (const edge of EDGES) {
    const zone = document.createElement("div");
    zone.className = `resize-zone ${edge}`;
    zone.addEventListener("pointerdown", (e) => startDrag(e, edge));
    container.appendChild(zone);
  }
}

function startDrag(e: PointerEvent, edge: string): void {
  e.preventDefault();
  let lastX = e.screenX;
  let lastY = e.screenY;
  const onMove = (ev: PointerEvent): void => {
    const dx = ev.screenX - lastX;
    const dy = ev.screenY - lastY;
    if (dx !== 0 || dy !== 0) {
      window.api.window.resizeDrag(edge, dx, dy);
      lastX = ev.screenX;
      lastY = ev.screenY;
    }
  };
  const onUp = (): void => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}
