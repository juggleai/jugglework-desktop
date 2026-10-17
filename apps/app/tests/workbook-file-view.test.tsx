import * as React from "react";
import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import * as XLSX from "xlsx";
import { mainProcessFetchResponse } from "../../desktop/electron/main-fetch.mjs";
import { WorkbookFileView } from "../src/react-app/domains/session/files/workbook-file-view";

test("Excel 预览切换工作表并显示公式缓存，不提供写回入口", async () => {
  const book = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([["总额", 30]]);
  summary.B1 = { t: "n", f: "SUM(明细!B1:B2)", v: 30 };
  summary.A2 = { t: "n", f: "SUM(明细!B1:B2)" };
  summary["!ref"] = "A1:B2";
  XLSX.utils.book_append_sheet(book, summary, "汇总");
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["甲", 10],
      ["乙", 20],
    ]),
    "明细",
  );
  const bytes = XLSX.write(book, {
    type: "array",
    bookType: "xlsx",
  }) as ArrayBuffer;
  const before = new Uint8Array(bytes).slice();
  const transported = structuredClone(
    await mainProcessFetchResponse(new Response(bytes)),
  );
  const received = await new Response(
    transported.body,
    transported,
  ).arrayBuffer();
  expect(new Uint8Array(received)).toEqual(before);
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(<WorkbookFileView bytes={received} />);
    });
    expect(JSON.stringify(view!.toJSON())).toContain("30");
    expect(JSON.stringify(view!.toJSON())).toContain("=SUM(明细!B1:B2)");
    expect(view!.root.findAllByType("input")).toHaveLength(0);
    await act(async () => {
      view!.root
        .findAllByType("button")
        .find((button) => button.props.children === "明细")!
        .props.onClick();
    });
    expect(JSON.stringify(view!.toJSON())).toContain("乙");
    expect(new Uint8Array(bytes)).toEqual(before);
  } finally {
    await act(async () => view?.unmount());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
  }
});
