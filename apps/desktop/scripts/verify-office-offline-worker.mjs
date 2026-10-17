import { app, BrowserWindow, session } from "electron";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// 此入口只由 verify-office-offline.mjs 在隔离的 Electron 验收宿主中启动。
const { root, resources } = JSON.parse(process.argv.at(-1));
app.setPath("userData", join(root, "profile"));
app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});
async function run() {
  await app.whenReady();
  const { OfficeEngine } = await import(
    pathToFileURL(join(resources, "app.asar/server/dist/office/engine.js"))
  );
  const {
    waitForWordPageCommit,
    waitForSheetPageCommit,
    waitForSlidePageCommit,
  } = await import(
    pathToFileURL(join(resources, "app.asar/electron/office-page-commit.mjs"))
  );
  const engine = new OfficeEngine({
    resourceDirectory: join(resources, "office-engine"),
    logDirectory: join(root, "logs"),
  });
  let current;
  process.once("SIGTERM", () => {
    current?.destroy();
    void engine.dispose().finally(() => app.exit(1));
  });
  const templates = [];
  const reports = [];
  const wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
  /** 等待真实 SDK 或页面就绪，超过期限保留实际失败原因。 */
  async function eventually(action) {
    const deadline = Date.now() + 30_000;
    let last;
    while (Date.now() < deadline) {
      try {
        const value = await action();
        if (value) return value;
      } catch (error) {
        last = error;
      }
      await wait(100);
    }
    throw last ?? new Error("Timed out waiting for native editor");
  }
  try {
    for (const command of ["node", "npm", "npx", "bun"])
      assert.equal(spawnSync(command, ["--version"]).error?.code, "ENOENT");
    await assert.rejects(
      fetch("http://203.0.113.1", { signal: AbortSignal.timeout(3000) }),
      (error) => /EPERM|EACCES/.test(String(error.cause?.code)),
    );
    await assert.rejects(
      async () => {
        const probe = join(resources, "office-engine", "offline-write-probe");
        await writeFile(probe, "", { flag: "wx" });
        // 限制若失效，移除本次独占创建的探针后再报告断言失败。
        await rm(probe);
      },
      (error) => /EPERM|EACCES/.test(error.code),
    );
    assert.equal((await engine.capabilities()).available, true);
    for (const [extension, kind] of [
      ["docx", "doc"],
      ["csv", "sheet"],
      ["xlsx", "sheet"],
      ["pptx", "slide"],
    ]) {
      const path = join(root, "离线样例." + extension);
      if (extension === "csv") await writeFile(path, "姓名,数值\n离线,10\n");
      else {
        const created = await engine.tool("create_" + kind, {});
        templates.push(String(created.file_path));
        const id = String(created.file_id);
        await eventually(async () => {
          const info = await engine.tool(
            kind === "sheet"
              ? "sheet_get_sheet_info"
              : kind === "slide"
                ? "slide_get_info"
                : "doc_get_last_operable_pos",
            { file_id: id },
          );
          return kind !== "slide" || info.is_open === true;
        });
        if (kind === "doc")
          await engine.tool("doc_insert_text", {
            file_id: id,
            idx: 0,
            text: "离线正文",
          });
        if (kind === "slide")
          await engine.tool("slide_add_text", {
            file_id: id,
            page_index: 0,
            x: 30,
            y: 30,
            w: 300,
            h: 80,
            text: "离线标题",
          });
        await engine.tool("save_file", { file_id: id, file_path: path });
        await engine.close(id, true);
      }
      const requests = [];
      const partition = session.fromPartition("offline-" + extension);
      partition.webRequest.onCompleted((details) => {
        const url = new URL(details.url);
        if (url.protocol === "http:" || url.protocol === "https:")
          requests.push({
            local: url.hostname === "127.0.0.1",
            path: url.pathname,
            status: details.statusCode,
            type: details.resourceType,
          });
      });
      partition.webRequest.onErrorOccurred((details) => {
        const url = new URL(details.url);
        if (url.protocol === "http:" || url.protocol === "https:")
          requests.push({
            local: url.hostname === "127.0.0.1",
            path: url.pathname,
            error: details.error,
            type: details.resourceType,
          });
      });
      current = new BrowserWindow({
        show: false,
        width: 1200,
        height: 850,
        webPreferences: {
          session: partition,
          sandbox: true,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
      await current.loadURL(await engine.previewUrl(path));
      const id = (await eventually(() => engine.editor(path))).file_id;
      const page = await eventually(async () => {
        const result = await current.webContents.executeJavaScript(
          '({canvas:document.querySelectorAll("canvas").length, buttons:document.querySelectorAll("button,[role=button]").length,text:document.body.innerText.length, fonts:[...document.fonts].reduce((a,f)=>(a[f.status]=(a[f.status]??0)+1,a),{})})',
        );
        return result.canvas > 0 && result.text > 20 && result;
      });
      const prepare =
        kind === "doc"
          ? waitForWordPageCommit
          : kind === "sheet"
            ? waitForSheetPageCommit
            : waitForSlidePageCommit;
      // TIPS：DOM 出现不等于可编辑；沿用产品保存前的原生页面提交契约检查。
      await eventually(async () => {
        await current.webContents.executeJavaScript(
          `(${prepare.toString()})(window, 1000)`,
        );
        return true;
      });
      if (kind === "sheet") {
        const info = await engine.tool("sheet_get_sheet_info", { file_id: id });
        await engine.tool("sheet_set_cell_value", {
          file_id: id,
          sheet_id: info.sheets[0].sheet_id,
          cell: {
            row: 0,
            col: 0,
            value_type: "STRING",
            string_value: "离线保存",
          },
        });
      } else if (kind === "doc")
        await engine.tool("doc_insert_text", {
          file_id: id,
          idx: 0,
          text: "离线保存",
        });
      else
        await engine.tool("slide_add_text", {
          file_id: id,
          page_index: 0,
          x: 30,
          y: 140,
          w: 300,
          h: 80,
          text: "离线保存",
        });
      await engine.save(id);
      current.destroy();
      current = undefined;
      await engine.close(id);
      await engine.tool("open_file", { file_path: path, wait: true });
      const reopened = (await engine.editor(path)).file_id;
      const result = await engine.tool(
        kind === "doc"
          ? "doc_find"
          : kind === "sheet"
            ? "sheet_get_cell_data"
            : "slide_get_page_info",
        kind === "sheet"
          ? {
              file_id: reopened,
              sheet_id: (
                await engine.tool("sheet_get_sheet_info", { file_id: reopened })
              ).sheets[0].sheet_id,
              start_row: 0,
              start_col: 0,
              end_row: 0,
              end_col: 0,
              return_csv: true,
            }
          : { file_id: reopened, page_index: 0, text: "离线保存" },
      );
      assert.ok(
        kind === "doc"
          ? result.total > 0
          : JSON.stringify(result).includes("离线保存"),
      );
      await engine.close(reopened);
      reports.push({
        extension,
        page,
        bytes: (await readFile(path)).length,
        localRequests: requests.filter((request) => request.local).length,
        localHttpErrors: [
          ...new Set(
            requests
              .filter((request) => request.local && request.status >= 400)
              .map((request) => request.status),
          ),
        ],
        remoteRequests: requests.filter((request) => !request.local).length,
        remoteResourceTypes: [
          ...new Set(
            requests
              .filter((request) => !request.local)
              .map((request) => request.type),
          ),
        ],
        nativePageCommitReady: true,
        savedContentReopened: true,
      });
      console.log("OFFLINE_FORMAT_OK " + extension);
    }
    await writeFile(
      join(root, "offline-result.json"),
      JSON.stringify(
        {
          ok: true,
          scope: "basic-native-pages-and-content-tools",
          platform: process.platform + "-" + process.arch,
          publicNetworkDenied: true,
          externalRuntimeCommandsAbsent: true,
          resourcesReadOnly: true,
          chromiumSandboxDisabledForNestedTest: true,
          formats: reports,
          limitations: [
            "Clipboard and feature-specific workers are not exercised",
            "Remote fonts and optional online resources are not guaranteed offline",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    current?.destroy();
    await engine.dispose();
    for (const path of templates) await rm(path, { force: true });
  }
}
void run().then(
  () => app.quit(),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
