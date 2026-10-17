import { describe, expect, it } from "bun:test";

import {
  parseSpreadsheet,
  serializeSpreadsheet,
} from "../src/react-app/domains/session/artifacts/artifact-spreadsheet-model";

describe("artifact spreadsheet model", () => {
  it("round-trips CSV edits", async () => {
    const rows = await parseSpreadsheet({ name: "artifact-eval.csv", content: { kind: "text", data: "name,revenue\nAda,10\n" } });
    rows[1]![1] = "11";
    const output = await serializeSpreadsheet("artifact-eval.csv", rows);
    expect(output).toEqual({ kind: "text", data: "name,revenue\nAda,11\n" });
  });

  it("拒绝使用二维字符串重建二进制工作簿，避免单表写回丢失内容", async () => {
    for (const name of ["book.xlsx", "book.xls", "book.ods"])
      await expect(serializeSpreadsheet(name, [["name", "revenue"], ["Ada", "10"]])).rejects.toThrow("Office 原生编辑器");
  });
});
