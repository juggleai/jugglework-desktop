import { afterEach, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
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
  const files = new LocalOfficeFiles({ root: join(root, "FileAssistant") });
  const key = await files.register(original);
  expect(await files.register(alias)).toBe(key);
  expect((await files.resolve(key)).absolutePath).toBe(
    await realpath(original),
  );
  await files.bindSession(key, "ses-file");
  const reopened = new LocalOfficeFiles({ root: join(root, "FileAssistant") });
  expect(await reopened.register(alias)).toBe(key);
  expect(await reopened.sessionFor(key)).toBe("ses-file");
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

test("外部文件使用默认工作区真实会话，登记恢复且只读原文件；网络失败不创建替代会话", async () => {
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
  let sessionsCreated = 0, sessionFailure = 0, restoredSession: Record<string, unknown> | undefined;
  const upstream = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/session" && request.method === "POST") return Response.json({ id: `ses_file_${++sessionsCreated}`, title: "文件对话" });
    if (/^\/session\/[^/]+$/.test(url.pathname)) return sessionFailure ? Response.json({ name: "Unavailable", data: { message: "unavailable" } }, { status: sessionFailure })
      : Response.json(restoredSession ?? { id: url.pathname.split("/").at(-1), title: "文件对话" });
    if (url.pathname === "/session") return Response.json([{ id: "ses_file_1", title: "文件对话", time: { created: 1, updated: 1 } }]);
    return Response.json({});
  } });
  cleanups.push(async () => { await upstream.stop(true); });
  config.opencodeBaseUrl = upstream.url.href;
  const defaultRoot = join(root, "FileAssistant");
  const server = await startServer(config, { fileAssistantRoot: defaultRoot });
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
  const resolveOriginal = (workspaceRoot: string, path = context.path) => fetch(`${base}/office/local-files/resolve`, {
    method: "POST", headers, body: JSON.stringify({ workspaceRoot, path }),
  });
  expect(await (await resolveOriginal(defaultRoot)).json()).toEqual({ absolutePath: await realpath(original) });
  expect(await (await resolveOriginal(workspace)).json()).toEqual({ absolutePath: null });
  expect((await resolveOriginal(defaultRoot, "external-files/unknown/预算.xlsx")).status).toBe(404);
  expect((await resolveOriginal(defaultRoot, original)).status).toBe(404);
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
  ).toBe(409);
  expect((await fetch(`${prefix}/sessions`, { headers })).status).toBe(200);
  expect(context.sessionId).toBe("ses_file_1");
  expect(config.workspaces.map((item) => item.path)).toEqual([workspace, defaultRoot]);
  expect(config.authorizedRoots).toEqual([workspace, defaultRoot]);
  expect(await (await register({ "X-JuggleWork-Host-Token": "host" })).json()).toMatchObject(context);
  expect(sessionsCreated).toBe(1);
  for (const invalid of [{}, { id: "ses_unrelated" }]) {
    restoredSession = invalid;
    expect((await register({ "X-JuggleWork-Host-Token": "host" })).status).toBe(503);
    expect(sessionsCreated).toBe(1);
  }
  restoredSession = undefined;
  sessionFailure = 503;
  expect((await register({ "X-JuggleWork-Host-Token": "host" })).status).toBe(502);
  expect(sessionsCreated).toBe(1);
  sessionFailure = 404;
  expect((await (await register({ "X-JuggleWork-Host-Token": "host" })).json()).sessionId).toBe("ses_file_2");
  expect(await readFile(original, "utf8")).toBe("external workbook");
}, 20000);

const nativeTest =
  process.env.JUGGLEWORK_TEST_OFFICE_NATIVE === "1" ? test : test.skip;
nativeTest("默认工作区 HTTP 全链路使用真实 CSV 模型修改和保存原文件，重启恢复同一聊天", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-assistant-http-native-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const original = join(root, "外部数据.csv"), assistantRoot = join(root, "FileAssistant");
  await writeFile(original, "姓名,金额\n客户,10\n");
  let creates = 0, turnId = "";
  const requests: string[] = [];
  const upstream = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path === "/session" && request.method === "POST") { creates++; return Response.json({ id: "ses_external", title: "文件对话" }); }
    if (path === "/session/ses_external/prompt_async") {
      const body = await request.json() as { messageID: string };
      turnId = body.messageID;
      return new Response(null, { status: 204 });
    }
    if (path === "/api/session/ses_external/prompt") {
      const body = await request.json() as { id: string; prompt: unknown; delivery: unknown };
      turnId = body.id;
      return Response.json({ data: { id: body.id, sessionID: "ses_external", prompt: body.prompt, delivery: body.delivery, admittedSeq: 1, timeCreated: Date.now() } });
    }
    if (path.endsWith("/message")) return Response.json(turnId ? [
      { info: { id: turnId, sessionID: "ses_external", role: "user", time: { created: Date.now() } }, parts: [] },
      { info: { id: "msg_assistant", sessionID: "ses_external", parentID: turnId, role: "assistant", time: { created: Date.now() } }, parts: [] },
    ] : []);
    if (path === "/session/ses_external") return Response.json({ id: "ses_external", title: "文件对话" });
    return Response.json({});
  } });
  cleanups.push(async () => { await upstream.stop(true); });
  const config: ServerConfig = { host: "127.0.0.1", port: 0, configPath: join(root, "server.json"), token: "client", hostToken: "host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false, opencodeBaseUrl: upstream.url.href };
  let server = await startServer(config, { fileAssistantRoot: assistantRoot });
  cleanups.push(async () => { await server.stop(); });
  const headers = { authorization: "Bearer client", "Content-Type": "application/json" };
  const post = async (path: string, body: unknown, host = false) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { ...headers, ...(host ? { "X-JuggleWork-Host-Token": "host" } : {}) }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result as any;
  };
  const context = await post("/office/local-files/open", { path: original }, true);
  const prefix = `/workspace/${context.workspaceId}/office`;
  const opened = (await post(`${prefix}/open`, { sessionId: context.sessionId, path: context.path })).document;
  let session: string | null = null, requestId = 0;
  const nativeRpc = async (method: string, params: unknown) => {
    const response = await fetch(`${new URL(opened.previewUrl).origin}/mcp`, { method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }) });
    expect(response.ok).toBe(true);
    session = response.headers.get("mcp-session-id") ?? session;
    const raw = await response.text();
    const envelope = JSON.parse(raw.trim().startsWith("{") ? raw : raw.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
    expect(envelope.error).toBeUndefined();
    return envelope.result;
  };
  await nativeRpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "external-file-test", version: "1" } });
  expect((await nativeRpc("tools/call", { name: "open_file", arguments: { file_path: await realpath(original), wait: true } })).isError).not.toBe(true);
  const ready = await (await fetch(`http://127.0.0.1:${server.port}${prefix}/${opened.documentId}`, { headers })).json() as any;
  expect(ready.document.state).toBe("ready");
  const started = await post(`/workspace/${context.workspaceId}/sessions/${context.sessionId}/runs/start`, { origin: "local-renderer", startCommandCorrelationId: "external-file-native",
    prompt: { parts: [{ type: "text", text: "修改已打开的原文件" }] } });
  for (let attempt = 0; !turnId && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  if (!turnId) throw new Error(JSON.stringify({ started, requests }));
  expect(turnId).toStartWith("msg_");
  // TIPS: 同一文件窗口切换到另一张表后，已 admission 的请求仍只能修改发送时的原文件。
  const other = join(root, "另一份数据.csv");
  await writeFile(other, "姓名,金额\n另一客户,90\n");
  const otherContext = await post("/office/local-files/open", { path: other }, true);
  expect(otherContext.sessionId).toBe(context.sessionId);
  const otherDocument = (await post(`${prefix}/open`, { sessionId: context.sessionId, path: otherContext.path })).document;
  expect((await nativeRpc("tools/call", { name: "open_file", arguments: { file_path: await realpath(other), wait: true } })).isError).not.toBe(true);
  expect((await (await fetch(`http://127.0.0.1:${server.port}${prefix}/${otherDocument.documentId}`, { headers })).json() as any).document.state).toBe("ready");
  const actorContext = await (await fetch(`http://127.0.0.1:${server.port}${prefix}/current?sessionId=${context.sessionId}&messageId=msg_assistant`, { headers })).json() as any;
  expect(actorContext.document.documentId).toBe(opened.documentId);
  const call = async (name: string, args: unknown) => post(`${prefix}/call`, { sessionId: context.sessionId, messageId: "msg_assistant", name, args });
  const info = await call("sheet_get_sheet_info", {});
  const sheetId = info.output.sheets[0].sheet_id;
  await call("sheet_set_cell_value", { sheet_id: sheetId, cell: { row: 1, col: 1, value_type: "NUMBER", number_value: 25 } });
  const reused = await post("/office/local-files/open", { path: original }, true);
  expect(reused).toMatchObject(context);
  const second = (await post(`${prefix}/open`, { sessionId: context.sessionId, path: context.path })).document;
  expect(second.documentId).toBe(opened.documentId);
  expect(second.engineFileId).toBeTruthy();
  await post(`${prefix}/save-for-actor`, { sessionId: context.sessionId, messageId: "msg_assistant" });
  expect(await readFile(original, "utf8")).toContain("客户,25");
  expect(await readFile(other, "utf8")).toBe("姓名,金额\n另一客户,90\n");
  const delivery = await post(`/workspace/${context.workspaceId}/sessions/${context.sessionId}/file-deliveries/register`, { messageId: "msg_assistant", outputs: [context.path] });
  expect(delivery.files).toContainEqual(expect.objectContaining({ artifactId: opened.artifactId, relativePath: context.path, exists: true, sizeBytes: (await stat(original)).size }));
  expect(delivery.turns[0].items).toContainEqual(expect.objectContaining({ artifactId: opened.artifactId }));
  await expect(access(join(assistantRoot, context.path))).rejects.toMatchObject({ code: "ENOENT" });
  const raw = await fetch(`http://127.0.0.1:${server.port}/workspace/${context.workspaceId}/files/raw?path=${encodeURIComponent(context.path)}`, { headers });
  expect(await raw.text()).toContain("客户,25");
  await server.stop();
  server = await startServer(config, { fileAssistantRoot: assistantRoot });
  expect(await post("/office/local-files/open", { path: original }, true)).toMatchObject(context);
  expect(creates).toBe(1);
}, 60_000);

nativeTest(
  "真实 SDK 在本机文件上下文编辑 CSV，取消关闭保留模型，保存写回所选原路径",
  async () => {
    const { OfficeEngine } = await import("./engine.js");
    const { OfficeDocuments } = await import("./documents.js");
    const root = await mkdtemp(join(tmpdir(), "local-office-native-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "外部 客户.csv");
    await writeFile(path, "姓名,金额\n客户,10\n");
    const files = new LocalOfficeFiles({ root: join(root, "FileAssistant") });
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
    const opened = await documents.open(files.id, "ses-file", key);
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
