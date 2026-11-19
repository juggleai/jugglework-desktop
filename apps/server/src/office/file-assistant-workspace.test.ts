import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { readJuggleWorkWorkspaceConfig } from "../jugglework-workspace-config-store.js";
import { buildWorkspaceInfos, workspaceIdForPath } from "../workspaces.js";
import { ensureFileAssistantFileWorkspace, ensureFileAssistantWorkspace, fileAssistantChildWorkspaceRoot, validateFileAssistantFileWorkspace } from "./file-assistant-workspace.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "file-assistant-workspace-"));
  const previousDb = process.env.JUGGLEWORK_RUNTIME_DB;
  process.env.JUGGLEWORK_RUNTIME_DB = join(temp, "runtime.sqlite");
  cleanups.push(async () => {
    if (previousDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
    else process.env.JUGGLEWORK_RUNTIME_DB = previousDb;
    await rm(temp, { recursive: true, force: true });
  });
  const root = join(temp, "FileAssistant");
  const config = { configPath: join(temp, "server.json"), workspaces: [], authorizedRoots: [] } as unknown as ServerConfig;
  return { temp, root, config };
}

const directoryLink = (target: string, path: string) => symlink(target, path, process.platform === "win32" ? "junction" : "dir");
const hashA = "a".repeat(32), hashB = "b".repeat(32);

test("冷恢复 validator 只读检查，不创建缺失 child 或 workspace 配置", async () => {
  const temp = await mkdtemp(join(tmpdir(), "file-assistant-validate-"));
  cleanups.push(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "FileAssistant"), child = fileAssistantChildWorkspaceRoot(root, hashA);
  await mkdir(join(root, "files"), { recursive: true });
  await expect(validateFileAssistantFileWorkspace(child)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(join(root, "files"))).toEqual([]);
  await mkdir(child);
  await validateFileAssistantFileWorkspace(child);
  expect(await readdir(child)).toEqual([]);
  expect(await readdir(root)).toEqual(["files"]);
});

test.each(["root", "child"] as const)("%s 首次持久化失败回滚新增登记，重试写盘后冷加载可查", async (kind) => {
  const { temp, root, config } = await fixture();
  if (kind === "child") await ensureFileAssistantWorkspace(config, root);
  const blocker = join(temp, "blocked-config-directory");
  config.configPath = join(blocker, "server.json");
  const path = kind === "root" ? root : fileAssistantChildWorkspaceRoot(root, hashA);
  const ensure = () => kind === "root" ? ensureFileAssistantWorkspace(config, path) : ensureFileAssistantFileWorkspace(config, path, "原件");
  const workspaces = [...config.workspaces], roots = [...config.authorizedRoots];
  await writeFile(blocker, "不能在普通文件下写配置");
  await expect(ensure()).rejects.toBeInstanceOf(Error);
  expect(config.workspaces).toEqual(workspaces);
  expect(config.authorizedRoots).toEqual(roots);
  expect(await readFile(blocker, "utf8")).toBe("不能在普通文件下写配置");
  await rm(blocker);
  await mkdir(blocker);
  await writeFile(config.configPath!, JSON.stringify({ unrelated: "preserved" }));
  const workspace = await ensure();
  const disk = JSON.parse(await readFile(config.configPath!, "utf8"));
  expect(disk.unrelated).toBe("preserved");
  expect(disk.authorizedRoots).toContain(path);
  const cold = buildWorkspaceInfos(disk.workspaces, temp);
  expect(cold.find((entry) => entry.id === workspace.id)).toMatchObject({ path, fileAssistantManaged: true });
});

test.each([
  { marker: undefined, authorized: false },
  { marker: false, authorized: true },
  { marker: true, authorized: false },
])("持久化失败仅恢复原 marker=$marker / authorized=$authorized，不删除既有状态", async ({ marker, authorized }) => {
  const { temp, root, config } = await fixture();
  const workspace: WorkspaceInfo = { id: workspaceIdForPath(root), path: root, name: "历史名称", preset: "starter", workspaceType: "local",
    ...(marker === undefined ? {} : { fileAssistantManaged: marker }) };
  const other: WorkspaceInfo = { id: "unrelated", path: join(temp, "other"), name: "其他", preset: "starter", workspaceType: "local" };
  config.workspaces.push(other, workspace);
  config.authorizedRoots.push(other.path, ...(authorized ? [root] : []));
  const expectedWorkspace = { ...workspace }, expectedRoots = [...config.authorizedRoots];
  await writeFile(config.configPath!, "invalid JSON");
  await expect(ensureFileAssistantWorkspace(config, root)).rejects.toMatchObject({ code: "invalid_json" });
  expect(config.workspaces).toEqual([other, expectedWorkspace]);
  expect(config.workspaces[1]).toBe(workspace);
  expect(Object.hasOwn(workspace, "fileAssistantManaged")).toBe(marker !== undefined);
  expect(config.authorizedRoots).toEqual(expectedRoots);
  await writeFile(config.configPath!, "{}");
  expect(await ensureFileAssistantWorkspace(config, root)).toBe(workspace);
  const disk = JSON.parse(await readFile(config.configPath!, "utf8"));
  expect(disk.workspaces).toHaveLength(2);
  expect(disk.workspaces[1]).toMatchObject({ name: "历史名称", fileAssistantManaged: true });
});

test("B -> A 的 child 链接不能共享 cwd，既有 A 状态保持且 B 无配置或授权", async () => {
  const { root, config } = await fixture();
  await ensureFileAssistantWorkspace(config, root);
  const a = await ensureFileAssistantFileWorkspace(config, fileAssistantChildWorkspaceRoot(root, hashA), "A");
  const b = fileAssistantChildWorkspaceRoot(root, hashB);
  await directoryLink(a.path, b);
  const disk = await readFile(config.configPath!, "utf8"), entries = await readdir(a.path);
  await expect(ensureFileAssistantFileWorkspace(config, b, "B")).rejects.toMatchObject({ code: "file_assistant_directory_invalid" });
  expect(config.workspaces.map((workspace) => workspace.path)).toEqual([root, a.path]);
  expect(config.authorizedRoots).not.toContain(b);
  expect(await readJuggleWorkWorkspaceConfig(config, workspaceIdForPath(b))).toEqual({});
  expect(await readFile(config.configPath!, "utf8")).toBe(disk);
  expect(await readdir(a.path)).toEqual(entries);
});

test.each(["files", "child"] as const)("%s -> outside 在初始化前拒绝，外部无写入且 child 无授权", async (kind) => {
  const { temp, root, config } = await fixture();
  await ensureFileAssistantWorkspace(config, root);
  const outside = join(temp, "outside");
  await mkdir(outside);
  const child = fileAssistantChildWorkspaceRoot(root, hashB);
  if (kind === "child") await mkdir(join(root, "files"));
  await directoryLink(outside, kind === "files" ? join(root, "files") : child);
  const disk = await readFile(config.configPath!, "utf8");
  await expect(ensureFileAssistantFileWorkspace(config, child, "B")).rejects.toMatchObject({ code: "file_assistant_directory_invalid" });
  expect(await readdir(outside)).toEqual([]);
  expect(config.workspaces.map((workspace) => workspace.path)).toEqual([root]);
  expect(config.authorizedRoots).toEqual([root]);
  expect(await readJuggleWorkWorkspaceConfig(config, workspaceIdForPath(child))).toEqual({});
  expect(await readFile(config.configPath!, "utf8")).toBe(disk);
});

test.each(["Documents", "root"] as const)("允许 %s 链接，canonical child 正确且沿用原路径 ID", async (kind) => {
  const { temp, config } = await fixture();
  const actual = join(temp, "actual");
  await mkdir(actual);
  const alias = join(temp, kind);
  await directoryLink(actual, alias);
  const root = kind === "Documents" ? join(alias, "JuggleWork", "FileAssistant") : alias;
  const workspace = await ensureFileAssistantWorkspace(config, root);
  expect(workspace.id).toBe(workspaceIdForPath(root));
  expect(workspace.path).toBe(root);
  const childPath = fileAssistantChildWorkspaceRoot(root, hashA);
  const child = await ensureFileAssistantFileWorkspace(config, childPath, "A");
  expect(child.id).toBe(workspaceIdForPath(childPath));
  expect(child.path).toBe(childPath);
  expect(await realpath(child.path)).toBe(join(await realpath(root), "files", hashA));
  expect((await ensureFileAssistantFileWorkspace(config, childPath, "A"))).toBe(child);
});

test("child 必须属于已登记 namespace 且使用固定 hash，拒绝前不创建目录", async () => {
  const { temp, root, config } = await fixture();
  const child = fileAssistantChildWorkspaceRoot(root, hashA);
  await expect(ensureFileAssistantFileWorkspace(config, child, "A")).rejects.toMatchObject({ code: "file_assistant_directory_invalid" });
  await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  await ensureFileAssistantWorkspace(config, root);
  for (const path of [join(root, "files", "not-a-hash"), join(root, "other", hashA), join(temp, "unknown", "files", hashA)]) {
    await expect(ensureFileAssistantFileWorkspace(config, path, "A")).rejects.toMatchObject({ code: "file_assistant_directory_invalid" });
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(config.authorizedRoots).not.toContain(path);
  }
});
