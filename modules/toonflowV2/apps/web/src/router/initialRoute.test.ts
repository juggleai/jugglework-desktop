import { describe, expect, test } from "bun:test";
import { initialRoute } from "./initialRoute";
import { modelEmptyText } from "@toonflow/nodes-scaffold/nodeAi";

describe("initialRoute", () => {
  test("managed mode skips first-run onboarding", () => {
    expect(initialRoute(true, false)).toBe("/home");
  });

  test("standalone first run keeps onboarding", () => {
    expect(initialRoute(false, false)).toBe("/hello");
  });

  test("completed onboarding opens home", () => {
    expect(initialRoute(false, true)).toBe("/home");
  });

  test("managed empty model copy points to JuggleWork instead of Toonfactory provider settings", () => {
    const host = globalThis as typeof globalThis & { toonflowManaged?: boolean };
    host.toonflowManaged = true;
    expect(modelEmptyText("请先在设置中添加视频模型", "视频模型")).toBe("JuggleWork 暂无可用视频模型");
    host.toonflowManaged = false;
    expect(modelEmptyText("请先在设置中添加视频模型", "视频模型")).toBe("请先在设置中添加视频模型");
    delete host.toonflowManaged;
  });
});
