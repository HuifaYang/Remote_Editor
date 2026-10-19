import { describe, expect, it } from "vitest";
import { mapDocumentPathToServer, mapServerPathToWorkspace, mapWorkspacePathToServer, normalizeRemotePath, pathWithin, relativeToRoot } from "../../src/main/lsp/remote-path";

describe("远端 LSP 路径映射", () => {
  it("把软链接真实路径折回工作区路径", () => {
    expect(mapServerPathToWorkspace(
      "/robotdata/Le/ros2_ws/src/main.cpp",
      "/home/Le/ros2_ws",
      "/robotdata/Le/ros2_ws",
    )).toBe("/home/Le/ros2_ws/src/main.cpp");
    expect(mapWorkspacePathToServer("/home/Le/ros2_ws/src/main.cpp", "/home/Le/ros2_ws", "/robotdata/Le/ros2_ws"))
      .toBe("/robotdata/Le/ros2_ws/src/main.cpp");
  });

  it("工作区路径和外部系统头都保持可用", () => {
    expect(mapServerPathToWorkspace("/home/Le/ros2_ws/src/a.cpp", "/home/Le/ros2_ws")).toBe("/home/Le/ros2_ws/src/a.cpp");
    expect(mapServerPathToWorkspace("/usr/include/stdio.h", "/home/Le/ros2_ws", "/robotdata/Le/ros2_ws")).toBe("/usr/include/stdio.h");
    expect(mapDocumentPathToServer("./src/../src/a.cpp")).toBe("/src/a.cpp");
  });

  it("路径边界不会把 ws2 误认成 ws 的子目录", () => {
    expect(pathWithin("/home/Le/ws2/a.cpp", "/home/Le/ws")).toBe(false);
    expect(pathWithin("/home/Le/ws/a.cpp", "/home/Le/ws")).toBe(true);
    expect(relativeToRoot("/home/Le/ws/a.cpp", "/home/Le/ws")).toBe("a.cpp");
    expect(relativeToRoot("/home/Le/ws2/a.cpp", "/home/Le/ws")).toBeNull();
    expect(normalizeRemotePath("//home//Le/ws/")).toBe("/home/Le/ws");
  });
});
