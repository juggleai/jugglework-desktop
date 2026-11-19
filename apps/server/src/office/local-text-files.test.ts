import { afterEach, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, open as openFile, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { buildWorkspaceInfos } from "../workspaces.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(approval: "auto" | "manual" = "auto", rootLink?: "Documents" | "root") {
  const root = await mkdtemp(join(tmpdir(), "local-text-http-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  let assistantRoot = join(root, "FileAssistant");
  await mkdir(workspace);
  if (rootLink) {
    const actual = join(root, "actual"), alias = join(root, rootLink);
    await mkdir(actual);
    await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    assistantRoot = rootLink === "root" ? alias : join(alias, "JuggleWork", "FileAssistant");
  }
  let sessions = 0;
  const upstream = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/session" && request.method === "POST") return Response.json({ id: `ses_text_${++sessions}`, title: "文件" });
    if (url.pathname === "/session") return Response.json([]);
    if (url.pathname.startsWith("/session/")) return Response.json({ id: url.pathname.split("/").at(-1) });
    return Response.json({});
  } });
  cleanups.push(async () => { await upstream.stop(true); });
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, configPath: join(root, "server.json"), token: "client", hostToken: "host",
    approval: { mode: approval, timeoutMs: 5000 }, corsOrigins: ["*"],
    workspaces: [{ id: "ws", name: "Workspace", path: workspace, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspace], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false, opencodeBaseUrl: upstream.url.href,
  };
  let server = await startServer(config, { fileAssistantRoot: assistantRoot });
  cleanups.push(async () => { await server.stop(); });
  let base = `http://127.0.0.1:${server.port}`;
  const restart = async (readOnly = false) => {
    await server.stop();
    const persisted = JSON.parse(await readFile(config.configPath!, "utf8"));
    config.workspaces = buildWorkspaceInfos(persisted.workspaces, root);
    config.quarantinedWorkspaces = undefined;
    config.authorizedRoots = persisted.authorizedRoots;
    config.readOnly = readOnly;
    server = await startServer(config, { fileAssistantRoot: assistantRoot });
    base = `http://127.0.0.1:${server.port}`;
  };
  const headers = { authorization: "Bearer client", "content-type": "application/json" };
  const hostRequest = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: { ...headers, "X-JuggleWork-Host-Token": "host" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const post = (path: string, body: unknown, host = false) => fetch(`${base}${path}`, { method: "POST", headers: { ...headers, ...(host ? { "X-JuggleWork-Host-Token": "host" } : {}) }, body: JSON.stringify(body) });
  const get = (path: string, host = false) => fetch(`${base}${path}`, { headers: { ...headers, ...(host ? { "X-JuggleWork-Host-Token": "host" } : {}) } });
  const open = async (name: string, content: string | Buffer = "fixture") => {
    const path = join(root, name);
    await writeFile(path, content);
    const response = await post("/office/local-files/open", { path }, true);
    expect(response.status).toBe(200);
    const context = await response.json() as { workspaceId: string; workspaceRoot: string; path: string; absolutePath: string };
    return { ...context, original: path, prefix: `/workspace/${context.workspaceId}/files` };
  };
  return { root, assistantRoot, config, get, post, open, restart, hostRequest };
}

test.each(["child", "files", "missing", "read-only"] as const)("真实 HTTP 冷恢复隔离 %s 异常 child，普通工作区可用且不改配置或登记", async (kind) => {
  const f = await fixture();
  const a = await f.open("a.md"), b = await f.open("b.md");
  const statePath = join(f.root, "file-assistant.json");
  const configBefore = await readFile(f.config.configPath!, "utf8"), registryBefore = await readFile(statePath, "utf8");
  // 服务仍存活时仅改测试目录，冷启动必须从持久登记发现问题，不能依赖再次 open。
  if (kind === "files") {
    await rm(dirname(b.workspaceRoot), { recursive: true, force: true });
    await symlink(f.root, dirname(b.workspaceRoot), process.platform === "win32" ? "junction" : "dir");
  } else {
    await rm(b.workspaceRoot, { recursive: true, force: true });
    if (kind === "child" || kind === "read-only") await symlink(a.workspaceRoot, b.workspaceRoot, process.platform === "win32" ? "junction" : "dir");
  }
  await f.restart(kind === "read-only");
  expect(await readFile(f.config.configPath!, "utf8")).toBe(configBefore);
  expect(await readFile(statePath, "utf8")).toBe(registryBefore);
  expect((await f.get(`/workspace/${b.workspaceId}/sessions`)).status).toBe(404);
  expect((await f.get(`${b.prefix}/raw?path=${encodeURIComponent(b.path)}`)).status).toBe(404);
  expect((await f.post(`${b.prefix}/raw`, { path: "generated.md", dataBase64: "YQ==" })).status).toBe(kind === "read-only" ? 403 : 404);
  expect((await f.get("/workspace/ws/sessions")).status).toBe(200);
  expect((await f.post("/workspace/ws/files/raw", { path: "ordinary.md", dataBase64: "YQ==" })).status).toBe(kind === "read-only" ? 403 : 200);
  if (kind === "child" || kind === "read-only") {
    expect((await f.get(`/workspace/${a.workspaceId}/sessions`)).status).toBe(200);
    await expect(access(join(a.workspaceRoot, "generated.md"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  if (kind === "missing") await expect(access(b.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(b.original, "utf8")).toBe("fixture");
});

test.each(["Documents", "root"] as const)("真实 HTTP 冷恢复允许 %s 正常链接，child 原件和会话继续可用", async (link) => {
  const f = await fixture("auto", link);
  const md = await f.open("linked.md", "before");
  const configBefore = await readFile(f.config.configPath!, "utf8");
  await f.restart();
  expect(await readFile(f.config.configPath!, "utf8")).toBe(configBefore);
  expect((await f.get(`/workspace/${md.workspaceId}/sessions`)).status).toBe(200);
  const response = await f.post(`${md.prefix}/content`, { path: md.path, content: "after", baseUpdatedAt: (await stat(md.original)).mtimeMs });
  expect(response.status).toBe(200);
  expect(await readFile(md.original, "utf8")).toBe("after");
});

test("真实 HTTP 隔离后普通重命名和新增 child 保留登记元数据，目录修复后同 ID 冷恢复", async () => {
  const f = await fixture();
  const a = await f.open("valid.md"), b = await f.open("quarantined.md");
  f.config.workspaces.find((workspace) => workspace.id === b.workspaceId)!.hidden = true;
  expect((await f.hostRequest("PATCH", `/workspaces/${b.workspaceId}/display-name`, { displayName: "保留的文件名称" })).status).toBe(200);
  const persisted = async () => JSON.parse(await readFile(f.config.configPath!, "utf8")) as { workspaces: Array<Record<string, unknown>> };
  const original = (await persisted()).workspaces.find((workspace) => workspace.id === b.workspaceId)!;
  const backup = join(f.root, "child-backup");
  await rename(b.workspaceRoot, backup);
  await symlink(a.workspaceRoot, b.workspaceRoot, process.platform === "win32" ? "junction" : "dir");
  await f.restart();
  const assertQuarantined = async () => {
    expect(f.config.workspaces.some((workspace) => workspace.id === b.workspaceId)).toBe(false);
    expect(f.config.quarantinedWorkspaces?.map((workspace) => workspace.id)).toEqual([b.workspaceId]);
    expect((await f.get(`/workspace/${b.workspaceId}/sessions`)).status).toBe(404);
    expect((await f.post(`${b.prefix}/raw`, { path: "generated.md", dataBase64: "YQ==" })).status).toBe(404);
    expect((await persisted()).workspaces.find((workspace) => workspace.id === b.workspaceId)).toEqual(original);
  };
  await assertQuarantined();
  expect((await f.hostRequest("PATCH", "/workspaces/ws/display-name", { displayName: "普通工作区已重命名" })).status).toBe(200);
  await assertQuarantined();
  const c = await f.open("new-child.md");
  await assertQuarantined();
  // 普通条目的显式删除不能被保留隔离项的持久化逻辑撤销。
  const created = await f.post("/workspaces/local", { folderPath: join(f.root, "temporary-workspace") }, true);
  expect(created.status).toBe(201);
  const { activeId } = await created.json() as { activeId: string };
  expect((await f.hostRequest("DELETE", `/workspaces/${activeId}`)).status).toBe(200);
  await f.restart();
  await assertQuarantined();
  expect((await persisted()).workspaces.some((workspace) => workspace.id === activeId)).toBe(false);
  await rm(b.workspaceRoot);
  await rename(backup, b.workspaceRoot);
  await f.restart();
  expect(f.config.quarantinedWorkspaces).toEqual([]);
  expect(f.config.workspaces.find((workspace) => workspace.id === b.workspaceId)).toMatchObject(original);
  expect((await f.get(`/workspace/${b.workspaceId}/sessions`)).status).toBe(200);
  expect((await f.get(`${b.prefix}/raw?path=${encodeURIComponent(b.path)}`)).status).toBe(200);
  expect((await f.get(`/workspace/${c.workspaceId}/sessions`)).status).toBe(200);
  expect((await f.get("/workspace/ws/sessions")).status).toBe(200);
  expect(f.config.workspaces.find((workspace) => workspace.id === "ws")?.displayName).toBe("普通工作区已重命名");
  expect((await persisted()).workspaces.find((workspace) => workspace.id === b.workspaceId)).toEqual(original);
  await expect(access(join(a.workspaceRoot, "generated.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("真实 HTTP 显式删除隔离登记不访问无效 cwd，后续持久化和冷恢复不复活条目", async () => {
  const f = await fixture();
  const a = await f.open("valid.md"), b = await f.open("deleted.md");
  await rm(b.workspaceRoot, { recursive: true, force: true });
  await symlink(a.workspaceRoot, b.workspaceRoot, process.platform === "win32" ? "junction" : "dir");
  await f.restart();
  const before = await readdir(a.workspaceRoot);
  const response = await f.hostRequest("DELETE", `/workspaces/${b.workspaceId}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ deleted: true, persisted: true });
  expect(await readdir(a.workspaceRoot)).toEqual(before);
  expect(f.config.quarantinedWorkspaces).toEqual([]);
  expect((await f.hostRequest("PATCH", "/workspaces/ws/display-name", { displayName: "正常保存" })).status).toBe(200);
  await rm(b.workspaceRoot);
  await mkdir(b.workspaceRoot);
  await f.restart();
  expect(f.config.workspaces.some((workspace) => workspace.id === b.workspaceId)).toBe(false);
  expect((await f.get(`/workspace/${b.workspaceId}/sessions`)).status).toBe(404);
  expect(JSON.parse(await readFile(f.config.configPath!, "utf8")).workspaces.some((workspace: { id: string }) => workspace.id === b.workspaceId)).toBe(false);
});

// root 可绕过 POSIX DAC，不能把 root 下的成功 open 当作只读权限测试证据。
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("真实 HTTP raw/content 拒绝只读原件，保留内容/mtime/mode 且不产生临时文件", async () => {
  const f = await fixture();
  const md = await f.open("readonly.md", "before");
  await chmod(md.original, 0o444);
  const before = await stat(md.original);
  try {
    await expect(openFile(md.original, "r+")).rejects.toMatchObject({ code: "EACCES" });
    for (const operation of ["raw", "content"]) {
      const response = await f.post(`${md.prefix}/${operation}`, { path: md.path, content: "overwrite", dataBase64: "YQ==", baseUpdatedAt: before.mtimeMs });
      expect(response.status).toBe(403);
      expect((await response.json() as any).code).toBe("file_access_denied");
      expect(await readFile(md.original, "utf8")).toBe("before");
      const after = await stat(md.original);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.mode & 0o777).toBe(0o444);
    }
    expect((await readdir(f.root)).some((name) => name.includes(".tmp-"))).toBe(false);
  } finally { await chmod(md.original, 0o644); }
});

test.skipIf(process.platform === "win32")("真实 HTTP raw/content 原子替换在 umask=022 时保留原件组写权限", async () => {
  const f = await fixture();
  const md = await f.open("group-writable.md", "before");
  await chmod(md.original, 0o664);
  const mask = process.umask(0o022);
  try {
    for (const operation of ["raw", "content"]) {
      const response = await f.post(`${md.prefix}/${operation}`, { path: md.path, content: operation, dataBase64: Buffer.from(operation).toString("base64"), baseUpdatedAt: (await stat(md.original)).mtimeMs });
      expect(response.status).toBe(200);
      expect(await readFile(md.original, "utf8")).toBe(operation);
      expect((await stat(md.original)).mode & 0o777).toBe(0o664);
      await expect(access(join(md.workspaceRoot, md.path))).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally { process.umask(mask); }
  expect((await readdir(f.root)).some((name) => name.includes(".tmp-"))).toBe(false);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("真实 HTTP 审批期间原件变为只读，raw/content 审批通过仍不替换", async () => {
  const f = await fixture("manual");
  const md = await f.open("approval-readonly.md", "before");
  for (const operation of ["raw", "content"]) {
    await chmod(md.original, 0o644);
    const baseUpdatedAt = (await stat(md.original)).mtimeMs;
    const saving = f.post(`${md.prefix}/${operation}`, { path: md.path, content: "overwrite", dataBase64: "YQ==", baseUpdatedAt });
    try {
      let approvalId: string | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        const { items } = await (await f.get("/approvals", true)).json() as { items: Array<{ id: string; paths: string[] }> };
        if (items.length) {
          expect(items[0]!.paths).toEqual([md.absolutePath]);
          approvalId = items[0]!.id;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(approvalId).toBeDefined();
      await chmod(md.original, 0o444);
      expect((await f.post(`/approvals/${approvalId}`, { reply: "allow" }, true)).status).toBe(200);
      expect((await saving).status).toBe(403);
      expect(await readFile(md.original, "utf8")).toBe("before");
      expect((await stat(md.original)).mtimeMs).toBe(baseUpdatedAt);
      expect((await readdir(f.root)).some((name) => name.includes(".tmp-"))).toBe(false);
    } finally {
      await chmod(md.original, 0o644);
      await saving;
    }
  }
});

test("真实 HTTP 文本原件登记、读取、raw/content 原子保存与作用域隔离，不产生影子文件", async () => {
  const f = await fixture();
  const md = await f.open("说明 # %.md", "# 原文\n");
  const raw = await f.get(`${md.prefix}/raw?path=${encodeURIComponent(md.path)}`);
  expect(raw.status).toBe(200);
  expect(await raw.text()).toBe("# 原文\n");
  const loaded = await (await f.get(`${md.prefix}/content?path=${encodeURIComponent(md.path)}`)).json() as { content: string; updatedAt: number };
  expect(loaded.content).toBe("# 原文\n");
  const saved = await f.post(`${md.prefix}/raw`, { path: md.path, dataBase64: Buffer.from("# raw 保存\n").toString("base64"), baseUpdatedAt: loaded.updatedAt });
  expect(saved.status).toBe(200);
  expect(await readFile(md.original, "utf8")).toBe("# raw 保存\n");
  const updated = await saved.json() as { updatedAt: number };
  const contentSaved = await f.post(`${md.prefix}/content`, { path: md.path, content: "# content 保存\n", baseUpdatedAt: updated.updatedAt });
  expect(contentSaved.status).toBe(200);
  expect(await readFile(md.original, "utf8")).toBe("# content 保存\n");
  await expect(access(join(md.workspaceRoot, md.path))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(f.root)).some((name) => name.includes(".tmp-"))).toBe(false);
  expect(f.config.authorizedRoots).not.toContain(f.root);

  const other = await f.open("other.mdx", "other");
  for (const prefix of [other.prefix, "/workspace/ws/files"]) {
    expect((await f.get(`${prefix}/raw?path=${encodeURIComponent(md.path)}`)).status).toBe(404);
    expect((await f.post(`${prefix}/raw`, { path: md.path, dataBase64: "YQ==", baseUpdatedAt: updated.updatedAt })).status).not.toBe(200);
    expect((await f.post(`${prefix}/content`, { path: md.path, content: "wrong scope", baseUpdatedAt: updated.updatedAt })).status).not.toBe(200);
  }
  expect((await f.get(`${md.prefix}/raw?path=${encodeURIComponent(md.original)}`)).status).toBe(404);
  expect((await f.get(`${md.prefix}/raw?path=${encodeURIComponent(md.path.replace(/[^/]+$/, "neighbor.md"))}`)).status).toBe(404);
  expect((await f.post(`${md.prefix}/raw`, { path: md.path, dataBase64: "YQ==" })).status).toBe(400);
  expect((await f.post(`${md.prefix}/content`, { path: md.path, content: "missing base" })).status).toBe(400);

  const session = await (await f.post(`/workspace/${md.workspaceId}/files/sessions`, { write: true })).json() as { session: { id: string } };
  const batch = await (await f.post(`/files/sessions/${session.session.id}/write-batch`, { writes: [{ path: md.path, contentBase64: "YQ==" }] })).json() as { items: Array<{ ok: boolean }> };
  expect(batch.items[0]?.ok).toBe(false);
  const ops = await (await f.post(`/files/sessions/${session.session.id}/ops`, { operations: [{ type: "delete", path: md.path }, { type: "rename", from: md.path, to: "moved.md" }] })).json() as { items: Array<{ ok: boolean }> };
  expect(ops.items.every((item) => !item.ok)).toBe(true);
  expect(await readFile(md.original, "utf8")).toBe("# content 保存\n");
});

test("真实 HTTP 外部修改返回 409，force 不覆盖；Office 和预览原件拒绝直接写", async () => {
  const f = await fixture();
  const md = await f.open("conflict.md", "before");
  const baseUpdatedAt = (await stat(md.original)).mtimeMs;
  await writeFile(md.original, "external");
  await utimes(md.original, new Date(), new Date(baseUpdatedAt + 2000));
  for (const operation of ["raw", "content"]) {
    const response = await f.post(`${md.prefix}/${operation}`, { path: md.path, content: "overwrite", dataBase64: Buffer.from("overwrite").toString("base64"), baseUpdatedAt, force: true });
    expect(response.status).toBe(409);
    expect((await response.json() as any).code).toBe("conflict");
  }
  expect(await readFile(md.original, "utf8")).toBe("external");
  for (const name of ["data.csv", "doc.docx", "book.xlsx", "deck.pptx", "preview.pdf", "image.png", "video.mp4", "page.html", "legacy.xls", "legacy.ods"]) {
    const file = await f.open(name);
    expect((await f.get(`${file.prefix}/raw?path=${encodeURIComponent(file.path)}`)).status).toBe(200);
    for (const operation of ["raw", "content"]) {
      const response = await f.post(`${file.prefix}/${operation}`, { path: file.path, content: "overwrite", dataBase64: "YQ==", baseUpdatedAt: (await stat(file.original)).mtimeMs });
      expect(response.status).toBe(/\.(csv|docx|xlsx|pptx)$/.test(name) ? 409 : 403);
    }
    expect(await readFile(file.original, "utf8")).toBe("fixture");
  }
});

test("真实 HTTP 普通 external-files 目录正常读写，managed 未登记键禁止磁盘回退", async () => {
  const f = await fixture();
  const workspace = f.config.workspaces.find(item => item.id === "ws")!.path;
  await mkdir(join(workspace, "external-files"));
  await writeFile(join(workspace, "external-files", "notes.md"), "# 普通目录\n");
  const path = "external-files/notes.md", prefix = "/workspace/ws/files";
  for (const operation of ["stat", "raw", "content"])
    expect((await f.get(`${prefix}/${operation}?path=${encodeURIComponent(path)}`)).status).toBe(200);
  const loaded = await (await f.get(`${prefix}/content?path=${encodeURIComponent(path)}`)).json() as { updatedAt: number };
  expect((await f.post(`${prefix}/content`, { path, content: "# 已修改\n", baseUpdatedAt: loaded.updatedAt })).status).toBe(200);
  expect(await readFile(join(workspace, path), "utf8")).toBe("# 已修改\n");

  const managed = await f.open("registered.md", "登记原件");
  await mkdir(join(managed.workspaceRoot, "external-files"), { recursive: true });
  await writeFile(join(managed.workspaceRoot, path), "不应被读取");
  for (const operation of ["stat", "raw", "content"])
    expect((await f.get(`${managed.prefix}/${operation}?path=${encodeURIComponent(path)}`)).status).toBe(404);
  expect((await f.post(`${managed.prefix}/content`, { path, content: "拒绝回退", baseUpdatedAt: 1 })).status).toBe(404);
  expect(await readFile(join(managed.workspaceRoot, path), "utf8")).toBe("不应被读取");
});

test("真实 HTTP 拒绝伪装 MD 的 NUL/无效 UTF-8、超大文本和不支持的 realpath", async () => {
  const f = await fixture();
  for (const [name, bytes, status] of [
    ["nul.md", Buffer.from([97, 0, 98]), 400], ["encoding.md", Buffer.from([0xff, 0xfe]), 400],
    ["large.md", Buffer.alloc(5_000_001, 97), 413], ["binary.exe", Buffer.from("fixture"), 400],
  ] as const) {
    const path = join(f.root, name);
    await writeFile(path, bytes);
    expect((await f.post("/office/local-files/open", { path }, true)).status).toBe(status);
  }
  const target = join(f.root, "target.bin"), alias = join(f.root, "alias.md");
  await writeFile(target, "text");
  await symlink(target, alias);
  expect((await f.post("/office/local-files/open", { path: alias }, true)).status).toBe(400);
  const allowedTarget = join(f.root, "target.md"), invalidAlias = join(f.root, "alias.bin");
  await writeFile(allowedTarget, "text");
  await symlink(allowedTarget, invalidAlias);
  expect((await f.post("/office/local-files/open", { path: invalidAlias }, true)).status).toBe(400);
  const md = await f.open("safe.md", "safe");
  const baseUpdatedAt = (await stat(md.original)).mtimeMs;
  for (const bytes of [Buffer.from([0]), Buffer.from([0xff]), Buffer.alloc(5_000_001, 97)]) {
    expect((await f.post(`${md.prefix}/raw`, { path: md.path, dataBase64: bytes.toString("base64"), baseUpdatedAt })).status).toBe(bytes.length > 5_000_000 ? 413 : 400);
  }
  expect((await f.post(`${md.prefix}/content`, { path: md.path, content: "bad\0content", baseUpdatedAt })).status).toBe(400);
  await writeFile(md.original, Buffer.from([0xff]));
  expect((await f.post(`${md.prefix}/raw`, { path: md.path, dataBase64: "YQ==", baseUpdatedAt: (await stat(md.original)).mtimeMs })).status).toBe(400);
});

test("真实 HTTP 原件保存保留审批，审批期间外部修改不能被覆盖", async () => {
  const f = await fixture("manual");
  const md = await f.open("approval.md", "before");
  const nextApproval = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await f.get("/approvals", true);
      expect(response.status).toBe(200);
      const { items } = await response.json() as { items: Array<{ id: string; paths: string[] }> };
      if (items.length) return items[0]!;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("没有收到保存审批");
  };
  const baseUpdatedAt = (await stat(md.original)).mtimeMs;
  const deniedWrite = f.post(`${md.prefix}/raw`, { path: md.path, dataBase64: "YQ==", baseUpdatedAt });
  const denied = await nextApproval();
  expect(denied.paths).toEqual([md.absolutePath]);
  expect(await readFile(md.original, "utf8")).toBe("before");
  expect((await f.post(`/approvals/${denied.id}`, { reply: "deny" }, true)).status).toBe(200);
  expect((await deniedWrite).status).toBe(403);
  expect(await readFile(md.original, "utf8")).toBe("before");

  const staleWrite = f.post(`${md.prefix}/content`, { path: md.path, content: "overwrite", baseUpdatedAt });
  const allowed = await nextApproval();
  await writeFile(md.original, "changed while approval pending");
  await utimes(md.original, new Date(), new Date(baseUpdatedAt + 2000));
  expect((await f.post(`/approvals/${allowed.id}`, { reply: "allow" }, true)).status).toBe(200);
  expect((await staleWrite).status).toBe(409);
  expect(await readFile(md.original, "utf8")).toBe("changed while approval pending");
  expect((await readdir(f.root)).some((name) => name.includes(".tmp-"))).toBe(false);
});
