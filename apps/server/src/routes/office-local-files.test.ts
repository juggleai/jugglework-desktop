import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalOfficeFiles } from "../office/local-files.js";
import { OfficeDocuments } from "../office/documents.js";
import { registerLocalOfficeRoutes } from "./office-local-files.js";
import { matchRoute, type RequestContext, type Route } from "./registry.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { ensureFileAssistantFileWorkspace, ensureFileAssistantWorkspace } from "../office/file-assistant-workspace.js";
import { buildWorkspaceInfos } from "../workspaces.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("存活普通/managed/legacy Office owner 优先，root 从配置按 ID 获取且不改绑", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-office-owner-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "原件 # %.csv"), statePath = join(root, "registry.json");
  await writeFile(path, "a,b\n1,2\n");
  const workspaces: WorkspaceInfo[] = [];
  const files = new LocalOfficeFiles({ root: join(root, "FileAssistant"), statePath, workspaceById: (id) => workspaces.find((workspace) => workspace.id === id) });
  const key = await files.register(path);
  const binding = await files.bindingFor(key);
  const registered = await readFile(statePath, "utf8");
  let creates = 0;
  const documents = new OfficeDocuments({
    engine: { ensureStarted: async () => {}, previewUrl: async () => "http://localhost/preview", editor: async () => null, dispose: async () => {} } as any,
    resolveFile: async (workspaceId, relativePath) => ({ absolutePath: path, file: {
      ...(await files.resolve(binding.workspaceId, key)).file, workspaceId, relativePath,
    } }),
    onSaved: async () => {}, onModified: async () => {}, onOwnership: async () => {}, isBusy: () => false,
  });
  cleanups.push(() => documents.dispose());
  const routes: Route[] = [];
  registerLocalOfficeRoutes({ routes, files, documents, jsonResponse: Response.json,
    readJsonBody: (request) => request.json() as Promise<Record<string, unknown>>, ensureWritable: () => {},
    workspaceById: (id) => workspaces.find((workspace) => workspace.id === id),
    ensureConversation: async () => { creates++; return "ses_should_not_create"; },
  });
  const open = async () => {
    const url = new URL("http://localhost/office/local-files/open");
    const route = matchRoute(routes, "POST", url.pathname)!;
    return route.handler({ request: new Request(url, { method: "POST", body: JSON.stringify({ path }) }), url } as RequestContext);
  };
  for (const [id, managed] of [["ordinary-owner", false], ["unknown-managed-owner", true], [files.id, true]] as const) {
    const workspace: WorkspaceInfo = { id, name: "Owner", path: join(root, id), workspaceType: "local", preset: "starter", ...(managed ? { fileAssistantManaged: true } : {}) };
    workspaces.push(workspace);
    const sessionId = `ses_${id}`;
    const opened = await documents.open(id, sessionId, "owner-original.csv");
    const response = await open();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaceId: id, sessionId, workspaceRoot: workspace.path, path: "owner-original.csv", absolutePath: await realpath(path), local: managed,
      group: managed ? { kind: "file-assistant" } : { kind: "conversation", workspaceId: id, sessionId } });
    expect(creates).toBe(0);
    expect(await readFile(statePath, "utf8")).toBe(registered);
    expect((await files.bindingFor(key)).sessionId).toBeUndefined();
    await documents.close(id, opened.documentId, "discard");
  }
});

test.each(["root", "child"] as const)("%s 登记首次 persist 失败后重开必须落盘，冷加载 workspace 与原件 lookup 一致", async (kind) => {
  const temp = await mkdtemp(join(tmpdir(), "local-office-persist-retry-"));
  const previousDb = process.env.JUGGLEWORK_RUNTIME_DB;
  process.env.JUGGLEWORK_RUNTIME_DB = join(temp, "runtime.sqlite");
  cleanups.push(async () => {
    if (previousDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
    else process.env.JUGGLEWORK_RUNTIME_DB = previousDb;
    await rm(temp, { recursive: true, force: true });
  });
  const root = join(temp, "FileAssistant"), statePath = join(temp, "registry.json"), path = join(temp, "原件.csv");
  await writeFile(path, "a,b\n1,2\n");
  const config = { configPath: join(temp, "server.json"), workspaces: [], authorizedRoots: [] } as unknown as ServerConfig;
  if (kind === "child") await ensureFileAssistantWorkspace(config, root);
  const initialWorkspaces = [...config.workspaces], initialRoots = [...config.authorizedRoots];
  const blocker = join(temp, "blocked-config-directory");
  config.configPath = join(blocker, "server.json");
  await writeFile(blocker, "阻止持久化写入");
  const files = new LocalOfficeFiles({ root, statePath });
  const routes: Route[] = [];
  let creates = 0;
  registerLocalOfficeRoutes({ routes, files, documents: { findByAbsolutePath: async () => null } as unknown as OfficeDocuments,
    jsonResponse: Response.json, readJsonBody: (request) => request.json() as Promise<Record<string, unknown>>, ensureWritable: () => {},
    workspaceById: (id) => config.workspaces.find((workspace) => workspace.id === id),
    ensureConversation: async (binding, name) => {
      await ensureFileAssistantWorkspace(config, root);
      await ensureFileAssistantFileWorkspace(config, binding.workspaceRoot, name);
      creates++;
      return "ses_file";
    },
  });
  const open = () => {
    const url = new URL("http://localhost/office/local-files/open");
    return matchRoute(routes, "POST", url.pathname)!.handler({
      request: new Request(url, { method: "POST", body: JSON.stringify({ path }) }), url,
    } as RequestContext);
  };
  await expect(open()).rejects.toBeInstanceOf(Error);
  expect(creates).toBe(0);
  expect(config.workspaces).toEqual(initialWorkspaces);
  expect(config.authorizedRoots).toEqual(initialRoots);
  await rm(blocker);
  const response = await open();
  expect(response.status).toBe(200);
  const context = await response.json() as { workspaceId: string; workspaceRoot: string; path: string; sessionId: string };
  expect(creates).toBe(1);
  const disk = JSON.parse(await readFile(config.configPath!, "utf8"));
  const coldWorkspaces = buildWorkspaceInfos(disk.workspaces, temp);
  expect(coldWorkspaces.find((workspace) => workspace.id === context.workspaceId)).toMatchObject({ path: context.workspaceRoot, fileAssistantManaged: true });
  expect(disk.authorizedRoots).toContain(context.workspaceRoot);
  const coldFiles = new LocalOfficeFiles({ root, statePath, workspaceById: (id) => coldWorkspaces.find((workspace) => workspace.id === id) });
  await coldFiles.load();
  expect(coldFiles.workspaceIdForRoot(context.workspaceRoot)).toBe(context.workspaceId);
  expect(await coldFiles.bindingFor(context.path)).toMatchObject({ workspaceId: context.workspaceId, workspaceRoot: context.workspaceRoot, sessionId: "ses_file" });
  expect((await coldFiles.resolve(context.workspaceId, context.path)).absolutePath).toBe(await realpath(path));
});
