import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createSystemFileOpening,
  systemOfficeFilePaths,
  secondInstanceOfficeFilePaths,
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

test("Windows 无值或未知开关不吞掉随后文档，有值选项仍不误开配置目录", () => {
  const files = ["C:\\资料\\季度 报告.DOCX", "D:\\表格.xlsx", "D:\\收入.csv", "D:\\汇报.pptx"];
  for (const flag of ["--allow-file-access-from-files", "--hidden", "--unknown-boolean", "--disable-gpu", "--inspect"]) {
    assert.deepEqual(systemOfficeFilePaths(["app.exe", flag, ...files], { platform: "win32" }), files);
  }
  assert.deepEqual(systemOfficeFilePaths([
    "app.exe", "--user-data-dir", "C:\\profile.docx", "--log-file=C:\\log.xlsx",
    "--disable-gpu", files[0], "--", "-收入.csv",
  ], { platform: "win32", cwd: "D:\\项目" }), [files[0], "D:\\项目\\-收入.csv"]);
});

test("有值参数的 Office 后缀配置值不进入冷启动或 additionalData 文件队列", async () => {
  const options = { platform: "win32", cwd: "D:\\项目" };
  const flags = [
    "--log-net-log", "--crash-dumps-dir", "--diagnostic-dir", "--user-agent",
    "--host-rules", "--host-resolver-rules", "--proxy-pac-url", "--lang",
    "--disk-cache-size", "--log-level", "--v", "--vmodule",
    "--auth-server-whitelist", "--auth-negotiate-delegate-whitelist",
    "--ignore-connections-limit", "--force-fieldtrials",
  ];
  const expected = ["D:\\项目\\季度 报告.docx", "D:\\项目\\-收入.csv"];
  for (const flag of flags) {
    for (const inline of [false, true]) {
      // 即使配置值不是合法配置内容，扩展名也不能将它变成文件打开请求。
      const value = "C:\\配置\\诊断.csv";
      const argv = ["app.exe", ...(inline ? [`${flag}=${value}`] : [flag, value]),
        "--disable-gpu", "季度 报告.docx", "--", "-收入.csv"];
      const files = systemOfficeFilePaths(argv, options);
      assert.deepEqual(files, expected, `${flag}, inline=${inline}`);
      const payload = JSON.parse(JSON.stringify({ systemFileOpening: { version: 1, files } }));
      // 模拟 Electron 重排、丢失文件后的 argv，接收方只能采用原始已解析列表。
      const received = secondInstanceOfficeFilePaths(["app.exe", value], payload, options);
      const calls = [];
      const opening = createSystemFileOpening({ app: new EventEmitter(),
        openFile: file => calls.push(file), onError: (_file, error) => { throw error; },
      });
      opening.enqueue(received);
      await opening.start();
      await opening.idle();
      assert.deepEqual(calls, expected);
      assert.deepEqual(secondInstanceOfficeFilePaths(argv, undefined, options), expected);
      const emptyFiles = systemOfficeFilePaths(["app.exe", flag, value], options);
      assert.deepEqual(emptyFiles, []);
      assert.deepEqual(secondInstanceOfficeFilePaths(["app.exe", value], {
        systemFileOpening: { version: 1, files: emptyFiles },
      }, options), []);
    }
  }
});

test("第二实例优先原始文件列表，argv 重排不影响打开；空列表有效，旧实例可回退", () => {
  const options = { platform: "win32", cwd: "D:\\项目" };
  const argv = ["app.exe", "--user-data-dir", "C:\\原文件.docx", "other.xlsx"];
  const payload = { systemFileOpening: { version: 1, files: ["C:\\资料\\原文件.docx", "C:\\资料\\原文件.docx"] } };
  assert.deepEqual(secondInstanceOfficeFilePaths(argv, payload, options), ["C:\\资料\\原文件.docx"]);
  assert.deepEqual(secondInstanceOfficeFilePaths(argv, { systemFileOpening: { version: 1, files: [] } }, options), []);
  for (const data of [undefined, {}, { systemFileOpening: { version: 2, files: [] } },
    { systemFileOpening: { version: 1, files: ["relative.docx"] } },
    { systemFileOpening: { version: 1, files: [42] } },
    { systemFileOpening: { version: 1, files: ["https://example.test/a.docx"] } }]) {
    assert.deepEqual(secondInstanceOfficeFilePaths(argv, data, options), ["D:\\项目\\other.xlsx"]);
  }
});

test("Main 将同一冷启动文件列表通过单实例锁传递并在第二实例入口使用", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.ok(main.includes("systemFiles.enqueue(startupOfficeFiles)"));
  assert.ok(main.includes("requestSingleInstanceLock({ systemFileOpening: { version: 1, files: startupOfficeFiles } })"));
  assert.ok(main.includes('app.on("second-instance", async (_event, argv, workingDirectory, additionalData)'));
  assert.ok(main.includes("secondInstanceOfficeFilePaths(argv, additionalData, {"));
});

test("空冷启动后可连续热打开，失败文件不阻塞后续请求", async () => {
  const app = new EventEmitter();
  const calls = [], errors = [];
  const opening = createSystemFileOpening({ app,
    openFile: file => { calls.push(file); if (file === "bad.docx") throw new Error("bad"); },
    onError: file => errors.push(file),
  });
  await opening.start();
  const options = { platform: "win32", cwd: "D:\\资料" };
  opening.enqueue(secondInstanceOfficeFilePaths(["app.exe", "--disable-gpu", "报告.docx"], undefined, options));
  await opening.idle();
  opening.enqueue(["bad.docx", "other.xlsx"]);
  await opening.idle();
  assert.deepEqual(calls, ["D:\\资料\\报告.docx", "bad.docx", "other.xlsx"]);
  assert.deepEqual(errors, ["bad.docx"]);
  assert.equal(opening.processing(), false);
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
