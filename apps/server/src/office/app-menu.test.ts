import { expect, mock, test } from "bun:test";

let template: any[] = [];
mock.module("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Menu: {
    buildFromTemplate: (value: any[]) => value,
    setApplicationMenu: (value: any[]) => {
      template = value;
    },
  },
  shell: {},
}));
const { createApplicationMenu } =
  // @ts-expect-error 桌面 JS 由 checkJs 检查，此处验证原生菜单契约。
  await import("../../../desktop/electron/app-menu.mjs");

test("macOS 文件窗口名称随焦点切换，品牌更新不覆盖活动文件菜单，切回恢复最新品牌", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const title = process.title;
  try {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    const menu = createApplicationMenu({
      appName: "JuggleWork",
      docsUrl: "",
      getWindow: async () => null,
    });
    menu.install();
    expect(template[0].label).toBe("JuggleWork");
    menu.setFileWindowActive(true);
    expect(template[0].label).toBe("JuggleWork 文件浏览器");
    expect(process.title).toBe("JuggleWork 文件浏览器");
    menu.setAppName("品牌名称");
    expect(template[0].label).toBe("JuggleWork 文件浏览器");
    menu.setFileWindowActive(false);
    expect(template[0].label).toBe("品牌名称");
    expect(process.title).toBe("品牌名称");
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    menu.setFileWindowActive(true);
    expect(process.title).toBe("品牌名称");
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    process.title = title;
  }
});
