import * as React from "react";
import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { JuggleWorkServerError } from "../src/app/lib/jugglework-server";
import { OfficeEditor } from "../src/react-app/domains/session/office/office-editor";
import { WorkbookFileView } from "../src/react-app/domains/session/files/workbook-file-view";
import { FileEditorToolbar } from "../src/react-app/domains/session/files/file-editor-toolbar";

test("两处只读预览均读取原始透视结果，不挂载原生页面或允许保存", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let shows = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __JUGGLEWORK_ELECTRON__: {
        office: {
          show: async () => {
            shows++;
          },
        },
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["x", 11],
      ["z", 33],
      ["合计", 44],
    ]),
    "透视结果",
  );
  const bytes = XLSX.write(book, {
    type: "array",
    bookType: "xlsx",
  }) as ArrayBuffer;
  const original = new Uint8Array(bytes).slice();
  const client = {
    baseUrl: "http://readonly-fixture",
    openOfficeDocument: async () => {
      throw new JuggleWorkServerError(
        409,
        "office_readonly_required",
        "包含数据透视表，仅支持预览",
      );
    },
    officeCapabilities: async () => ({ available: true }),
    downloadWorkspaceFile: async () => ({ data: bytes, contentType: null }),
    statWorkspaceFile: async () => ({ size: bytes.byteLength, updatedAt: 1 }),
  };
  const views: ReactTestRenderer[] = [];
  const queries = [new QueryClient(), new QueryClient()];
  try {
    for (let index = 0; index < queries.length; index++) {
      const query = queries[index]!;
      query.setQueryData(["office-capabilities", client.baseUrl, "ws"], {
        available: true,
      });
      await act(async () => {
        views.push(
          create(
            <QueryClientProvider client={query}>
              <OfficeEditor
                client={client as any}
                workspaceId="ws"
                sessionId="ses"
                path="透视.xlsx"
                hideHeader={index === 1}
              />
            </QueryClientProvider>,
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const view = views[index]!;
      expect(view.root.findAllByType(WorkbookFileView)).toHaveLength(1);
      expect(JSON.stringify(view.toJSON())).toContain("44");
      expect(
        view.root.findAllByProps({ "data-office-document": undefined }).length,
      ).toBeGreaterThan(0);
      expect(view.root.findAllByProps({ contentEditable: true })).toHaveLength(
        0,
      );
    }
    expect(views[0]!.root.findByType(FileEditorToolbar).props).toMatchObject({
      status: "readonly",
      saveDisabled: true,
    });
    expect(shows).toBe(0);
    expect(new Uint8Array(bytes)).toEqual(original);
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
