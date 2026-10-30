import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import mediaGenerationPlugin from "../../../../packages/tools/mediaGeneration/src/index";
import { resolveWorkspace } from "../utils/workspace";
import {
  authorizeManagedDirectory, clearManagedDirectoryGrants, configureManagedResources, isManagedMode,
  isManagedRouteDenied, managedBuiltInToolAllowed, managedBuiltInNodeAllowed, managedGuard, managedResourceDirectory, managedToolConfig,
} from "./managed";

let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(managedGuard(true));
  app.use((req, res) => res.json({ path: req.path }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(() => server.close());

describe("managed HTTP guard", () => {
  test("allows restricted frame analysis while keeping arbitrary nodes unavailable", () => {
    expect(managedBuiltInNodeAllowed("frameAnalysisNode", true)).toBe(true);
    expect(managedBuiltInNodeAllowed("videoNode", true)).toBe(true);
    expect(managedBuiltInNodeAllowed("arbitraryFfmpegNode", true)).toBe(false);
    expect(managedBuiltInNodeAllowed("arbitraryFfmpegNode", false)).toBe(true);
  });
  test("requires the explicit managed environment value", () => {
    expect(isManagedMode({ JUGGLEWORK_MANAGED: "1" })).toBe(true);
    expect(isManagedMode({ JUGGLEWORK_MANAGED: "true" })).toBe(false);
    expect(isManagedMode({ TOONFLOW_BRIDGE_URL: "http://127.0.0.1:1234" })).toBe(false);
  });

  test.each([
    "/api/nodes/install",
    "/api/nodes/save",
    "/api/nodes/setEnabled",
    "/api/nodes/uninstall",
    "/api/tools/install",
    "/api/tools/save",
    "/api/tools/setEnabled",
    "/api/tools/uninstall",
    "/api/agents/install",
    "/api/agents/save",
    "/api/agents/setEnabled",
    "/api/agents/uninstall",
    "/api/skills/create",
    "/api/skills/install",
    "/api/skills/save",
    "/api/providers/debug/run",
    "/api/providers/models",
    "/api/providers/media/list",
    "/api/agents/connect",
    "/api/skills/uninstall",
    "/api/desktop/devtools",
    "/api/desktop/providerFile/read",
    "/api/ffmpeg/cancel",
    "/api/ffmpeg/download",
    "/api/ffmpeg/events",
    "/api/ffmpeg/execute",
    "/api/ffmpeg/progress",
    "/api/ffmpeg/status",
    "/api/mcp/status",
    "/mcp",
    "/a2a/team",
    "/api/mobileLink/connect",
    "/API/NODES/INSTALL/",
    "/api//tools//save",
    "/api/%74ools/save",
  ])("rejects %s", async path => {
    const response = await fetch(`${origin}${path}`, { method: "POST" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 403, data: null, message: "JuggleWork managed 模式不允许此操作" });
  });

  test.each([
    "/API/FFMPEG/STATUS/",
    "/api//ffmpeg//execute",
    "/api/ffmpeg%2fstatus",
    "/api/ffmpeg%5cstatus",
    "/api/allowed/../ffmpeg/events",
    "/api/ffmpeg/../ffmpeg/progress",
  ])("rejects normalized FFmpeg bypass %s", path => {
    expect(isManagedRouteDenied(path)).toBe(true);
  });

  test.each([
    ["GET", "/api/nodes/get"],
    ["GET", "/api/nodes/files"],
    ["GET", "/api/tools/get"],
    ["GET", "/api/tools/renderers"],
    ["PUT", "/api/workspaces/files/write"],
    ["POST", "/api/agent/create"],
    ["POST", "/api/ai/media/generate"],
    ["POST", "/api/media/process"],
  ])("allows %s %s to reach its route", async (method, path) => {
    expect((await fetch(`${origin}${path}`, { method })).status).toBe(200);
  });
});

describe("managed directory grants", () => {
  test("requires a current bridge-authorized canonical directory", async () => {
    const root = join(tmpdir(), `toonflow-grant-${crypto.randomUUID()}`);
    const selected = join(root, "selected");
    const previousManaged = process.env.JUGGLEWORK_MANAGED;
    process.env.JUGGLEWORK_MANAGED = "1";
    try {
      await mkdir(selected, { recursive: true });
      clearManagedDirectoryGrants();
      await expect(resolveWorkspace({} as never, tmpdir())).rejects.toMatchObject({ status: 403, code: "DIRECTORY_GRANT_REQUIRED" });
      await expect(resolveWorkspace({} as never, selected)).rejects.toThrow("请重新选择文件夹");
      const canonical = await authorizeManagedDirectory(join(selected, "..", "selected"));
      expect(await resolveWorkspace({} as never, selected)).toBe(canonical);
      clearManagedDirectoryGrants();
      await expect(resolveWorkspace({} as never, selected)).rejects.toMatchObject({ status: 403, code: "DIRECTORY_GRANT_REQUIRED" });
    } finally {
      clearManagedDirectoryGrants();
      if (previousManaged === undefined) delete process.env.JUGGLEWORK_MANAGED;
      else process.env.JUGGLEWORK_MANAGED = previousManaged;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("managed staged resources", () => {
  test("uses staged roots instead of writable data copies and records manifest inventory", async () => {
    const root = join(tmpdir(), `toonflow-managed-${crypto.randomUUID()}`);
    const dataDirectory = join(root, "data");
    const resourcesRoot = join(root, "staged");
    const files = ["server/index.js", "web/index.html", "tools/mediaGeneration.tool.js", "nodes/textNode.umd.js", "skills/canvas/SKILL.md"];
    try {
      await Promise.all(["tools", "nodes", "skills"].flatMap(directory => [
        mkdir(join(resourcesRoot, directory), { recursive: true }),
        mkdir(join(dataDirectory, directory), { recursive: true }),
      ]));
      const metadata = JSON.stringify({ name: "workspace", version: "1", displayName: "Managed probe", description: "", prompt: "", readme: "", components: [], author: "Toonfactory", github: "", configRules: [] });
      const webFetchMetadata = JSON.stringify({ name: "webFetch", version: "1", displayName: "Web fetch", description: "", prompt: "", readme: "", components: [], author: "Toonfactory", github: "", configRules: [] });
      await writeFile(join(resourcesRoot, "tools/workspace.tool.js"), `/*! toonflowTool:${metadata} */\nexport default { validateConfig: () => ({ source: "staged" }), createTools: () => [{ name: "stagedWorkspace", execute: () => null }] };`);
      await writeFile(join(resourcesRoot, "tools/webFetch.tool.js"), `/*! toonflowTool:${webFetchMetadata} */\nthrow new Error("managed webFetch imported");`);
      await writeFile(join(dataDirectory, "tools/workspace.tool.js"), `/*! toonflowTool:${metadata} */\nthrow new Error("writable data tool executed");`);
      await writeFile(join(resourcesRoot, "nodes/managedProbe.umd.js"), "/*! toonflowNode:{\"displayName\":\"Staged node\",\"configRules\":[]} */\n");
      await writeFile(join(dataDirectory, "nodes/managedProbe.umd.js"), "throw new Error('writable data node loaded');\n");
      await mkdir(join(resourcesRoot, "skills/managedProbe"), { recursive: true });
      await mkdir(join(dataDirectory, "skills/managedProbe"), { recursive: true });
      await writeFile(join(resourcesRoot, "skills/managedProbe/SKILL.md"), "---\nname: managedProbe\ndescription: staged skill\n---\nstaged\n");
      await writeFile(join(dataDirectory, "skills/managedProbe/SKILL.md"), "---\nname: managedProbe\ndescription: writable skill\n---\nwritable\n");
      await writeFile(join(resourcesRoot, "build-manifest.json"), JSON.stringify({ inventorySha256: "inventory-1", files: files.map(path => ({ path })) }));
      const result = await configureManagedResources({
        resourcesRoot,
        dataDirectory,
        toolsRoot: join(resourcesRoot, "tools"),
        nodesRoot: join(resourcesRoot, "nodes"),
        skillsRoot: join(resourcesRoot, "skills"),
        manifestPath: join(resourcesRoot, "build-manifest.json"),
        pluginRevision: "managed-test-v1",
      });
      const actualResourcesRoot = await realpath(resourcesRoot);
      expect(managedResourceDirectory("tools", join(dataDirectory, "tools"), true)).toBe(join(actualResourcesRoot, "tools"));
      expect(managedResourceDirectory("nodes", join(dataDirectory, "nodes"), true)).toBe(join(actualResourcesRoot, "nodes"));
      expect(managedResourceDirectory("skills", join(dataDirectory, "skills"), true)).toBe(join(actualResourcesRoot, "skills"));
      expect(result).toEqual({ pluginRevision: "managed-test-v1", inventorySha256: "inventory-1" });
      expect(managedToolConfig("mediaGeneration", { allowImage: true, allowVideo: true, allowAudio: true }, true)).toEqual({ allowImage: true, allowVideo: true, allowAudio: false });
      expect(managedToolConfig("skillOperator", { allowRead: true, allowCreate: true, allowUpdate: true }, true)).toEqual({ allowRead: true, allowCreate: false, allowUpdate: false });
      expect(managedBuiltInToolAllowed("webFetch", true)).toBe(false);
      expect(managedBuiltInToolAllowed("webFetch", false)).toBe(true);
      const previousManaged = process.env.JUGGLEWORK_MANAGED;
      const previousDataDirectory = process.env.TOONFLOW_DATA_DIR;
      process.env.JUGGLEWORK_MANAGED = "1";
      process.env.TOONFLOW_DATA_DIR = dataDirectory;
      try {
        const [{ listTools, loadTool, toolsDirectory }, agentTools, nodes, skills] = await Promise.all([
          import("../utils/plugins/tools"), import("../agent/tools"), import("../utils/plugins/nodes"), import("../utils/skills/files"),
        ]);
        expect(toolsDirectory).toBe(join(actualResourcesRoot, "tools"));
        expect((await listTools()).map(tool => tool.name)).toEqual(["workspace"]);
        expect((await loadTool("workspace")).plugin.validateConfig({})).toEqual({ source: "staged" });
        await expect(loadTool("webFetch")).rejects.toThrow("managed 模式不允许加载此工具");
        expect((await agentTools.createAgentTools(dataDirectory)).map(tool => tool.name)).toEqual(["probeVideo", "exportVideo", "stagedWorkspace"]);
        expect(agentTools.createAgentToolContext(dataDirectory).ffmpeg).toBeUndefined();
        expect((await nodes.readNode("managedProbe")).displayName).toBe("Staged node");
        expect(skills.directory()).toBe(join(actualResourcesRoot, "skills"));
        const location = await skills.locate("managedProbe");
        expect(await Bun.file(location.target).text()).toContain("staged skill");
      } finally {
        if (previousManaged === undefined) delete process.env.JUGGLEWORK_MANAGED;
        else process.env.JUGGLEWORK_MANAGED = previousManaged;
        if (previousDataDirectory === undefined) delete process.env.TOONFLOW_DATA_DIR;
        else process.env.TOONFLOW_DATA_DIR = previousDataDirectory;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a staged root inside writable data and incomplete manifests", async () => {
    const root = join(tmpdir(), `toonflow-managed-${crypto.randomUUID()}`);
    const dataDirectory = join(root, "data");
    const resourcesRoot = join(root, "staged");
    try {
      await Promise.all(["tools", "nodes", "skills"].map(directory => mkdir(join(resourcesRoot, directory), { recursive: true })));
      await mkdir(join(dataDirectory, "tools"), { recursive: true });
      await expect(configureManagedResources({
        resourcesRoot: dataDirectory,
        dataDirectory,
        toolsRoot: join(dataDirectory, "tools"),
        nodesRoot: join(resourcesRoot, "nodes"),
        skillsRoot: join(resourcesRoot, "skills"),
      })).rejects.toThrow("只读构建资源");
      await writeFile(join(resourcesRoot, "build-manifest.json"), JSON.stringify({ inventorySha256: "inventory-1", files: [{ path: "server/index.js" }] }));
      await expect(configureManagedResources({
        resourcesRoot,
        dataDirectory,
        toolsRoot: join(resourcesRoot, "tools"),
        nodesRoot: join(resourcesRoot, "nodes"),
        skillsRoot: join(resourcesRoot, "skills"),
        manifestPath: join(resourcesRoot, "build-manifest.json"),
      })).rejects.toThrow("缺少 web 目录");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not register generateAudio when the host exposes no audio model", async () => {
    const config = managedToolConfig("mediaGeneration", { allowImage: true, allowVideo: true, allowAudio: true }, true);
    const tools = await mediaGenerationPlugin.createTools({
      config,
      media: {
        listModels: async () => [{ providerId: "host", providerLabel: "Host", modelId: "video", label: "Video", type: "video", audio: false }],
        generateImage: async () => [], generateVideo: async () => [], generateAudio: async () => [],
      },
    } as never);
    expect(tools.map(tool => tool.name)).toEqual(["listMediaModels", "generateImage", "generateVideo"]);
  });
});
