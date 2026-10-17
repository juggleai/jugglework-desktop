import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { completeToonWorkspaceClientCommand, type ToonWorkspaceClientCommand } from "@jugglework/types/toon-workspace";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function request(base: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: "Bearer owt_test_token", "Content-Type": "application/json", ...init.headers },
  });
  return { response, body: await response.json() as Record<string, any> };
}

async function upload(base: string, path: string, metadata: Record<string, unknown>, body: Uint8Array) {
  const payload = new Uint8Array(body.byteLength);
  payload.set(body);
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer owt_test_token",
      "Content-Type": "application/octet-stream",
      "X-JuggleWork-Toon-Asset": encodeURIComponent(JSON.stringify(metadata)),
    },
    body: payload.buffer,
  });
  return { response, body: await response.json() as Record<string, any> };
}

async function appCommand(base: string, projectId: string, command: ToonWorkspaceClientCommand) {
  const catalogs = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "catalogs.read" }) });
  const canvasIds = command.kind === "canvas.write" ? [command.canvasId] : command.kind === "asset.delete" && command.replacementAssetId ? catalogs.body.canvases.canvases.map((canvas: any) => canvas.id) : [];
  const canvasReads = await Promise.all(canvasIds.map((canvasId: string) => request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "canvas.read", canvasId }) })));
  const canvases = Object.fromEntries(canvasReads.map((response) => [response.body.descriptor.file, response.body.canvas]));
  return request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/commands`, {
    method: "POST",
    body: JSON.stringify(completeToonWorkspaceClientCommand(command, catalogs.body as any, { canvases })),
  });
}

test("v2 workspace routes expose typed initialize, list, command, read, and export APIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "toon-workspace-routes-"));
  roots.push(root);
  const previousDb = process.env.JUGGLEWORK_RUNTIME_DB;
  process.env.JUGGLEWORK_RUNTIME_DB = join(root, ".runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "owt_test_token", hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1_000 }, corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config);
  stops.push(async () => {
    await server.stop();
    if (previousDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
    else process.env.JUGGLEWORK_RUNTIME_DB = previousDb;
  });
  const base = `http://127.0.0.1:${server.port}`;
  const features = await request(base, "/workspace/ws_1/toon-factory/workspace-features");
  expect(features.body).toEqual({ advancedWorkspace: true, v2Read: true, v2Export: true, automaticDowngrade: false, toonflowImport: "disabled" });
  const initialized = await request(base, "/workspace/ws_1/toon-factory/v2/projects/initialize", {
    method: "POST", body: JSON.stringify({ operationId: "route-init", name: "Route Project", directory: "routes/project", episodeId: "home-episode" }),
  });
  expect(initialized.response.status).toBe(201);
  const projectId = "toon-route-init";
  const initializedProject = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "project.read" }) });
  expect(initializedProject.body.project.workflow.episodes[0]).toMatchObject({ id: "home-episode", canvasId: "main" });
  expect(initializedProject.body.project.workflow.episodes[0].stages.map((stage: any) => stage.stage)).toEqual(["content-script", "assets", "directing-storyboard", "images", "videos", "adoption-delivery"]);
  expect(initializedProject.body.project.workflow.episodes[0].steps.map((step: any) => step.id)).toEqual(["source-material", "episode-script", "asset-plan", "direction", "storyboard", "image-candidates", "video-clips", "adopt-clips", "delivery-manifest"]);
  const initialCatalogs = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "catalogs.read" }) });
  const spoofedActor = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/commands`, {
    method: "POST", body: JSON.stringify({ operationId: "route-spoof", actor: { kind: "system" }, expectedRevisions: {}, kind: "project.update", name: "Spoofed" }),
  });
  expect(spoofedActor.response.status).toBe(400);
  const base64Import = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/commands`, {
    method: "POST", body: JSON.stringify({ operationId: "route-base64-asset", expectedRevisions: {}, kind: "asset.import", assetId: "base64-asset", filename: "base64.png", declaredMimeType: "image/png", assetOrigin: "imported", contentBase64: "iVBORw0KGgo=" }),
  });
  expect(base64Import.response.status).toBe(403);
  const command = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/commands`, {
    method: "POST", body: JSON.stringify({ operationId: "route-folder", expectedRevisions: { "toon-project.json": initialCatalogs.body.revisions["toon-project.json"], "catalogs/canvases.json": initialCatalogs.body.revisions["catalogs/canvases.json"] }, kind: "folder.create", folder: { id: "folder", title: "Folder", order: 0, state: "active" } }),
  });
  expect(command.response.status).toBe(200);
  const listed = await request(base, "/workspace/ws_1/toon-factory/v2/projects");
  expect(listed.body.items).toEqual([expect.objectContaining({ projectId, name: "Route Project", directory: "routes/project", updatedAt: expect.any(String) })]);
  const opened = await request(base, "/workspace/ws_1/toon-factory/v2/projects/open", { method: "POST", body: JSON.stringify({ directory: "routes/project" }) });
  expect(opened.body).toMatchObject({ imported: false, project: { projectId, directory: "routes/project" } });
  const queried = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "catalogs.read" }) });
  expect(queried.body.canvases.folders[0].id).toBe("folder");
  const png = new Uint8Array(24); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); new DataView(png.buffer).setUint32(16, 12); new DataView(png.buffer).setUint32(20, 8);
  const canvasBeforeImport = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "canvas.read", canvasId: "main" }) });
  const uploaded = await upload(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/assets/upload`, { operationId: "route-asset", assetId: "route-asset", filename: "route.png", declaredMimeType: "image/png", origin: "imported", canvas: { id: "main", expectedRevision: canvasBeforeImport.body.revision, position: { x: 20, y: 30 } } }, png);
  expect(uploaded.response.status).toBe(201);
  expect(uploaded.body.result).toMatchObject({ asset: { id: "route-asset", width: 12, height: 8 }, nodeId: "route-asset-node" });
  const deletedAsset = await appCommand(base, projectId, { operationId: "route-asset-delete", expectedRevisions: {}, kind: "asset.delete", assetId: "route-asset", destructive: true });
  expect(deletedAsset.response.status).toBe(200);
  const trashedAsset = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "asset.read", assetId: "route-asset" }) });
  const trashPath = trashedAsset.body.asset.trashPath as string;
  expect(trashedAsset.body).toMatchObject({ asset: { state: "trashed", trashPath: expect.any(String) } });
  expect(trashedAsset.body.revisions[trashPath]).toEqual(expect.any(String));
  const restoredAsset = await appCommand(base, projectId, { operationId: "route-asset-restore", expectedRevisions: {}, kind: "asset.restore", assetId: "route-asset" });
  expect(restoredAsset.response.status).toBe(200);
  expect((await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "asset.read", assetId: "route-asset" }) })).body.asset.state).toBe("active");
  const preview = await fetch(`${base}/workspace/ws_1/toon-factory/v2/projects/${projectId}/assets/route-asset/preview`, { headers: { Authorization: "Bearer owt_test_token" } });
  expect(preview.headers.get("content-type")).toBe("image/png");
  expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await preview.arrayBuffer())).toEqual(png);
  const outside = await mkdtemp(join(tmpdir(), "toon-upload-outside-"));
  roots.push(outside);
  await rm(join(root, ".toon-upload-staging"), { recursive: true, force: true });
  await symlink(outside, join(root, ".toon-upload-staging"), "dir");
  const escapedUpload = await upload(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/assets/upload`, { operationId: "route-asset-escape", assetId: "route-asset-escape", filename: "escape.png", declaredMimeType: "image/png", origin: "imported" }, png);
  expect(escapedUpload.response.status).toBe(400);
  expect(escapedUpload.body.code).toBe("path_escape");
  expect(await readdir(outside)).toEqual([]);
  const exported = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/export`);
  expect(exported.body.project.metadata.id).toBe(projectId);
  expect(JSON.stringify(exported.body)).not.toMatch(/sessionId|runtimeId|sqliteId|apiKey|credential/i);
  const canvas = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "canvas.read", canvasId: "main" }) });
  const lease = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/canvases/main/lease`, { method: "POST", body: JSON.stringify({ leaseId: "route-editor", holder: "route-test", ttlMs: 5_000 }) });
  if (typeof lease.body.leaseToken !== "string") throw new Error(JSON.stringify(lease.body));
  const leaseToken = lease.body.leaseToken;
  expect(lease.body).toMatchObject({ leaseId: "route-editor", canvasId: "main", leaseToken: expect.any(String), generation: 1 });
  const checkpoint = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/canvases/main/checkpoints`, { method: "POST", body: JSON.stringify({ operationId: "route-checkpoint", expectedRevision: canvas.body.revision, title: "Route checkpoint", actor: { kind: "human" }, origin: "human-ui" }) });
  expect(checkpoint.response.status).toBe(201);
  const history = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/canvases/main/checkpoints`);
  expect(history.body.items).toHaveLength(1);
  const documentCreated = await appCommand(base, projectId, { operationId: "route-document-create", expectedRevisions: {}, kind: "document.create", document: { id: "route-script", title: "Route script", path: "documents/route-script.md", kind: "markdown", mimeType: "text/markdown", state: "active" }, content: "first" });
  expect(documentCreated.response.status).toBe(200);
  const documentBeforeWrite = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "document.read", documentId: "route-script" }) });
  expect(documentBeforeWrite.body.revisions).toMatchObject({ "toon-project.json": expect.any(String), "catalogs/documents.json": expect.any(String), "documents/route-script.md": documentBeforeWrite.body.revision });
  const documentWritten = await appCommand(base, projectId, { operationId: "route-document-write", expectedRevisions: { "documents/route-script.md": documentBeforeWrite.body.revision }, kind: "document.write", documentId: "route-script", content: "second" });
  expect(documentWritten.response.status).toBe(200);
  expect((await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "document.read", documentId: "route-script" }) })).body.content).toBe("second");
  const configuredCanvas = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "canvas.read", canvasId: "main" }) });
  const configuredCatalogs = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "catalogs.read" }) });
  expect(configuredCatalogs.body.revisions).toMatchObject({ "toon-project.json": expect.any(String), "catalogs/canvases.json": expect.any(String), "catalogs/assets.json": expect.any(String), "canvases/main.json": configuredCanvas.body.revision });
  const canvasBody = { ...configuredCanvas.body.canvas, nodes: [{ id: "source-text", kind: "text", position: { x: 0, y: 0 }, handles: [], config: { label: "Production source text" } }, { id: "image-node", kind: "image-generation", position: { x: 320, y: 0 }, handles: [], config: {} }] };
  const missingCanvasCas = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/commands`, { method: "POST", body: JSON.stringify({ operationId: "route-generation-node-missing-cas", expectedRevisions: { "canvases/main.json": configuredCanvas.body.revision }, kind: "canvas.write", canvasId: "main", body: canvasBody, leaseToken, leaseGeneration: lease.body.generation }) });
  expect(missingCanvasCas.response.status).toBe(400);
  expect(missingCanvasCas.body).toMatchObject({ code: "toon_expected_revision_required", details: { paths: expect.arrayContaining(["toon-project.json", "catalogs/canvases.json"]) } });
  const generationNode = await appCommand(base, projectId, { operationId: "route-generation-node", expectedRevisions: { "canvases/main.json": configuredCanvas.body.revision }, kind: "canvas.write", canvasId: "main", body: canvasBody, leaseToken, leaseGeneration: lease.body.generation });
  expect(generationNode.response.status).toBe(200);
  expect((await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/canvases/main/lease/route-editor`, { method: "DELETE" })).body).toEqual({ released: true });
  const projectBeforeWorkflow = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "project.read" }) });
  const projectPath = join(root, "routes/project/toon-project.json");
  const protectedTruthBefore = await readFile(projectPath);
  const now = "2026-01-01T00:00:00.000Z";
  const forgedWorkflow = projectBeforeWorkflow.body.project.workflow.episodes;
  for (const bypass of [
    { operationId: "route-workflow", expectedRevisions: { "toon-project.json": projectBeforeWorkflow.body.revision }, kind: "workflow.configure", episodes: forgedWorkflow },
    { operationId: "route-invalidate", expectedRevisions: { "toon-project.json": projectBeforeWorkflow.body.revision }, kind: "workflow.invalidate", targets: [{ kind: "canvas", id: "main" }], reason: "forged" },
    { operationId: "route-project-bypass", expectedRevisions: { "toon-project.json": projectBeforeWorkflow.body.revision }, kind: "generation.project", generationId: "generation-route", status: "adopted", candidates: [] },
    { operationId: "route-approve-bypass", expectedRevisions: { "toon-project.json": projectBeforeWorkflow.body.revision }, kind: "workflow.approve", workflowRecordId: "image-candidates", outputRevision: "a".repeat(64), dependencyLinks: [] },
    { operationId: "route-skip-bypass", expectedRevisions: { "toon-project.json": projectBeforeWorkflow.body.revision }, kind: "workflow.skip", workflowRecordId: "image-candidates", reason: "forged" },
    { operationId: "route-authorize-bypass", expectedRevisions: { "toon-project.json": projectBeforeWorkflow.body.revision }, kind: "workflow.authorize", generationId: "generation-route", authorization: { id: "forged", scopeHash: "c".repeat(64), authorizedAt: now } },
    { operationId: "route-adopt-bypass", expectedRevisions: { "toon-project.json": projectBeforeWorkflow.body.revision }, kind: "workflow.adopt", generationId: "generation-route", candidateId: "candidate", adoptionId: "forged-adoption" },
    { operationId: "route-delivery-bypass", expectedRevisions: { "toon-project.json": projectBeforeWorkflow.body.revision }, kind: "workflow.delivery", workflowRecordId: "image-candidates" },
  ]) {
    const blocked = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/commands`, { method: "POST", body: JSON.stringify(bypass) });
    expect(blocked.response.status).toBe(403);
    expect(await readFile(projectPath)).toEqual(protectedTruthBefore);
  }
  const dependencies = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "canvas.read", canvasId: "main" }) });
  const plan = { kind: "image", model: { kind: "image", providerID: "provider", modelID: "image" }, object: "frame", quantity: 1, prompt: "Draw", references: [], parameters: { mode: "text-to-image", size: "1024x1024" }, executionCount: 1, knownCost: null };
  const mediaPlan = { ...plan, referencePaths: [], referenceScope: "project", mode: "text-to-image", size: "1024x1024" };
  delete (mediaPlan as any).references; delete (mediaPlan as any).parameters;
  const snapshot = { requestId: "route-request", projectId, episodeId: "home-episode", canvasId: "main", nodeId: "image-node", stepId: "image-candidates", plan: mediaPlan };
  const { createHash } = await import("node:crypto");
  const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}` : JSON.stringify(value);
  const requestHash = createHash("sha256").update(canonical(snapshot)).digest("hex");
  const prepareBody = (operationId: string, expectedRevisions: Record<string, string> = {}, dependencyLinks: Array<Record<string, unknown>> = [{ target: { kind: "canvas", id: "main" }, revision: dependencies.body.revision }]) => ({ operationId, expectedRevisions, kind: "generation.prepare", generation: { id: "generation-route", requestId: "route-request", episodeId: "home-episode", workflowRecordId: "image-candidates", canvasId: "main", nodeId: "image-node", source: "assistant", plan, requestHash }, dependencyLinks });
  const gatedPrepare = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/commands`, { method: "POST", body: JSON.stringify(prepareBody("route-prepare-gated")) });
  expect(gatedPrepare.response.status).toBe(403);
  expect(gatedPrepare.body.code).toBe("toon_dedicated_or_internal_command_required");
  let workflowProject = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "project.read" }) });
  const approvedSource = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/workflow/source-material/approve`, { method: "POST", body: JSON.stringify({ operationId: "route-approve-source", episodeId: "home-episode", workflowRecordId: "source-material", expectedRevision: workflowProject.body.revision, outputRevision: dependencies.body.revision, dependencyLinks: [{ target: { kind: "canvas", id: "main" }, revision: dependencies.body.revision }] }) });
  expect(approvedSource.response.status).toBe(200);
  for (const stepId of ["episode-script", "asset-plan", "direction", "storyboard"]) {
    workflowProject = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "project.read" }) });
    const skipped = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/workflow/${stepId}/skip`, { method: "POST", body: JSON.stringify({ operationId: `route-skip-${stepId}`, episodeId: "home-episode", workflowRecordId: stepId, expectedRevision: workflowProject.body.revision, reason: "Not needed for this focused production path" }) });
    expect(skipped.response.status).toBe(200);
  }
  workflowProject = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "project.read" }) });
  const ensure = { operationId: "route-ensure", expectedRevision: workflowProject.body.revision };
  const ensured = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/workflow/ensure`, { method: "POST", body: JSON.stringify(ensure) });
  const ensuredRetry = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/workflow/ensure`, { method: "POST", body: JSON.stringify(ensure) });
  expect(ensuredRetry.body).toEqual(ensured.body);
  const decisionsAfterEnsure = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "project.read" }) });
  expect(decisionsAfterEnsure.body.project.workflow.episodes[0].steps.find((step: any) => step.id === "source-material")).toMatchObject({ status: "approved", contentApprovals: [{ outputRevision: dependencies.body.revision }] });
  expect(decisionsAfterEnsure.body.project.workflow.episodes[0].steps.find((step: any) => step.id === "episode-script")).toMatchObject({ status: "skipped", skipReason: "Not needed for this focused production path" });
  const catalogsBeforePrepare = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/query`, { method: "POST", body: JSON.stringify({ kind: "catalogs.read" }) });
  const directCoordinator = (await import("../toon-factory/workspace-coordinator.js")).ToonWorkspaceCoordinator;
  const runtimeStore = (await import("../toon-factory/workspace-runtime-store.js")).ToonWorkspaceRuntimeStore;
  const runtime = await runtimeStore.open(config);
  const coordinator = new directCoordinator("ws_1", root, runtime);
  const completeLinks = await coordinator.observeGenerationDependencies(projectId, "home-episode", "image-candidates", [{ kind: "canvas", id: "main" }, { kind: "node", id: "image-node" }]);
  const preparedGeneration = { response: { status: 200 }, body: await coordinator.execute(projectId, { ...prepareBody("route-prepare", { "toon-project.json": decisionsAfterEnsure.body.revision, "catalogs/canvases.json": catalogsBeforePrepare.body.revisions["catalogs/canvases.json"], "canvases/main.json": dependencies.body.revision }, completeLinks), actor: { kind: "assistant", id: "route-tool" }, origin: "assistant-tool" }) };
  runtime.close();
  expect(preparedGeneration.response.status).toBe(200);
  const exactRequest = { operationId: "route-authorize", requestId: "route-request", episodeId: "home-episode", workflowRecordId: "image-candidates", canvasId: "main", nodeId: "image-node", stepId: "image-candidates", plan: mediaPlan };
  const authorization = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/generations/generation-route/authorize`, { method: "POST", body: JSON.stringify(exactRequest) });
  expect(authorization.response.status).toBe(200);
  expect(authorization.body.requestHash).toBe(requestHash);
  const recoveredAuthorization = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/generations/generation-route/authorize`, { method: "POST", body: JSON.stringify(exactRequest) });
  expect(recoveredAuthorization.body.authorizationId).toBe(authorization.body.authorizationId);
  const invalidated = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/generations/generation-route/authorize`, { method: "POST", body: JSON.stringify({ ...exactRequest, operationId: "route-authorize-changed", plan: { ...mediaPlan, prompt: "Changed" } }) });
  expect(invalidated.response.status).toBe(409);
  const prepared = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/generations/generation-route`);
  expect(prepared.body).toMatchObject({ generation: { id: "generation-route", status: "awaiting-human-authorization", authorization: { scopeHash: requestHash } }, job: null, authorization: { authorizationId: authorization.body.authorizationId, requestId: "route-request", planFingerprint: requestHash, planSummary: mediaPlan, state: "valid", consumedAt: null, expiresAt: expect.any(String) } });
  expect(JSON.stringify(prepared.body.authorization)).not.toMatch(/principal|requestHash|requestSnapshot|scopeHash|secret/i);
  const staleSubmit = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/generations/generation-route/submit`, { method: "POST", body: JSON.stringify({ authorizationId: authorization.body.authorizationId, expectedPlanFingerprint: "f".repeat(64) }) });
  expect(staleSubmit.response.status).toBe(409);
  expect(staleSubmit.body.code).toBe("toon_compute_authorization_scope_changed");

  const legacyInitialized = await request(base, "/workspace/ws_1/toon-factory/v2/projects/initialize", { method: "POST", body: JSON.stringify({ operationId: "route-old-empty", name: "Old Empty", directory: "routes/old-empty" }) });
  expect(legacyInitialized.response.status).toBe(201);
  const oldProjectId = "toon-route-old-empty";
  const oldPath = join(root, "routes/old-empty/toon-project.json");
  const oldProject = JSON.parse(await readFile(oldPath, "utf8"));
  oldProject.workflow.episodes = [];
  await writeFile(oldPath, `${JSON.stringify(oldProject, null, 2)}\n`);
  const oldBeforeEnsure = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${oldProjectId}/query`, { method: "POST", body: JSON.stringify({ kind: "project.read" }) });
  const oldEnsureRequest = { operationId: "ensure-old-empty", expectedRevision: oldBeforeEnsure.body.revision };
  const oldEnsured = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${oldProjectId}/workflow/ensure`, { method: "POST", body: JSON.stringify(oldEnsureRequest) });
  expect(oldEnsured.response.status).toBe(200);
  expect((await request(base, `/workspace/ws_1/toon-factory/v2/projects/${oldProjectId}/workflow/ensure`, { method: "POST", body: JSON.stringify(oldEnsureRequest) })).body).toEqual(oldEnsured.body);
  const oldAfterEnsure = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${oldProjectId}/query`, { method: "POST", body: JSON.stringify({ kind: "project.read" }) });
  expect(oldAfterEnsure.body.project.workflow.episodes[0].steps).toHaveLength(9);

  const preserveInitialized = await request(base, "/workspace/ws_1/toon-factory/v2/projects/initialize", { method: "POST", body: JSON.stringify({ operationId: "route-preserve-decisions", name: "Preserve Decisions", directory: "routes/preserve-decisions" }) });
  expect(preserveInitialized.response.status).toBe(201);
  const preserveProjectId = "toon-route-preserve-decisions";
  const preservePath = join(root, "routes/preserve-decisions/toon-project.json");
  const preserveProject = JSON.parse(await readFile(preservePath, "utf8"));
  const oldNow = "2026-01-01T00:00:00.000Z";
  preserveProject.workflow.episodes = [{ id: "old-episode", title: "Old episode", ordinal: 0, canvasId: "main", stages: [{ stage: "content-script", status: "approved", updatedAt: oldNow }, { stage: "images", status: "approved", updatedAt: oldNow }], steps: [{ id: "source-material", stage: "content-script", title: "Existing source", status: "approved", dependencies: [], dependencyLinks: [], contentApprovals: [{ id: "old-approval", outputRevision: dependencies.body.revision, approvedAt: oldNow }], computeAuthorizations: [], resultAdoptions: [], history: [], outputRevision: dependencies.body.revision, updatedAt: oldNow }, { id: "image-candidates", stage: "images", title: "Existing images", status: "adopted", dependencies: [], dependencyLinks: [], contentApprovals: [], computeAuthorizations: [], resultAdoptions: [{ id: "old-adoption", resultId: "old-candidate", adoptedAt: oldNow }], history: [], updatedAt: oldNow }], createdAt: oldNow, updatedAt: oldNow }];
  await writeFile(preservePath, `${JSON.stringify(preserveProject, null, 2)}\n`);
  const preserveBeforeEnsure = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${preserveProjectId}/query`, { method: "POST", body: JSON.stringify({ kind: "project.read" }) });
  const preserved = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${preserveProjectId}/workflow/ensure`, { method: "POST", body: JSON.stringify({ operationId: "ensure-preserve-decisions", expectedRevision: preserveBeforeEnsure.body.revision }) });
  expect(preserved.response.status).toBe(200);
  const preserveAfterEnsure = await request(base, `/workspace/ws_1/toon-factory/v2/projects/${preserveProjectId}/query`, { method: "POST", body: JSON.stringify({ kind: "project.read" }) });
  const preservedSteps = preserveAfterEnsure.body.project.workflow.episodes[0].steps;
  expect(preservedSteps).toHaveLength(9);
  expect(preservedSteps.find((step: any) => step.id === "source-material")).toMatchObject({ title: "Existing source", status: "approved", contentApprovals: [{ id: "old-approval" }] });
  expect(preservedSteps.find((step: any) => step.id === "image-candidates")).toMatchObject({ title: "Existing images", status: "adopted", resultAdoptions: [{ id: "old-adoption" }] });
  const previousExposure = process.env.JUGGLEWORK_TOON_ADVANCED_WORKSPACE;
  process.env.JUGGLEWORK_TOON_ADVANCED_WORKSPACE = "0";
  try {
    expect((await request(base, "/workspace/ws_1/toon-factory/workspace-features")).body.advancedWorkspace).toBe(false);
    expect((await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/commands`, {
      method: "POST", body: JSON.stringify({ operationId: "hidden-write", expectedRevisions: {}, kind: "project.update", name: "Hidden" }),
    })).response.status).toBe(404);
    expect((await request(base, `/workspace/ws_1/toon-factory/v2/projects/${projectId}/export`)).response.status).toBe(200);
  } finally {
    if (previousExposure === undefined) delete process.env.JUGGLEWORK_TOON_ADVANCED_WORKSPACE;
    else process.env.JUGGLEWORK_TOON_ADVANCED_WORKSPACE = previousExposure;
  }
});
