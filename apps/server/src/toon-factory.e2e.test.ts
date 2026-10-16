import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOON_TEXT_OUTPUT_SCHEMAS, type ToonCanvas, type ToonMediaJob, type ToonProjectResponse } from "@jugglework/types/toon-factory";
import { Database } from "bun:sqlite";
import { automationSqliteAdapter } from "./automation/sqlite.js";
import { ToonMediaJobRepository } from "./toon-factory/media-job-repository.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createRoot(prefix = "jugglework-toon-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function startJuggleWorkServer(workspaceRoot: string, readOnly = false) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspaceRoot],
    readOnly,
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

async function jsonRequest(base: string, token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...auth(token), ...init.headers } });
  const body = await response.json() as Record<string, any>;
  return { response, body };
}

async function createProject(base: string, token: string, directory = "toons/demo"): Promise<ToonProjectResponse> {
  const { response, body } = await jsonRequest(base, token, "/workspace/ws_1/toon-factory/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Demo", directory }),
  });
  expect(response.status, JSON.stringify(body)).toBe(201);
  return body as ToonProjectResponse;
}

function canvas(projectId: string): ToonCanvas {
  return {
    schemaVersion: 1,
    id: "main",
    name: `${projectId} canvas`,
    nodes: [
      {
        id: "source",
        kind: "text",
        position: { x: 10, y: 20 },
        handles: [{ id: "output", direction: "source", dataType: "text" }],
        data: { contentRef: "content/nodes/source.md" },
      },
      {
        id: "target",
        kind: "storyboard",
        position: { x: 300, y: 20 },
        handles: [{ id: "input", direction: "target", dataType: "text" }],
        data: { contentRef: "content/nodes/target.md" },
      },
    ],
    edges: [{ id: "source-target", sourceNodeId: "source", sourceHandleId: "output", targetNodeId: "target", targetHandleId: "input" }],
    viewport: { x: 12, y: -8, zoom: 1.25 },
  };
}

async function simulateAtomicCrash(
  target: string,
  kind: "project" | "canvas" | "text",
  replacement: string,
  timestamp = Date.now(),
  transactionId = randomUUID(),
) {
  const stem = `${target}.jugglework-v1-${kind}-${timestamp}-${transactionId}`;
  const temporary = `${stem}.tmp`;
  const backup = `${stem}.bak`;
  await writeFile(temporary, replacement, "utf8");
  await rename(target, backup);
  return { backup, temporary, timestamp, transactionId };
}

describe("Toon Factory project routes", () => {
  test("creates the portable layout and reopens project, canvas, and external text", async () => {
    const root = await createRoot();
    let { base, token } = await startJuggleWorkServer(root);
    const created = await createProject(base, token);
    const projectId = created.project.id;

    for (const path of [
      "toon-project.json",
      "canvases/main.json",
      "content/nodes",
      "assets",
      "generations/manifests",
      "exports",
    ]) {
      expect(await Bun.file(join(root, "toons/demo", path)).exists() || (await readdir(join(root, "toons/demo", path))).length === 0).toBe(true);
    }

    const initialCanvas = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${projectId}/canvases/main`);
    expect(initialCanvas.response.status).toBe(200);
    const nextCanvas = canvas(projectId);
    const savedCanvas = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${projectId}/canvases/main`, {
      method: "PUT",
      body: JSON.stringify({ canvas: nextCanvas, expectedRevision: initialCanvas.body.revision }),
    });
    expect(savedCanvas.response.status).toBe(200);

    const savedText = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${projectId}/content/nodes/source`, {
      method: "PUT",
      body: JSON.stringify({ content: "# Episode script\n" }),
    });
    expect(savedText.response.status).toBe(200);
    expect(savedText.body.revision).toMatch(/^[a-f0-9]{64}$/);

    await stops.pop()?.();
    ({ base, token } = await startJuggleWorkServer(root));

    const list = await jsonRequest(base, token, "/workspace/ws_1/toon-factory/projects");
    expect(list.body.items).toEqual([expect.objectContaining({ id: projectId, directory: "toons/demo", episodeCount: 0 })]);
    const reopenedProject = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${projectId}`);
    const reopenedCanvas = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${projectId}/canvases/main`);
    const reopenedText = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${projectId}/content/nodes/source`);
    expect(reopenedProject.body.project).toEqual(created.project);
    expect(reopenedCanvas.body).toEqual(savedCanvas.body);
    expect(reopenedText.body).toEqual(savedText.body);
    expect((await readdir(join(root, "toons/demo/canvases"))).some((name) => name.includes(".tmp"))).toBe(false);
    expect((await readdir(join(root, "toons/demo/content/nodes"))).some((name) => name.includes(".tmp"))).toBe(false);
  });

  test("rejects stale SHA-256 revisions without overwriting current content", async () => {
    const root = await createRoot();
    const { base, token } = await startJuggleWorkServer(root);
    const created = await createProject(base, token);
    const path = `/workspace/ws_1/toon-factory/projects/${created.project.id}`;
    const updatedProject = { ...created.project, name: "Updated", updatedAt: new Date(Date.now() + 1_000).toISOString() };
    const first = await jsonRequest(base, token, path, {
      method: "PUT",
      body: JSON.stringify({ project: updatedProject, expectedRevision: created.revision }),
    });
    expect(first.response.status).toBe(200);

    const stale = await jsonRequest(base, token, path, {
      method: "PUT",
      body: JSON.stringify({ project: { ...updatedProject, name: "Stale overwrite" }, expectedRevision: created.revision }),
    });
    expect(stale.response.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "toon_factory_revision_conflict", details: { expectedRevision: created.revision, currentRevision: first.body.revision } });
    expect(JSON.parse(await readFile(join(root, "toons/demo/toon-project.json"), "utf8")).name).toBe("Updated");
  });

  test("read-only restart does not dispatch queued Toon jobs or change project files", async () => {
    const root = await createRoot();
    const runtimeDb = join(root, ".runtime", "runtime.sqlite");
    const previousRuntimeDb = process.env.JUGGLEWORK_RUNTIME_DB;
    process.env.JUGGLEWORK_RUNTIME_DB = runtimeDb;
    await mkdir(join(root, ".runtime"), { recursive: true });
    let { base, token } = await startJuggleWorkServer(root);
    const created = await createProject(base, token);
    await stops.pop()?.();
    const database = new Database(runtimeDb);
    database.run(`INSERT INTO toon_factory_text_jobs(
      id, workspace_id, project_id, episode_id, canvas_id, node_id, stage, action, provider_id,
      model_id, output_schema_json, request_snapshot_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`, [
      "text-job-read-only", "ws_1", created.project.id, "episode-1", "main", "script-node", "content-script", "script",
      "provider", "model", JSON.stringify(TOON_TEXT_OUTPUT_SCHEMAS.script), JSON.stringify({
        action: "script", prompt: "must not run", episodeId: "episode-1", canvasId: "main", nodeId: "script-node",
        stage: "content-script", selectedModel: { kind: "text", providerID: "provider", modelID: "model" },
        outputSchema: TOON_TEXT_OUTPUT_SCHEMAS.script, contentApproved: true, projectId: created.project.id,
      }), Date.now(), Date.now(),
    ]);
    database.close();
    const before = await stat(join(root, "toons/demo/toon-project.json"));
    ({ base, token } = await startJuggleWorkServer(root, true));
    const response = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}`);
    expect(response.response.status).toBe(200);
    await Bun.sleep(25);
    const after = await stat(join(root, "toons/demo/toon-project.json"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(join(root, "toons/demo/generations/manifests"))).toEqual([]);
    await stops.pop()?.();
    const verify = new Database(runtimeDb, { readonly: true });
    expect(verify.query("SELECT status FROM toon_factory_text_jobs WHERE id = ?").get("text-job-read-only")).toEqual({ status: "queued" });
    verify.close();
    if (previousRuntimeDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
    else process.env.JUGGLEWORK_RUNTIME_DB = previousRuntimeDb;
  });

  test("does not overwrite an external write in the final CAS publication window", async () => {
    const root = await createRoot();
    let replaceOnPublish = false;
    const repository = new (await import("./toon-factory/repository.js")).ToonFactoryRepository(root, {
      beforeAtomicPublish: async (path) => {
        if (!replaceOnPublish || !path.endsWith("source.md")) return;
        replaceOnPublish = false;
        const replacement = `${path}.external`;
        await writeFile(replacement, "external", "utf8");
        await rename(replacement, path);
      },
    });
    const created = await repository.createProject({ name: "Race", directory: "toons/race" });
    const first = await repository.writeText(created.project.id, "source", { content: "first" });
    replaceOnPublish = true;
    const result = repository.writeText(created.project.id, "source", { content: "stale", expectedRevision: first.revision });
    await expect(result).rejects.toMatchObject({ status: 409, code: "toon_factory_revision_conflict" });
    expect(await readFile(join(root, "toons/race/content/nodes/source.md"), "utf8")).toBe("external");
    expect((await readdir(join(root, "toons/race/content/nodes"))).some((name) => name.endsWith(".bak"))).toBe(true);
  });

  test("recovers project, canvas, and text after a crash between backup rename and publish", async () => {
    const root = await createRoot();
    const { ToonFactoryRepository } = await import("./toon-factory/repository.js");
    const repository = new ToonFactoryRepository(root);
    const created = await repository.createProject({ name: "Crash safe", directory: "toons/crash-safe" });
    const savedCanvas = await repository.writeCanvas(created.project.id, "main", {
      canvas: { ...canvas(created.project.id), name: "Before crash" },
    });
    const savedText = await repository.writeText(created.project.id, "source", { content: "before crash" });
    const projectPath = join(root, "toons/crash-safe/toon-project.json");
    const canvasPath = join(root, "toons/crash-safe/canvases/main.json");
    const textPath = join(root, "toons/crash-safe/content/nodes/source.md");

    await simulateAtomicCrash(projectPath, "project", `${JSON.stringify({ ...created.project, name: "Unpublished" })}\n`);
    await simulateAtomicCrash(canvasPath, "canvas", `${JSON.stringify({ ...savedCanvas.canvas, name: "Unpublished" })}\n`);
    await simulateAtomicCrash(textPath, "text", "unpublished");

    const reopened = new ToonFactoryRepository(root);
    expect((await reopened.listProjects()).items).toEqual([
      expect.objectContaining({ id: created.project.id, name: "Crash safe", directory: "toons/crash-safe" }),
    ]);
    expect((await reopened.readCanvas(created.project.id, "main")).canvas.name).toBe("Before crash");
    expect(await reopened.readText(created.project.id, "source")).toMatchObject({ content: "before crash", revision: savedText.revision });
    expect((await readdir(join(root, "toons/crash-safe"))).some((name) => name.includes(".jugglework-v1-"))).toBe(false);
    expect((await readdir(join(root, "toons/crash-safe/canvases"))).some((name) => name.includes(".jugglework-v1-"))).toBe(false);
    expect((await readdir(join(root, "toons/crash-safe/content/nodes"))).some((name) => name.includes(".jugglework-v1-"))).toBe(false);
  });

  test("does not recover malicious or symbolic-link atomic artifacts", async () => {
    const root = await createRoot();
    const outside = await createRoot("jugglework-toon-recovery-outside-");
    const { ToonFactoryRepository } = await import("./toon-factory/repository.js");
    const repository = new ToonFactoryRepository(root);
    const created = await repository.createProject({ name: "Unsafe", directory: "toons/unsafe" });
    const projectPath = join(root, "toons/unsafe/toon-project.json");
    const malicious = `${projectPath}.jugglework-not-our-protocol.bak`;
    await symlink(join(outside, "missing.json"), malicious);
    expect((await repository.listProjects()).items).toHaveLength(1);
    expect(await Bun.file(malicious).exists()).toBe(false);

    const transactionId = randomUUID();
    const stem = `${projectPath}.jugglework-v1-project-${Date.now()}-${transactionId}`;
    await writeFile(join(outside, "project.json"), `${JSON.stringify(created.project)}\n`, "utf8");
    await writeFile(`${stem}.tmp`, `${JSON.stringify(created.project)}\n`, "utf8");
    await unlink(projectPath);
    await symlink(join(outside, "project.json"), `${stem}.bak`);
    await expect(new ToonFactoryRepository(root).listProjects()).rejects.toMatchObject({ code: "path_escape" });
    expect(await Bun.file(projectPath).exists()).toBe(false);
  });

  test("fails recovery safely when backup protocol metadata and mtime are ambiguous", async () => {
    const root = await createRoot();
    const { ToonFactoryRepository } = await import("./toon-factory/repository.js");
    const repository = new ToonFactoryRepository(root);
    const created = await repository.createProject({ name: "Ambiguous", directory: "toons/ambiguous" });
    const projectPath = join(root, "toons/ambiguous/toon-project.json");
    const timestamp = Date.now();
    const first = await simulateAtomicCrash(projectPath, "project", `${JSON.stringify({ ...created.project, name: "First candidate" })}\n`, timestamp);
    const secondId = randomUUID();
    const secondStem = `${projectPath}.jugglework-v1-project-${timestamp}-${secondId}`;
    await copyFile(first.backup, `${secondStem}.bak`);
    await writeFile(`${secondStem}.tmp`, `${JSON.stringify({ ...created.project, name: "Second candidate" })}\n`, "utf8");
    const identicalMtime = new Date(timestamp);
    await utimes(first.backup, identicalMtime, identicalMtime);
    await utimes(`${secondStem}.bak`, identicalMtime, identicalMtime);

    await expect(new ToonFactoryRepository(root).listProjects()).rejects.toMatchObject({
      status: 409,
      code: "toon_factory_recovery_conflict",
      message: "Ambiguous Toon Factory backups require manual recovery",
    });
    expect(await Bun.file(projectPath).exists()).toBe(false);
  });

  test("persists selected model references with project revision checks", async () => {
    const root = await createRoot();
    const { base, token } = await startJuggleWorkServer(root);
    const created = await createProject(base, token);
    const selectedModels = {
      text: { kind: "text", providerID: "text-provider", modelID: "text-model" },
      image: { kind: "image", providerID: "image-provider", modelID: "image-model" },
      video: { kind: "video", providerID: "video-provider", modelID: "video-model" },
    } as const;
    const saved = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}`, {
      method: "PUT",
      body: JSON.stringify({
        project: { ...created.project, selectedModels, updatedAt: new Date(Date.now() + 1_000).toISOString() },
        expectedRevision: created.revision,
      }),
    });

    expect(saved.response.status).toBe(200);
    expect(saved.body.project.selectedModels).toEqual(selectedModels);
    expect(saved.body.revision).not.toBe(created.revision);
    expect(JSON.parse(await readFile(join(root, "toons/demo/toon-project.json"), "utf8")).selectedModels).toEqual(selectedModels);
  });

  test("persists text jobs and exposes scoped create, get, and cancel APIs", async () => {
    const root = await createRoot();
    const { base, token } = await startJuggleWorkServer(root);
    const created = await createProject(base, token);
    const now = new Date().toISOString();
    const project = {
      ...created.project,
      selectedModels: { text: { kind: "text" as const, providerID: "missing-provider", modelID: "missing-model" } },
      episodes: [{
        id: "episode-1", title: "Episode 1", ordinal: 1, canvasId: "main",
        stages: [{ stage: "content-script" as const, status: "pending-confirmation" as const, updatedAt: now }],
        steps: [{ id: "episode-script", stage: "content-script" as const, title: "Script", status: "pending-confirmation" as const, dependencies: [], contentApprovals: [], computeAuthorizations: [], resultAdoptions: [], history: [], updatedAt: now }],
        createdAt: now, updatedAt: now,
      }],
      updatedAt: now,
    };
    const saved = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}`, {
      method: "PUT", body: JSON.stringify({ project, expectedRevision: created.revision }),
    });
    expect(saved.response.status).toBe(200);
    const initialCanvas = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/canvases/main`);
    const withNode = {
      ...initialCanvas.body.canvas,
      nodes: [{ id: "script-node", kind: "text", position: { x: 0, y: 0 }, handles: [], data: { contentRef: "content/nodes/script-node.md" } }],
    };
    expect((await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/canvases/main`, {
      method: "PUT", body: JSON.stringify({ canvas: withNode, expectedRevision: initialCanvas.body.revision }),
    })).response.status).toBe(200);

    const bypassedWorkflow = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/text-jobs`, {
      method: "POST",
      body: JSON.stringify({
        action: "script", prompt: "Paid later-stage request", episodeId: "episode-1", canvasId: "main", nodeId: "script-node",
        stage: "assets", selectedModel: project.selectedModels.text,
        outputSchema: TOON_TEXT_OUTPUT_SCHEMAS.script, contentApproved: true,
      }),
    });
    expect(bypassedWorkflow.response.status).toBe(409);
    expect(bypassedWorkflow.body.code).toBe("workflow_prerequisite_incomplete");

    const bypassedMedia = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/media-jobs/authorize`, {
      method: "POST",
      body: JSON.stringify({
        requestId: "paid-bypass", episodeId: "episode-1", canvasId: "main", nodeId: "script-node", stepId: "video-clips",
        plan: { kind: "video", model: { kind: "video", providerID: "p", modelID: "m" }, object: "clip", quantity: 1, prompt: "paid", referencePaths: [], referenceScope: "workspace", executionCount: 1, knownCost: null, mode: "text-to-video", durationSeconds: 5, resolution: "720p" },
      }),
    });
    expect(bypassedMedia.response.status).toBe(409);
    expect(bypassedMedia.body.code).toBe("workflow_prerequisite_incomplete");
    const bypassedMediaCreate = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/media-jobs`, {
      method: "POST",
      body: JSON.stringify({
        requestId: "paid-bypass-create", episodeId: "episode-1", canvasId: "main", nodeId: "script-node", stepId: "image-candidates",
        plan: { kind: "image", model: { kind: "image", providerID: "p", modelID: "m" }, object: "image", quantity: 1, prompt: "paid", referencePaths: [], referenceScope: "workspace", executionCount: 1, knownCost: null, mode: "text-to-image", size: "1024x1024" },
        authorization: { id: "forged-authorization", scopeHash: "a".repeat(64), authorizedAt: now },
      }),
    });
    expect(bypassedMediaCreate.response.status).toBe(409);
    expect(bypassedMediaCreate.body.code).toBe("workflow_prerequisite_incomplete");

    const createdJob = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/text-jobs`, {
      method: "POST",
      body: JSON.stringify({
        action: "script", prompt: "Write a pilot", episodeId: "episode-1", canvasId: "main", nodeId: "script-node",
        stage: "content-script", selectedModel: project.selectedModels.text,
        outputSchema: TOON_TEXT_OUTPUT_SCHEMAS.script, contentApproved: true,
      }),
    });
    expect(createdJob.response.status).toBe(202);
    const jobId = createdJob.body.job.id as string;
    const readJob = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/text-jobs/${jobId}`);
    expect(readJob.response.status).toBe(200);
    expect(readJob.body.job.requestSnapshot).toMatchObject({ projectId: created.project.id, prompt: "Write a pilot" });
    expect(readJob.body.job.selectedModel).toEqual(project.selectedModels.text);
    expect(JSON.stringify(readJob.body)).not.toMatch(/apiKey|password|secret/i);

    const cancelled = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/text-jobs/${jobId}/cancel`, { method: "POST" });
    expect(cancelled.response.status).toBe(202);
    expect(["cancelled", "failed"]).toContain(cancelled.body.job.status);
    expect((await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/text-jobs/${jobId}`)).body.job.id).toBe(jobId);

    const wrongSchema = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/text-jobs`, {
      method: "POST",
      body: JSON.stringify({
        action: "script", prompt: "Write", episodeId: "episode-1", canvasId: "main", nodeId: "script-node",
        stage: "content-script", selectedModel: project.selectedModels.text,
        outputSchema: { type: "object" }, contentApproved: true,
      }),
    });
    expect(wrongSchema.response.status).toBe(400);
    expect(wrongSchema.body.code).toBe("toon_text_schema_mismatch");
  });

  test("exposes the safe mode-scoped model facade and validates modes", async () => {
    const root = await createRoot();
    const { base, token } = await startJuggleWorkServer(root);
    const models = await jsonRequest(base, token, "/workspace/ws_1/toon-factory/models?imageMode=text-to-image&videoMode=image-to-video");
    expect(models.response.status, JSON.stringify(models.body)).toBe(200);
    expect(models.body).toEqual({
      image: { mode: "text-to-image", models: [] },
      video: { mode: "image-to-video", submissionEnabled: false, blockingReason: "no_video_model_available", models: [] },
    });
    expect(JSON.stringify(models.body)).not.toMatch(/apiKey|baseURL|envKeys|credential/i);

    const invalid = await jsonRequest(base, token, "/workspace/ws_1/toon-factory/models?imageMode=invalid&videoMode=text-to-video");
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.code).toBe("invalid_toon_image_mode");
  });

  test("rejects traversal and symlink escapes", async () => {
    const root = await createRoot();
    const outside = await createRoot("jugglework-toon-outside-");
    const { base, token } = await startJuggleWorkServer(root);

    for (const directory of ["../outside", "C:/outside", "toons//outside"]) {
      const traversal = await jsonRequest(base, token, "/workspace/ws_1/toon-factory/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Escape", directory }),
      });
      expect(traversal.response.status).toBe(400);
    }

    await symlink(outside, join(root, "linked"), "dir");
    const linked = await jsonRequest(base, token, "/workspace/ws_1/toon-factory/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Escape", directory: "linked/project" }),
    });
    expect(linked.response.status).toBe(400);
    expect(linked.body.code).toBe("path_escape");
    expect(await readdir(outside)).toEqual([]);

    const created = await createProject(base, token, "safe-project");
    await symlink(join(outside, "stolen.md"), join(root, "safe-project/content/nodes/linked.md"));
    await writeFile(join(outside, "stolen.md"), "outside", "utf8");
    const readLinked = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/content/nodes/linked`);
    expect(readLinked.response.status).toBe(400);
    expect(readLinked.body.code).toBe("path_escape");
    const writeLinked = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/content/nodes/linked`, {
      method: "PUT",
      body: JSON.stringify({ content: "overwrite" }),
    });
    expect(writeLinked.response.status).toBe(400);
    expect(writeLinked.body.code).toBe("path_escape");
    expect(await readFile(join(outside, "stolen.md"), "utf8")).toBe("outside");
  });

  test("fails safely for unsupported project and canvas versions", async () => {
    const root = await createRoot();
    const { base, token } = await startJuggleWorkServer(root);
    const created = await createProject(base, token);
    const projectFile = join(root, "toons/demo/toon-project.json");
    const unsupported = { ...created.project, schemaVersion: 99 };
    await writeFile(projectFile, `${JSON.stringify(unsupported, null, 2)}\n`, "utf8");
    const readUnsupported = await jsonRequest(base, token, "/workspace/ws_1/toon-factory/projects");
    expect(readUnsupported.response.status).toBe(422);
    expect(readUnsupported.body.code).toBe("toon_factory_unsupported_version");
    expect(JSON.parse(await readFile(projectFile, "utf8")).schemaVersion).toBe(99);

    await writeFile(projectFile, `${JSON.stringify(created.project, null, 2)}\n`, "utf8");
    const canvasFile = join(root, "toons/demo/canvases/main.json");
    await writeFile(canvasFile, JSON.stringify({ ...canvas(created.project.id), schemaVersion: 99 }), "utf8");
    const canvasEndpoint = `/workspace/ws_1/toon-factory/projects/${created.project.id}/canvases/main`;
    const canvasResponse = await jsonRequest(base, token, canvasEndpoint);
    expect(canvasResponse.response.status).toBe(422);
    expect(canvasResponse.body.code).toBe("toon_factory_unsupported_version");
    const overwriteUnsupported = await jsonRequest(base, token, canvasEndpoint, {
      method: "PUT",
      body: JSON.stringify({ canvas: canvas(created.project.id) }),
    });
    expect(overwriteUnsupported.response.status).toBe(422);
    expect(overwriteUnsupported.body.code).toBe("toon_factory_unsupported_version");
    expect(JSON.parse(await readFile(canvasFile, "utf8")).schemaVersion).toBe(99);
  });

  test("serializes concurrent canvas writes and preserves external text on revision conflict", async () => {
    const root = await createRoot();
    const { base, token } = await startJuggleWorkServer(root);
    const created = await createProject(base, token);
    const projectId = created.project.id;
    const canvasEndpoint = `/workspace/ws_1/toon-factory/projects/${projectId}/canvases/main`;
    const initial = await jsonRequest(base, token, canvasEndpoint);
    const writes = await Promise.all([
      jsonRequest(base, token, canvasEndpoint, {
        method: "PUT",
        body: JSON.stringify({ canvas: { ...canvas(projectId), name: "First" }, expectedRevision: initial.body.revision }),
      }),
      jsonRequest(base, token, canvasEndpoint, {
        method: "PUT",
        body: JSON.stringify({ canvas: { ...canvas(projectId), name: "Second" }, expectedRevision: initial.body.revision }),
      }),
    ]);
    expect(writes.map(({ response }) => response.status).sort()).toEqual([200, 409]);
    const winner = writes.find(({ response }) => response.status === 200)!;
    expect((await jsonRequest(base, token, canvasEndpoint)).body).toEqual(winner.body);
    expect((await readdir(join(root, "toons/demo/canvases"))).some((name) => name.includes(".tmp"))).toBe(false);

    const textEndpoint = `/workspace/ws_1/toon-factory/projects/${projectId}/content/nodes/source`;
    const firstText = await jsonRequest(base, token, textEndpoint, {
      method: "PUT",
      body: JSON.stringify({ content: "first" }),
    });
    const textFile = join(root, "toons/demo/content/nodes/source.md");
    await writeFile(textFile, "external", "utf8");
    const staleText = await jsonRequest(base, token, textEndpoint, {
      method: "PUT",
      body: JSON.stringify({ content: "stale", expectedRevision: firstText.body.revision }),
    });
    expect(staleText.response.status).toBe(409);
    expect(staleText.body.code).toBe("toon_factory_revision_conflict");
    expect(await readFile(textFile, "utf8")).toBe("external");

    const missingEndpoint = `/workspace/ws_1/toon-factory/projects/${projectId}/content/nodes/new-node`;
    const missing = await jsonRequest(base, token, missingEndpoint);
    expect(missing.response.status).toBe(404);
    await writeFile(join(root, "toons/demo/content/nodes/new-node.md"), "created externally", "utf8");
    const firstWriteConflict = await jsonRequest(base, token, missingEndpoint, {
      method: "PUT",
      body: JSON.stringify({ content: "stale first write", expectedRevision: null }),
    });
    expect(firstWriteConflict.response.status).toBe(409);
    expect(await readFile(join(root, "toons/demo/content/nodes/new-node.md"), "utf8")).toBe("created externally");
  });

  test("rejects missing, wrong-direction, and incompatible edge handles", async () => {
    const root = await createRoot();
    const { base, token } = await startJuggleWorkServer(root);
    const created = await createProject(base, token);
    const endpoint = `/workspace/ws_1/toon-factory/projects/${created.project.id}/canvases/main`;
    const initial = await jsonRequest(base, token, endpoint);

    for (const invalid of [
      { ...canvas(created.project.id), edges: [{ id: "bad", sourceNodeId: "missing", sourceHandleId: "output", targetNodeId: "target", targetHandleId: "input" }] },
      { ...canvas(created.project.id), edges: [{ id: "bad", sourceNodeId: "source", sourceHandleId: "missing", targetNodeId: "target", targetHandleId: "input" }] },
      {
        ...canvas(created.project.id),
        nodes: canvas(created.project.id).nodes.map((node) => node.id === "target" ? { ...node, handles: [{ id: "input", direction: "target" as const, dataType: "video" as const }] } : node),
      },
      { ...canvas(created.project.id), nodes: [canvas(created.project.id).nodes[0]!, canvas(created.project.id).nodes[0]!] },
      { ...canvas(created.project.id), viewport: { x: 0, y: 0, zoom: 0 } },
    ]) {
      const response = await jsonRequest(base, token, endpoint, {
        method: "PUT",
        body: JSON.stringify({ canvas: invalid, expectedRevision: initial.body.revision }),
      });
      expect(response.response.status).toBe(400);
      expect(response.body.code).toBe("invalid_toon_canvas");
      expect(response.body.details.issues[0].path[0]).toBe("canvas");
    }
    expect((await jsonRequest(base, token, endpoint)).body).toEqual(initial.body);
  });

  test("creates, reads, lists, and safely downloads persisted episode delivery manifests", async () => {
    const root = await createRoot();
    const runtimeDb = join(root, ".runtime", "runtime.sqlite");
    const previousRuntimeDb = process.env.JUGGLEWORK_RUNTIME_DB;
    process.env.JUGGLEWORK_RUNTIME_DB = runtimeDb;
    try {
      const { base, token } = await startJuggleWorkServer(root);
      const created = await createProject(base, token);
      const now = "2026-10-17T10:00:00.000Z";
      const project = {
        ...created.project,
        episodes: [{
          id: "episode-1", title: "Episode 1", ordinal: 1, canvasId: "main",
          stages: [{ stage: "videos" as const, status: "adopted" as const, updatedAt: now }],
          steps: [{ id: "video-clips", stage: "videos" as const, title: "Clips", status: "adopted" as const, dependencies: [], contentApprovals: [], computeAuthorizations: [], resultAdoptions: [{ id: "adoption-1", resultId: "candidate-1", artifactPath: "artifacts/clip.mp4", artifactScope: "workspace" as const, adoptedAt: now }], history: [], updatedAt: now }],
          createdAt: now, updatedAt: now,
        }],
        updatedAt: now,
      };
      expect((await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}`, { method: "PUT", body: JSON.stringify({ project, expectedRevision: created.revision }) })).response.status).toBe(200);
      await mkdir(join(root, "artifacts"), { recursive: true });
      const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(8)]);
      await writeFile(join(root, "artifacts/clip.mp4"), mp4);

      const database = new Database(runtimeDb);
      const jobs = ToonMediaJobRepository.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite: database, db: null as never, close: () => database.close() }));
      const job: ToonMediaJob = {
        schemaVersion: 1, id: "media-job-delivery", workspaceId: "ws_1", projectId: created.project.id, episodeId: "episode-1", canvasId: "main", nodeId: "video-node", stepId: "video-clips", kind: "video",
        requestSnapshot: { requestId: "request-delivery", projectId: created.project.id, episodeId: "episode-1", canvasId: "main", nodeId: "video-node", stepId: "video-clips", plan: { kind: "video", model: { kind: "video", providerID: "provider", modelID: "model" }, object: "clip", quantity: 1, prompt: "clip prompt", referencePaths: [], referenceScope: "workspace", executionCount: 1, knownCost: null, mode: "text-to-video", durationSeconds: 5, resolution: "720p" } },
        requestHash: "a".repeat(64), authorization: { id: "authorization-delivery", scopeHash: "a".repeat(64), authorizedAt: now }, status: "adopted",
        candidates: [{ id: "candidate-1", ordinal: 1, status: "adopted", runtime: "media-generation", artifact: { scope: "workspace", path: "artifacts/clip.mp4", mimeType: "video/mp4", bytes: mp4.length }, provenance: { model: { kind: "video", providerID: "provider", modelID: "model" }, prompt: "clip prompt", mode: "text-to-video", referencePaths: [], referenceScope: "workspace", parameters: { durationSeconds: 5, resolution: "720p" } }, review: { decision: "adopted", reviewedAt: now }, createdAt: now, updatedAt: now }],
        createdAt: now, updatedAt: now,
      };
      database.run("INSERT INTO toon_factory_media_jobs (id, workspace_id, project_id, request_id, request_hash, job_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [job.id, job.workspaceId, job.projectId, job.requestSnapshot.requestId, job.requestHash, JSON.stringify(job), Date.now(), Date.now()]);
      jobs.close();

      const endpoint = `/workspace/ws_1/toon-factory/projects/${created.project.id}/episodes/episode-1/delivery-manifest`;
      const generated = await jsonRequest(base, token, endpoint, { method: "POST", body: JSON.stringify({ expectedRevision: null }) });
      expect(generated.response.status, JSON.stringify(generated.body)).toBe(201);
      expect(generated.body.path).toBe("toons/demo/exports/episodes/episode-1/delivery-manifest.json");
      expect(generated.body.manifest.artifacts).toEqual([expect.objectContaining({ id: "adoption-1", path: "artifacts/clip.mp4" })]);
      expect((await jsonRequest(base, token, endpoint)).body).toEqual(generated.body);
      const listed = await jsonRequest(base, token, `/workspace/ws_1/toon-factory/projects/${created.project.id}/delivery-manifests`);
      expect(listed.body.items).toEqual([generated.body]);

      const artifact = await fetch(`${base}/workspace/ws_1/toon-factory/projects/${created.project.id}/episodes/episode-1/delivery-artifacts/adoption-1`, { headers: { Authorization: `Bearer ${token}` } });
      expect(artifact.status).toBe(200);
      expect(artifact.headers.get("content-type")).toBe("video/mp4");
      expect(Buffer.from(await artifact.arrayBuffer())).toEqual(mp4);
      const unlisted = await fetch(`${base}/workspace/ws_1/toon-factory/projects/${created.project.id}/episodes/episode-1/delivery-artifacts/candidate-1`, { headers: { Authorization: `Bearer ${token}` } });
      expect(unlisted.status).toBe(404);
      const manifestDownload = await fetch(`${base}${endpoint}/download`, { headers: { Authorization: `Bearer ${token}` } });
      expect(manifestDownload.status).toBe(200);
      expect(manifestDownload.headers.get("content-disposition")).toContain("episode-1-delivery-manifest.json");
      expect((await manifestDownload.json()).deliveryType).toBe("adopted-media-and-manifest");
    } finally {
      if (previousRuntimeDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
      else process.env.JUGGLEWORK_RUNTIME_DB = previousRuntimeDb;
    }
  });
});
