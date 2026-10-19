import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalOfficeFiles } from "./local-files.js";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("所选文件以独立标识解析，符号链接复用登记，父目录和未登记路径不可读", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-office-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const original = join(root, "季度 报告.docx");
  const alias = join(root, "引用.docx");
  await writeFile(original, "original");
  await symlink(original, alias);
  const files = new LocalOfficeFiles();
  const key = await files.register(original);
  expect(await files.register(alias)).toBe(key);
  expect((await files.resolve(key)).absolutePath).toBe(
    await realpath(original),
  );
  await expect(files.resolve(original)).rejects.toMatchObject({
    code: "file_not_found",
  });
  await expect(files.resolve(`${key}/../秘密.docx`)).rejects.toMatchObject({
    code: "file_not_found",
  });
  await expect(files.register(join(root, "未知.doc"))).rejects.toMatchObject({
    code: "office_format_unavailable",
  });
  await rm(original);
  await expect(files.resolve(key)).rejects.toMatchObject({
    code: "file_not_found",
  });
  await expect(files.register(original)).rejects.toMatchObject({
    code: "file_not_found",
  });
});

test("HTTP 仅宿主可登记外部文件，编辑器可读取明确文件且工作区、聊天及父目录不扩权", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-office-http-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const original = join(root, "预算 表.xlsx");
  await writeFile(original, "external workbook");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: "client",
    hostToken: "host",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws",
        name: "Workspace",
        path: workspace,
        preset: "starter",
        workspaceType: "local",
      },
    ],
    authorizedRoots: [workspace],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  cleanups.push(async () => {
    await server.stop();
  });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = {
    authorization: "Bearer client",
    "content-type": "application/json",
  };
  const register = (extra = {}) =>
    fetch(`${base}/office/local-files/open`, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify({ path: original }),
    });
  expect((await register()).status).toBe(401);
  const response = await register({ "X-JuggleWork-Host-Token": "host" });
  expect(response.status).toBe(200);
  const context = (await response.json()) as {
    workspaceId: string;
    sessionId: string;
    path: string;
    local: boolean;
  };
  expect(context.local).toBe(true);
  const prefix = `${base}/workspace/${context.workspaceId}`;
  const raw = await fetch(
    `${prefix}/files/raw?path=${encodeURIComponent(context.path)}`,
    { headers },
  );
  expect(await raw.text()).toBe("external workbook");
  expect(
    (
      await fetch(`${prefix}/files/raw?path=${encodeURIComponent(original)}`, {
        headers,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await fetch(`${prefix}/files/raw`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: context.path, dataBase64: "" }),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await fetch(`${prefix}/office/tools?sessionId=${context.sessionId}`, {
        headers,
      })
    ).status,
  ).toBe(400);
  expect((await fetch(`${prefix}/sessions`, { headers })).status).toBe(404);
  expect(config.workspaces.map((item) => item.path)).toEqual([workspace]);
  expect(config.authorizedRoots).toEqual([workspace]);
  expect(await readFile(original, "utf8")).toBe("external workbook");
}, 20000);

const nativeTest =
  process.env.JUGGLEWORK_TEST_OFFICE_NATIVE === "1" ? test : test.skip;
nativeTest(
  "真实 SDK 在本机文件上下文编辑 CSV，取消关闭保留模型，保存写回所选原路径",
  async () => {
    const { OfficeEngine } = await import("./engine.js");
    const { OfficeDocuments } = await import("./documents.js");
    const root = await mkdtemp(join(tmpdir(), "local-office-native-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "外部 客户.csv");
    await writeFile(path, "姓名,金额\n客户,10\n");
    const files = new LocalOfficeFiles();
    const key = await files.register(path);
    const engine = new OfficeEngine({ logDirectory: join(root, "logs") });
    const documents = new OfficeDocuments({
      engine,
      resolveFile: (_id, key) => files.resolve(key),
      onSaved: async () => {},
      onModified: async () => {},
      isBusy: () => false,
      onOwnership: async (_id, key, owner) => files.setOwner(key, owner),
    });
    cleanups.push(() => documents.dispose());
    const opened = await documents.open(files.id, files.sessionId, key);
    const resolved = await files.resolve(key);
    await engine.tool("open_file", {
      file_path: resolved.absolutePath,
      wait: true,
    });
    const ready = await documents.get(files.id, opened.documentId);
    expect(ready.state).toBe("ready");
    const info = await engine.tool("sheet_get_sheet_info", {
      file_id: ready.engineFileId,
    });
    const sheet = (info.sheets as Array<{ sheet_id: string }>)[0]!.sheet_id;
    await engine.tool("sheet_set_cell_value", {
      file_id: ready.engineFileId,
      sheet_id: sheet,
      cell: { row: 1, col: 1, value_type: "NUMBER", number_value: 25 },
    });
    const cancelled = await documents.close(
      files.id,
      ready.documentId,
      "cancel",
    );
    expect(cancelled.state).toBe("ready");
    expect((await documents.get(files.id, ready.documentId)).dirty).toBe(true);
    await documents.save(files.id, ready.documentId, true);
    expect(await readFile(path, "utf8")).toContain("客户,25");
    expect((await documents.findByAbsolutePath(path))?.documentId).toBe(
      ready.documentId,
    );
    await documents.close(files.id, ready.documentId, "save");
  },
  60000,
);
