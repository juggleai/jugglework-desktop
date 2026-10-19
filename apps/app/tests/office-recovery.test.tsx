import * as React from "react";
import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OfficeDocumentSession } from "@jugglework/types/office";
import { OfficeEditor } from "../src/react-app/domains/session/office/office-editor";
import { t } from "../src/i18n";

test("页面故障通知令两处视图显示恢复入口，取消保留错误，确认后同步状态且保留标签身份", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const listeners = new Set<(document: OfficeDocumentSession) => void>();
  const doc: OfficeDocumentSession = {
    documentId: "od_recovery",
    artifactId: "af_recovery",
    workspaceId: "ws",
    ownerSessionId: "ses_recovery",
    relativePath: "恢复.csv",
    name: "恢复.csv",
    state: "ready",
    engineFileId: "model_before_failure",
    previewUrl: null,
    dirty: true,
    savedAt: 1,
  };
  let cancel = true;
  const native = {
    async recover() {
      if (cancel) return null;
      const next = {
        ...doc,
        state: "opening" as const,
        dirty: false,
        error: undefined,
      };
      Object.assign(doc, next);
      for (const listener of listeners) listener(next);
      return next;
    },
    onDocumentChanged(callback: (document: OfficeDocumentSession) => void) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __JUGGLEWORK_ELECTRON__: { office: native },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const queries = [new QueryClient(), new QueryClient()];
  const views: ReactTestRenderer[] = [];
  const client = {
    baseUrl: "http://fixture",
    officeCapabilities: async () => ({ available: true, formats: ["csv"] }),
    openOfficeDocument: async () => ({ document: structuredClone(doc) }),
    getOfficeDocument: async () => ({ document: structuredClone(doc) }),
  };
  try {
    for (const query of queries)
      query.setQueryData(["office-capabilities", client.baseUrl, "ws"], {
        available: true,
        formats: ["csv"],
      });
    await act(async () => {
      for (const query of queries)
        views.push(
          create(
            <QueryClientProvider client={query}>
              <OfficeEditor
                client={client as any}
                workspaceId="ws"
                sessionId="ses_recovery"
                path="恢复.csv"
                hideHeader
              />
            </QueryClientProvider>,
          ),
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      Object.assign(doc, {
        state: "error",
        engineFileId: null,
        error: "文档编辑页面已退出",
      });
      for (const listener of listeners) listener(structuredClone(doc));
    });
    const button = (view: ReactTestRenderer) => view.root.findByType("button");
    for (const view of views) {
      expect(button(view).props.children).toBe(t("office.recover_saved"));
      expect(view.root.findByProps({ role: "alert" }).children).toContain(
        doc.error!,
      );
    }
    await act(async () => {
      button(views[0]!).props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(views[0]!.root.findByProps({ role: "alert" }).children).toContain(
      doc.error!,
    );
    cancel = false;
    await act(async () => {
      button(views[0]!).props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    for (const view of views) {
      expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(0);
      expect(
        view.root.findByProps({ "data-office-document": "od_recovery" }),
      ).toBeTruthy();
    }
  } finally {
    await act(async () => {
      for (const view of views) view.unmount();
    });
    for (const query of queries) query.clear();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});
