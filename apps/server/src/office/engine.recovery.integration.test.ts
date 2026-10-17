import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficeDocuments } from "./documents.js";
import { OfficeEngine } from "./engine.js";

const nativeTest =
  process.env.JUGGLEWORK_TEST_OFFICE_NATIVE === "1" ? test : test.skip;

for (const failure of ["engine", "page"] as const)
  nativeTest(
    `真实 SDK ${failure === "engine" ? "意外退出" : "页面故障上报"}后只恢复最后保存版本，文档标签身份保持且内容工具可继续使用`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "jugglework-native-recovery-"));
      const path = join(root, "恢复.csv");
      const exited = Promise.withResolvers<void>();
      let documents: OfficeDocuments;
      const engine = new OfficeEngine({
        logDirectory: join(root, "logs"),
        onExit: () => {
          documents.invalidate();
          exited.resolve();
        },
      });
      documents = new OfficeDocuments({
        engine,
        resolveFile: async () => ({
          absolutePath: path,
          file: {
            artifactId: "af_recovery",
            workspaceId: "ws",
            relativePath: "恢复.csv",
            name: "恢复.csv",
            kind: "spreadsheet",
            mimeType: "text/csv",
            sizeBytes: (await stat(path)).size,
            exists: true,
            updatedAt: 1,
            editingOwner: "internal",
          },
        }),
        onSaved: async () => {},
        onModified: async () => {},
        isBusy: () => false,
      });
      try {
        await writeFile(path, "姓名,营收\n客户,10\n");
        const opened = await documents.open("ws", "ses", "恢复.csv");
        await engine.tool("open_file", { file_path: path, wait: true });
        const ready = await documents.get("ws", opened.documentId);
        expect(ready.state).toBe("ready");
        const info = await engine.tool("sheet_get_sheet_info", {
          file_id: ready.engineFileId,
        });
        const sheetId = (info.sheets as Array<{ sheet_id: string }>)[0]!
          .sheet_id;
        await engine.tool("sheet_set_cell_value", {
          file_id: ready.engineFileId,
          sheet_id: sheetId,
          cell: { row: 1, col: 1, value_type: "NUMBER", number_value: 99 },
        });
        expect((await documents.get("ws", opened.documentId)).dirty).toBe(true);
        if (failure === "page") {
          documents.failPage("ws", opened.documentId);
          // TIPS: 页面故障时原生进程及残留模型仍存活；恢复必须释放旧模型再从磁盘导入。
          expect((await engine.editor(path))?.file_id).toBe(ready.engineFileId);
        } else {
          // TIPS: 仅终止当前测试实例持有的 ChildProcess；依赖已固定 SDK 的进程句柄，不按端口或全局 PID 查杀。
          const processHandle = (
            engine as unknown as {
              native: { proc: ChildProcess & { forceStop: () => void } };
            }
          ).native.proc;
          const manifest = JSON.parse(
            await readFile(
              join(engine.resourceDirectory, "version.json"),
              "utf8",
            ),
          );
          expect(processHandle.spawnfile).toBe(
            join(engine.resourceDirectory, manifest.binary),
          );
          expect(processHandle.exitCode).toBeNull();
          processHandle.forceStop();
          await Promise.race([
            exited.promise,
            new Promise<never>((_, reject) => {
              const timer = setTimeout(
                () => reject(new Error("未收到 SDK 意外退出事件")),
                5000,
              );
              timer.unref();
              void exited.promise.then(() => clearTimeout(timer));
            }),
          ]);
        }
        expect(await documents.get("ws", opened.documentId)).toMatchObject({
          state: "error",
          engineFileId: null,
          previewUrl: null,
          dirty: true,
        });
        await expect(
          documents.beforeTool("ws", "ses", "sheet_set_cell_value", {}),
        ).rejects.toThrow("就绪");
        expect(await readFile(path, "utf8")).toContain("客户,10");
        const recovering = await documents.recover("ws", opened.documentId);
        expect(recovering).toMatchObject({
          documentId: opened.documentId,
          state: "opening",
          dirty: false,
        });
        await engine.tool("open_file", { file_path: path, wait: true });
        const current = await documents.get("ws", opened.documentId);
        expect(current.state).toBe("ready");
        const args = await documents.beforeTool(
          "ws",
          "ses",
          "sheet_get_sheet_info",
          {},
        );
        const actual = await engine.tool("sheet_get_sheet_info", args);
        const actualSheet = (actual.sheets as Array<{ sheet_id: string }>)[0]!
          .sheet_id;
        const cells = await engine.tool("sheet_get_cell_data", {
          file_id: current.engineFileId,
          sheet_id: actualSheet,
          start_row: 1,
          start_col: 1,
          end_row: 1,
          end_col: 1,
          return_csv: true,
        });
        expect(cells.csv_data).toBe("10");
      } finally {
        await documents.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
