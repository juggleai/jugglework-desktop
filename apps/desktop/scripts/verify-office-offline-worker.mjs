import { app, BrowserWindow, session } from "electron";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

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
  const { createOfficeResources } = await import(
    pathToFileURL(join(resources, "app.asar/electron/office-resources.mjs"))
  );
  const resourceService = createOfficeResources({
    assetsDirectory: join(resources, "office-assets"),
    cacheDirectory: join(root, "font-cache"),
  });
  const engine = new OfficeEngine({
    resourceDirectory: join(resources, "office-engine"),
    logDirectory: join(root, "logs"),
  });
  let current;
  let attached;
  process.once("SIGTERM", () => {
    current?.destroy();
    attached?.dispose();
    void engine.dispose().finally(() => app.exit(1));
  });
  const templates = [];
  const reports = [];
  let trapRequests = 0;
  const trap = createServer((_request, response) => {
    trapRequests++;
    response.end("unexpected");
  });
  trap.on("upgrade", (_request, socket) => {
    trapRequests++;
    socket.destroy();
  });
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
    await new Promise((resolve) => trap.listen(0, "127.0.0.1", resolve));
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
      const outgoing = [];
      partition.webRequest.onSendHeaders((details) => {
        if (new URL(details.url).hostname !== "127.0.0.1")
          outgoing.push(details.resourceType);
      });
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
      const preview = new URL(await engine.previewUrl(path));
      let coreFailure = false;
      attached = resourceService.attach(partition, {
        documentId: extension,
        origin: preview.origin,
        filePath: path,
        kind,
        commit: { error: null },
        save: async () => {
          const editor = await engine.editor(path);
          await engine.save(editor.file_id);
          return { engineFileId: editor.file_id };
        },
        onCoreFailure: () => {
          coreFailure = true;
        },
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
      await current.loadURL(preview.href);
      const id = (await eventually(() => engine.editor(path))).file_id;
      let workerResource = null;
      if (kind === "sheet") {
        const uri = await current.webContents.executeJavaScript(
          "window.__globalWorkerURI ?? null",
        );
        assert.equal(typeof uri, "string");
        const workerUrl = new URL(uri, preview.origin);
        assert.equal(workerUrl.origin, preview.origin);
        const response = await partition.fetch(workerUrl.href, {
          redirect: "manual",
        });
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.ok(bytes.length > 0);
        // 此处仅证明页面声明的 Worker 脚本可在本地取得，不把读取脚本冒充 Worker 功能已执行。
        workerResource = {
          path: workerUrl.pathname,
          status: response.status,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }

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
      // TIPS: 另一回环端口在系统沙盒中可达，零接收才能证明是页面白名单拦截，而非公网沙盒兜底。
      const trapUrl = `http://127.0.0.1:${trap.address().port}/network-policy-probe`;
      const blocked = await current.webContents
        .executeJavaScript(`(async () => {
        const url = ${JSON.stringify(trapUrl)};
        const request = await fetch(url, {method: 'POST', body: 'fixture'}).then(() => false, () => true);
        const socket = await new Promise((resolve) => {
          const ws = new WebSocket(url.replace('http:', 'ws:'));
          const timer = setTimeout(() => { ws.close(); resolve(false); }, 3000);
          ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(false); };
          ws.onerror = () => { clearTimeout(timer); resolve(true); };
        });
        return request && socket;
      })()`);
      assert.equal(blocked, true);
      assert.equal(trapRequests, 0);
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
      assert.equal(coreFailure, false);
      assert.deepEqual(outgoing, []);
      // TIPS: 页面销毁会取消预取请求；只保留保存完成前的观察，不能将正常清理误报为资源缺失。
      const observedRequests = requests.slice();
      current.destroy();
      current = undefined;
      attached.dispose();
      attached = undefined;
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
        localRequests: observedRequests.filter((request) => request.local)
          .length,
        localHttpErrors: [
          ...new Set(
            observedRequests
              .filter((request) => request.local && request.status >= 400)
              .map((request) => request.status),
          ),
        ],
        observationWindow: "page-load-through-save",
        localCancelledRequests: observedRequests.filter(
          (request) => request.local && request.error === "net::ERR_ABORTED",
        ).length,
        localResourceFailures: [
          ...new Map(
            observedRequests
              .filter(
                (request) =>
                  request.local &&
                  request.path.startsWith("/static/") &&
                  (request.status >= 400 ||
                    (request.error && request.error !== "net::ERR_ABORTED")),
              )
              .map(({ path, type, status, error }) => [
                JSON.stringify([path, type, status, error]),
                {
                  path,
                  type,
                  ...(status ? { status } : {}),
                  ...(error ? { error } : {}),
                },
              ]),
          ).values(),
        ],
        workerResource,
        remoteAttempts: observedRequests.filter((request) => !request.local)
          .length,
        outgoingRemoteRequests: outgoing.length,
        remoteAttemptTypes: [
          ...new Set(
            observedRequests
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
          localModeResourcePolicy: true,
          crossOriginTransportBlocked: true,
          platform: process.platform + "-" + process.arch,
          publicNetworkDenied: true,
          externalRuntimeCommandsAbsent: true,
          resourcesReadOnly: true,
          chromiumSandboxDisabledForNestedTest: true,
          formats: reports,
          limitations: [
            "Clipboard and feature-specific workers are not exercised",
            "Exact native font layout and export fidelity are not established",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    current?.destroy();
    attached?.dispose();
    trap.close();
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
