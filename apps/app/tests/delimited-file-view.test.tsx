import * as React from "react";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DelimitedFileView } from "../src/react-app/domains/session/files/delimited-file-view";
import { OfficeEditor } from "../src/react-app/domains/session/office/office-editor";
import { FileViewer } from "../src/react-app/domains/session/files/file-viewer";
import { resolvePresentation } from "../src/react-app/domains/session/files/file-content";
import { useFilesPanelStore } from "../src/react-app/domains/session/files/files-panel-store";
import {
  parseDelimitedSpreadsheet,
  serializeDelimitedSpreadsheet,
} from "../src/react-app/domains/session/artifacts/artifact-spreadsheet-model";
import { t } from "../src/i18n";

test("CSV/TSV 按表格分流，原始文本与 Office 二进制仍保持各自路径", () => {
  const bytes = new TextEncoder().encode("姓名,公司\n张伟,星河科技\n").buffer;
  for (const path of ["报告.csv", "REPORT.CSV", "报告.tsv"])
    expect(resolvePresentation(path, bytes)).toBe("sheet");
  expect(resolvePresentation("script.txt", bytes)).toBe("text");
  expect(resolvePresentation("book.xlsx", bytes)).toBe("binary");
  expect(resolvePresentation("broken.csv", new Uint8Array([0, 1]).buffer)).toBe(
    "binary",
  );
});

test("表格预览保留中文、带分隔符和换行的单元格，默认预览不提供输入框", () => {
  const content =
    '\uFEFF姓名,公司,备注\r\n张伟,"星河,科技","第一行\n第二行"\r\n';
  const rows = parseDelimitedSpreadsheet("报告.csv", content);
  expect(rows).toEqual([
    ["姓名", "公司", "备注"],
    ["张伟", "星河,科技", "第一行\n第二行"],
  ]);
  expect(
    parseDelimitedSpreadsheet(
      "报告.csv",
      serializeDelimitedSpreadsheet("报告.csv", rows),
    ),
  ).toEqual(rows);
  expect(
    parseDelimitedSpreadsheet("报告.tsv", '姓名\t备注\n张伟\t"含\t制表符"\n'),
  ).toEqual([
    ["姓名", "备注"],
    ["张伟", "含\t制表符"],
  ]);
  const html = renderToStaticMarkup(
    <DelimitedFileView name="报告.csv" content={content} />,
  );
  expect(html).toContain("<table");
  expect(html).toContain("星河,科技");
  expect(html).not.toContain("<input");
});

test("TSV 打开即可编辑单元格，修改进入统一草稿，保存前可被原有文件操作感知", async () => {
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const query = new QueryClient();
  const path = "customer_data.tsv";
  const session = "csv-regression";
  query.setQueryData(["workspace-file", "ws", path], {
    presentation: "sheet",
    text: "姓名\t营收\n张伟\t125000\n",
    bytes: new ArrayBuffer(0),
    contentType: "text/csv",
    updatedAt: 10,
    size: 30,
  });
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(
        <QueryClientProvider client={query}>
          <FileViewer
            client={{} as any}
            workspaceId="ws"
            sessionId={session}
            name={path}
            path={path}
            draft={undefined}
          />
        </QueryClientProvider>,
      );
    });
    expect(view!.root.findAllByType("table")).toHaveLength(1);
    expect(view!.root.findAllByType("input")).toHaveLength(4);
    await act(async () => {
      view!.root
        .findAllByType("input")
        .find((input) => input.props["aria-label"] === "B2")!
        .props.onChange({ target: { value: "130000" } });
    });
    expect(
      useFilesPanelStore.getState().sessions[session]?.drafts[path],
    ).toEqual({ content: "姓名\t营收\n张伟\t130000\n", baseUpdatedAt: 10 });
  } finally {
    await act(async () => view?.unmount());
    useFilesPanelStore.getState().clearSession(session);
    query.clear();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
  }
});

test("Word、CSV、Excel 与 PPT 使用同一个原生 Office 容器，不进入轻量单元格编辑器", () => {
  for (const path of ["客户.csv", "客户.CSV", "报告.docx", "预算.xlsx", "汇报.pptx"]) {
    const element = FileViewer({ client: {} as any, workspaceId: "ws", sessionId: "ses", path, name: path, draft: undefined });
    expect(element.type).toBe(OfficeEditor);
    expect(element.props.path).toBe(path);
  }
});
