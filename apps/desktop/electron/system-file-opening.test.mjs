import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createSystemFileOpening,
  systemOfficeFilePaths,
} from "./system-file-opening.mjs";

test("系统参数保留 Windows 中文空格、多文件和来源目录，忽略开关值及深链接", () => {
  assert.deepEqual(
    systemOfficeFilePaths(
      [
        "C:\\App\\JuggleWork.exe",
        "C:\\资料\\季度 报告.DOCX",
        "收入.csv",
        "预算.xlsx",
        "汇报.pptx",
        "jugglework://connect/demo.docx",
        "--user-data-dir",
        "C:\\profile.docx",
        "old.doc",
        "宏.xlsm",
      ],
      { platform: "win32", cwd: "D:\\项目" },
    ),
    [
      "C:\\资料\\季度 报告.DOCX",
      "D:\\项目\\收入.csv",
      "D:\\项目\\预算.xlsx",
      "D:\\项目\\汇报.pptx",
    ],
  );
  assert.deepEqual(
    systemOfficeFilePaths(["electron", "/repo/main.mjs", "./演示.pptx"], {
      platform: "darwin",
      cwd: "/资料",
      packaged: false,
    }),
    ["/资料/演示.pptx"],
  );
});

test("ready 前的 macOS 事件与第二实例请求排队，单个失败后继续且热打开仍工作", async () => {
  const app = new EventEmitter();
  const calls = [];
  const errors = [];
  const files = createSystemFileOpening({
    app,
    openFile: async (file) => {
      calls.push(file);
      if (file === "bad.docx") throw new Error("bad");
    },
    onError: (file) => errors.push(file),
  });
  let prevented = false;
  app.emit(
    "open-file",
    {
      preventDefault() {
        prevented = true;
      },
    },
    "first.docx",
  );
  files.enqueue(["bad.docx", "second.xlsx"]);
  assert.equal(prevented, true);
  assert.deepEqual(calls, []);
  await files.start();
  assert.deepEqual(calls, ["first.docx", "bad.docx", "second.xlsx"]);
  assert.deepEqual(errors, ["bad.docx"]);
  files.enqueue(["third.csv"]);
  await files.idle();
  assert.equal(calls.at(-1), "third.csv");
});
