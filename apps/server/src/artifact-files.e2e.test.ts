import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import { JuggleWorkExtensionsPreview } from "./opencode-plugins/jugglework-extensions-preview.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "jugglework-artifacts-"));
  roots.push(root);
  await mkdir(join(root, "reports"), { recursive: true });
  await writeFile(join(root, "reports", "artifact-eval.md"), "# Artifact Eval\n\nHello markdown.\n", "utf8");
  await writeFile(join(root, "reports", "artifact-eval.csv"), "name,revenue\nAda,10\nGrace,20\n", "utf8");
  await writeFile(join(root, "reports", "index.html"), "<!doctype html><h1>Artifact site</h1>", "utf8");
  await writeFile(join(root, "reports", "artifact-eval.xlsx"), new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4]));
  await writeFile(join(root, "reports", "artifact-eval.pptx"), new Uint8Array([80, 75, 3, 4, 5, 6, 7, 8]));
  await writeFile(join(root, "reports", "artifact-eval.docx"), new Uint8Array([80, 75, 3, 4, 9, 10, 11, 12]));
  return root;
}

async function startJuggleWorkServer(workspaceRoot: string, engineUrl?: string) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local", ...(engineUrl ? { baseUrl: engineUrl } : {}) }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, token: config.token };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

(process.env.JUGGLEWORK_TEST_OFFICE_NATIVE === "1" ? test : test.skip)("Office 实际活动阻止关闭与恢复，存活模型阻止改名覆盖及删除，故障状态可恢复", async () => {
  const root = await createWorkspaceRoot();
  let status: unknown = { ses_transfer: { type: "busy" } };
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/session/status") return Response.json(status);
    return Response.json({});
  } });
  stops.push(() => engine.stop(true));
  const { base, token } = await startJuggleWorkServer(root, `http://127.0.0.1:${engine.port}`);
  const open = await fetch(`${base}/workspace/ws_1/office/open`, { method: "POST", headers: auth(token), body: JSON.stringify({ sessionId: "ses_transfer", path: "reports/artifact-eval.csv" }) });
  expect(open.status).toBe(200);
  const { document } = await open.json() as { document: { documentId: string; pageId: string; state: string } };
  expect(document.state).toBe("opening");
  const url = `${base}/workspace/ws_1/office/${document.documentId}/transfer-status`;
  expect(await (await fetch(url, { headers: auth(token) })).json()).toMatchObject({ documentId: document.documentId, reason: "running" });
  const documentUrl = `${base}/workspace/ws_1/office/${document.documentId}`;
  const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: auth(token), body: JSON.stringify(body) });
  expect((await post(`${documentUrl}/context`, { pageId: document.pageId, activate: true, selection: { sheetId: "s", ranges: [], drawingIds: [] } })).status).toBe(200);
  expect(await (await fetch(`${base}/workspace/ws_1/office/current?sessionId=ses_transfer`, { headers: auth(token) })).json()).toMatchObject({ document: { documentId: document.documentId, state: "opening" }, selection: null });
  expect(await (await fetch(`${base}/workspace/ws_1/office/current?sessionId=ses_other`, { headers: auth(token) })).json()).toEqual({ document: null, selection: null });
  expect((await post(`${documentUrl}/close`, { decision: "discard" })).status).toBe(409);
  const fileSession = await (await post(`${base}/workspace/ws_1/files/sessions`, { write: true })).json() as { session: { id: string } };
  const operations = [
    { type: "rename", from: "reports/artifact-eval.csv", to: "reports/renamed.csv" },
    { type: "rename", from: "reports/artifact-eval.md", to: "reports/artifact-eval.csv" },
    { type: "rename", from: "reports", to: "moved" },
    { type: "delete", path: "reports", recursive: true },
  ];
  const opsUrl = `${base}/files/sessions/${fileSession.session.id}/ops`;
  const blocked = await (await post(opsUrl, { operations })).json() as { items: Array<{ok: boolean; message: string}> };
  expect(blocked.items).toHaveLength(4);
  expect(blocked.items.every((item) => !item.ok && item.message.includes("保存并关闭"))).toBe(true);
  const savedContent = await readFile(join(root, "reports/artifact-eval.csv"), "utf8");
  expect((await post(`${base}/workspace/ws_1/files/raw`, { path: "reports/artifact-eval.csv", dataBase64: Buffer.from("overwritten").toString("base64") })).status).toBe(409);
  expect(await readFile(join(root, "reports/artifact-eval.csv"), "utf8")).toBe(savedContent);
  expect((await post(`${documentUrl}/page-failed`, {})).status).toBe(200);
  expect(await (await fetch(documentUrl, { headers: auth(token) })).json()).toMatchObject({ document: { state: "error", engineFileId: null, previewUrl: null } });
  expect((await post(`${documentUrl}/recover`, {})).status).toBe(409);
  status = { ses_other: { type: "busy" } };
  expect((await post(`${documentUrl}/recover`, {})).status).toBe(200);
  expect((await post(`${documentUrl}/context`, { pageId: document.pageId, activate: true, selection: null })).status).toBe(409);
  expect(await (await fetch(url, { headers: auth(token) })).json()).toMatchObject({ reason: null });
  status = { ses_transfer: { unexpected: true } };
  expect((await fetch(url, { headers: auth(token) })).status).toBe(502);
  expect((await post(`${documentUrl}/close`, { decision: "discard" })).status).toBe(502);
  status = {};
  expect((await post(`${documentUrl}/close`, { decision: "discard" })).status).toBe(200);
  expect(await (await post(opsUrl, { operations: [operations[0]] })).json()).toMatchObject({ items: [{ ok: true }] });
  expect(await readFile(join(root, "reports/renamed.csv"), "utf8")).toBe(savedContent);
}, 30_000);

describe("artifact file routes", () => {
  test("中文及引号文件名可读取原始文件，UTF-8 下载名不导致 500", async () => {
    const root = await createWorkspaceRoot();
    const { base, token } = await startJuggleWorkServer(root);
    const path = 'reports/说明 "A".md';
    await writeFile(join(root, path), "# 中文文件预览\n", "utf8");
    const response = await fetch(`${base}/workspace/ws_1/files/raw?path=${encodeURIComponent(path)}`, { headers: auth(token) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("filename*=UTF-8''");
    expect(await response.text()).toBe("# 中文文件预览\n");
  });
  test("真实 prompt 用户消息 ID 贯通运行结束、文件交付与历史查询", async () => {
    const root = await createWorkspaceRoot();
    let forwardedMessageId = "";
    const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/session/status") return Response.json({});
      if (path === "/session/ses_delivery/prompt_async") {
        forwardedMessageId = (await request.json() as { messageID: string }).messageID;
        return new Response(null, { status: 204 });
      }
      if (path === "/session/ses_delivery/message") return Response.json([
        { info: { id: forwardedMessageId, role: "user" }, parts: [] },
        { info: { id: "msg_assistant", role: "assistant", parentID: forwardedMessageId }, parts: [
          { id: "prt_write", type: "tool", tool: "write", callID: "call_write", state: { status: "completed", input: { filePath: "reports/artifact-eval.docx" } } },
        ] },
      ]);
      return Response.json({}, { status: 404 });
    } });
    stops.push(() => engine.stop(true));
    const { base, token } = await startJuggleWorkServer(root, `http://127.0.0.1:${engine.port}`);
    const runBase = `${base}/workspace/ws_1/sessions/ses_delivery/runs`;
    const response = await fetch(`${runBase}/start`, { method: "POST", headers: auth(token), body: JSON.stringify({
      origin: "local-renderer", startCommandCorrelationId: "delivery_command", prompt: { parts: [{ type: "text", text: "生成文档" }] },
    }) });
    expect(response.status).toBe(202);
    const { run } = await response.json() as { run: { runId: string } };
    expect(forwardedMessageId).toMatch(/^msg_/);
    const deliveries = `${base}/workspace/ws_1/sessions/ses_delivery/file-deliveries`;
    expect(await (await fetch(deliveries, { headers: auth(token) })).json()).toMatchObject({ turns: [{ turnId: forwardedMessageId, runIds: [run.runId], status: "collecting" }] });
    const early = await fetch(`${deliveries}/sync`, { method: "POST", headers: auth(token) });
    expect(await early.json()).toMatchObject({ turns: [{ status: "collecting", items: [] }] });
    const previousUrl = process.env.JUGGLEWORK_SERVER_URL;
    const previousToken = process.env.JUGGLEWORK_SERVER_TOKEN;
    try {
      process.env.JUGGLEWORK_SERVER_URL = base;
      process.env.JUGGLEWORK_SERVER_TOKEN = token;
      const plugin = await JuggleWorkExtensionsPreview({ directory: root });
      const generated = JSON.parse(await plugin.tool.jugglework_artifact_generate.execute({
        program: process.execPath,
        args: ["-e", 'require("node:fs").writeFileSync("自动产物.docx", "generated");'],
      }, { sessionID: "ses_delivery", messageID: "msg_assistant", ask: async () => {} }));
      expect(generated).toMatchObject({ ok: true, output: "", delivery: { files: [{ name: "自动产物.docx", sizeBytes: 9 }] } });
    } finally {
      if (previousUrl === undefined) delete process.env.JUGGLEWORK_SERVER_URL;
      else process.env.JUGGLEWORK_SERVER_URL = previousUrl;
      if (previousToken === undefined) delete process.env.JUGGLEWORK_SERVER_TOKEN;
      else process.env.JUGGLEWORK_SERVER_TOKEN = previousToken;
    }
    const terminal = await fetch(`${runBase}/${run.runId}/observations`, { method: "POST", headers: auth(token), body: JSON.stringify({ status: "completed" }) });
    expect(terminal.status).toBe(200);
    const synced = await fetch(`${deliveries}/sync`, { method: "POST", headers: auth(token) });
    expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({
      files: expect.arrayContaining([expect.objectContaining({ relativePath: "reports/artifact-eval.docx", sizeBytes: 8 }), expect.objectContaining({ name: "自动产物.docx", sizeBytes: 9 })]),
      turns: [{ turnId: forwardedMessageId, status: "ready", items: expect.arrayContaining([expect.objectContaining({ snapshot: expect.objectContaining({ sizeBytes: 8 }) })]) }],
    });
    await writeFile(join(root, "reports", "artifact-eval.docx"), "updated content");
    expect(await (await fetch(deliveries, { headers: auth(token) })).json()).toMatchObject({
      files: expect.arrayContaining([expect.objectContaining({ relativePath: "reports/artifact-eval.docx", sizeBytes: 15 })]), turns: [{ items: expect.arrayContaining([expect.objectContaining({ snapshot: expect.objectContaining({ name: "artifact-eval.docx", sizeBytes: 8 }) })]) }],
    });
  });
  test("resolve, read, write, and download markdown/csv/xlsx/pptx/docx/html artifacts", async () => {
    const root = await createWorkspaceRoot();
    const { base, token } = await startJuggleWorkServer(root);

    const resolveResponse = await fetch(`${base}/workspace/ws_1/artifacts/resolve`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        targets: [
          { kind: "file", value: join(root, "reports", "artifact-eval.md"), confidence: 95 },
          { kind: "file", value: "Workspace/32423/reports/artifact-eval.md", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.csv", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.xlsx", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.pptx", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.docx", confidence: 80 },
          { kind: "file", value: "reports/index.html", confidence: 80 },
          { kind: "file", value: "reports/missing.md", confidence: 80 },
          { kind: "url", value: "http://localhost:4321", confidence: 80 },
          { kind: "url", value: "ws://localhost:4321/socket", confidence: 80 },
        ],
      }),
    });
    expect(resolveResponse.status).toBe(200);
    const resolved = await resolveResponse.json() as { items: Array<any> };
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.md")).toMatchObject({ exists: true, preview: "markdown", confidence: 95 });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.csv")).toMatchObject({ exists: true, preview: "sheet" });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.xlsx")).toMatchObject({ exists: true, preview: "sheet" });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.pptx")).toMatchObject({ exists: true, preview: "slides", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.docx")).toMatchObject({ exists: true, preview: "document", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(resolved.items.find((item) => item.value === "reports/index.html")).toMatchObject({ exists: true, preview: "html" });
    expect(resolved.items.find((item) => item.value === "reports/missing.md")).toMatchObject({ exists: false });
    expect(resolved.items.find((item) => item.value === "http://localhost:4321/")).toMatchObject({ kind: "url", preview: "browser" });
    expect(resolved.items.find((item) => item.value === "ws://localhost:4321/socket")).toMatchObject({ kind: "url", preview: "browser" });

    const csvRead = await fetch(`${base}/workspace/ws_1/files/content?path=${encodeURIComponent("reports/artifact-eval.csv")}`, { headers: auth(token) });
    expect(await csvRead.json()).toMatchObject({ content: "name,revenue\nAda,10\nGrace,20\n" });

    const mdWrite = await fetch(`${base}/workspace/ws_1/files/content`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ path: "reports/artifact-eval.md", content: "# Updated\n" }),
    });
    expect(mdWrite.status).toBe(200);
    expect(await readFile(join(root, "reports", "artifact-eval.md"), "utf8")).toBe("# Updated\n");

    const xlsxWrite = await fetch(`${base}/workspace/ws_1/files/raw`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ path: "reports/artifact-eval.xlsx", dataBase64: Buffer.from([80, 75, 9, 9]).toString("base64") }),
    });
    expect(xlsxWrite.status).toBe(200);

    const xlsxDownload = await fetch(`${base}/workspace/ws_1/files/raw?path=${encodeURIComponent("reports/artifact-eval.xlsx")}`, { headers: auth(token) });
    expect(xlsxDownload.status).toBe(200);
    expect(Array.from(new Uint8Array(await xlsxDownload.arrayBuffer()))).toEqual([80, 75, 9, 9]);
  });
});
