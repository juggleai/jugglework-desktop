import assert from "node:assert/strict";
import { test } from "node:test";
import { FILE_WINDOW_EXTENSIONS, isSupportedFileWindowPath, isSupportedWorkspaceTextFilePath } from "../dist/file-window.js";
import { getOfficeDocumentKind } from "../dist/office.js";

test("独立窗口只接受已有文本、Office 和预览格式，Office 边界保持独立", () => {
  for (const extension of FILE_WINDOW_EXTENSIONS) assert.equal(isSupportedFileWindowPath(`/目录/报告.${extension.toUpperCase()}`), true);
  for (const path of ["a.md", "a.mdx", "a.tsv", "a.ts", "a.jsonc"]) {
    assert.equal(isSupportedWorkspaceTextFilePath(path), true);
    assert.equal(getOfficeDocumentKind(path), null);
  }
  for (const path of ["a.pdf", "a.png", "a.mp4", "a.xls", "a.ods"]) {
    assert.equal(isSupportedFileWindowPath(path), true);
    assert.equal(isSupportedWorkspaceTextFilePath(path), false);
  }
  for (const path of ["a.exe", "a.zip", "a.bin", "a.doc", "a.ppt", "a.md.exe", "a.md/child", "LICENSE"])
    assert.equal(isSupportedFileWindowPath(path), false);
  assert.equal(getOfficeDocumentKind("a.csv"), "sheet");
});
