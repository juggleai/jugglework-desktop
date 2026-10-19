import * as React from "react";
import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OfficeEditor } from "../src/react-app/domains/session/office/office-editor";
import { FileEditorToolbar } from "../src/react-app/domains/session/files/file-editor-toolbar";
import { t } from "../src/i18n";

for (const failure of ["version", "capabilities", "open", "bridge"] as const) {
  test(`${failure} 失败后两种宿主结束载入并显示原因`, async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    let opens = 0;
    let shows = 0;
    let resolveCapabilities!: (value: { available: boolean; reason?: string }) => void;
    let rejectCapabilities!: (error: Error) => void;
    const pending = new Promise<{ available: boolean; reason?: string }>(
      (resolve, reject) => {
        resolveCapabilities = resolve;
        rejectCapabilities = reject;
      },
    );
    const reason = failure === "version"
      ? "Office 引擎版本尚未适配"
      : failure === "bridge"
        ? t("office.desktop_required")
        : failure === "open"
          ? "打开文档请求失败"
          : "Office 能力查询失败";
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __JUGGLEWORK_ELECTRON__: failure === "bridge" ? undefined : {
          office: { show: async () => { shows++; } },
        },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    const client = {
      baseUrl: `http://unavailable-${failure}`,
      officeCapabilities: () => pending,
      openOfficeDocument: async () => {
        opens++;
        throw new Error(reason);
      },
    };
    const query = new QueryClient();
    const views: ReactTestRenderer[] = [];
    try {
      await act(async () => {
        for (const hideHeader of [false, true])
          views.push(create(
            <QueryClientProvider client={query}>
              <OfficeEditor
                client={client as any}
                workspaceId="ws"
                sessionId="ses_unavailable"
                path="演示.pptx"
                hideHeader={hideHeader}
              />
            </QueryClientProvider>,
          ));
      });
      if (failure !== "bridge") {
        expect(views[0]!.root.findByType(FileEditorToolbar).props.status).toBe("loading");
        expect(JSON.stringify(views[1]!.toJSON())).toContain(t("office.loading"));
      }
      await act(async () => {
        if (failure === "capabilities") rejectCapabilities(new Error(reason));
        else resolveCapabilities({ available: failure !== "version", reason });
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      for (const view of views) {
        expect(view.root.findByProps({ role: "alert" }).children).toContain(reason);
        expect(JSON.stringify(view.toJSON())).not.toContain(t("office.loading"));
        expect(JSON.stringify(view.toJSON())).not.toContain(t("office.open_failed"));
      }
      expect(JSON.stringify(views[0]!.toJSON())).toContain("演示.pptx");
      expect(views[0]!.root.findByType(FileEditorToolbar).props).toMatchObject({
        status: "error",
        saveDisabled: true,
      });
      expect(opens).toBe(failure === "open" ? 2 : 0);
      expect(shows).toBe(0);
    } finally {
      await act(async () => {
        for (const view of views) view.unmount();
      });
      query.clear();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    }
  });
}
