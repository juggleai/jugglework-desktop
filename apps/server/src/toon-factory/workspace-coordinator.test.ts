import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationSqliteAdapter } from "../automation/sqlite.js";
import { ToonFactoryRepository } from "./repository.js";
import { createToonMediaAuthorization, toonMediaRequestHash, ToonMediaJobRepository } from "./media-job-repository.js";
import { TOON_WORKSPACE_CLEANUP_GRACE, ToonWorkspaceCoordinator } from "./workspace-coordinator.js";
import { ToonWorkspaceRuntimeStore } from "./workspace-runtime-store.js";
import { migrateToonWorkspaceRuntimeDatabase } from "./workspace-runtime-migrations.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function fixture(hooks: ConstructorParameters<typeof ToonWorkspaceCoordinator>[3] = {}) {
  const root = await mkdtemp(join(tmpdir(), "toon-workspace-")); roots.push(root);
  const sqlite = new Database(":memory:");
  const store = ToonWorkspaceRuntimeStore.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
  return { root, sqlite, store, coordinator: new ToonWorkspaceCoordinator("ws-1", root, store, hooks) };
}

const actor = { kind: "human" as const, id: "member-1" };
const envelope = (operationId: string) => ({ operationId, actor, origin: "human-ui" as const, expectedRevisions: {} });

describe("Toon workspace semantic coordinator", () => {
  test("runtime migration upgrades an existing database idempotently and creates all runtime-only tables", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE existing_app_data(id TEXT PRIMARY KEY); INSERT INTO existing_app_data(id) VALUES ('kept')");
    const adapter = automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() });
    migrateToonWorkspaceRuntimeDatabase(adapter);
    migrateToonWorkspaceRuntimeDatabase(adapter);
    expect(sqlite.query("SELECT id FROM existing_app_data").all()).toEqual([{ id: "kept" }]);
    const tables = new Set((sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'toon_workspace_%'").all() as Array<{ name: string }>).map((row) => row.name));
    for (const name of ["toon_workspace_projects", "toon_workspace_conversations", "toon_workspace_session_lineage", "toon_workspace_event_cursors", "toon_workspace_operation_outcomes", "toon_workspace_write_leases", "toon_workspace_canvas_leases", "toon_workspace_recovery_journals", "toon_workspace_tool_calls", "toon_workspace_generation_links", "toon_workspace_model_policies", "toon_workspace_conversation_cleanups", "toon_workspace_conversation_cleanup_sessions"]) expect(tables.has(name)).toBe(true);
    const leaseColumns = new Set((sqlite.query("PRAGMA table_info(toon_workspace_canvas_leases)").all() as Array<{ name: string }>).map((column) => column.name));
    expect(leaseColumns.has("lease_token")).toBe(true);
    expect(leaseColumns.has("generation")).toBe(true);
    const turnSessionColumns = new Set((sqlite.query("PRAGMA table_info(toon_workspace_turn_sessions)").all() as Array<{ name: string }>).map((column) => column.name));
    expect(turnSessionColumns.has("abort_requested_at")).toBe(true);
    expect(turnSessionColumns.has("abort_attempts")).toBe(true);
    const turnColumns = new Set((sqlite.query("PRAGMA table_info(toon_workspace_assistant_turns)").all() as Array<{ name: string }>).map((column) => column.name));
    for (const name of ["stop_started_at", "stop_deadline_at", "stop_quiet_since", "stop_observation_hash", "stop_stable_polls"]) expect(turnColumns.has(name)).toBe(true);
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='toon_workspace_pending_assistant_replacements'").get()).toBeTruthy();
    sqlite.close();
  });

  for (const version of [1, 2, 3, 4, 5, 6, 7]) {
    test(`runtime migration repairs a historical v${version} database without losing existing rows`, () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`CREATE TABLE toon_workspace_schema_migrations(version INTEGER PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);
        CREATE TABLE toon_workspace_projects (
          workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, normalized_root TEXT NOT NULL,
          schema_version INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, unavailable_since INTEGER,
          PRIMARY KEY(workspace_scope, project_id), UNIQUE(workspace_scope, normalized_root)
        );
        INSERT INTO toon_workspace_schema_migrations(version, applied_at) VALUES (${version}, 1);
        INSERT INTO toon_workspace_projects(workspace_scope, project_id, normalized_root, schema_version, last_seen_at)
          VALUES ('ws', 'project', '/tmp/project', 2, 1);`);
      const adapter = automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() });
      migrateToonWorkspaceRuntimeDatabase(adapter);
      migrateToonWorkspaceRuntimeDatabase(adapter);
      expect(sqlite.query("SELECT project_id FROM toon_workspace_projects").all()).toEqual([{ project_id: "project" }]);
      expect((sqlite.query("PRAGMA table_info(toon_workspace_projects)").all() as Array<{ name: string }>).some((column) => column.name === "project_instance_id")).toBe(true);
      expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='toon_workspace_authorizations'").get()).toBeTruthy();
      expect((sqlite.query("SELECT MAX(version) AS version FROM toon_workspace_schema_migrations").get() as { version: number }).version).toBe(16);
      sqlite.close();
    });
  }

  test("runtime migration backfills root ownership for pre-v10 assistant turns", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`CREATE TABLE toon_workspace_schema_migrations(version INTEGER PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);
      INSERT INTO toon_workspace_schema_migrations(version, applied_at) VALUES (9, 1);
      CREATE TABLE toon_workspace_conversations (
        workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL,
        visibility TEXT NOT NULL, parent_conversation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_scope, project_id, conversation_id)
      );
      CREATE TABLE toon_workspace_assistant_turns (
        workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        branch_id TEXT NOT NULL, source_message_id TEXT, status TEXT NOT NULL, remote_may_continue INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_scope, project_id, conversation_id, turn_id)
      );
      INSERT INTO toon_workspace_conversations VALUES ('ws', 'project', 'conversation', 'session-root', 'toon_project_assistant', NULL, 1, 1);
      INSERT INTO toon_workspace_assistant_turns VALUES
        ('ws', 'project', 'conversation', 'turn-old', 'branch-old', NULL, 'completed', 0, 1, 2),
        ('ws', 'project', 'conversation', 'turn-active', 'branch-active', NULL, 'running', 0, 3, 4);`);
    const adapter = automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() });
    migrateToonWorkspaceRuntimeDatabase(adapter);
    expect(sqlite.query("SELECT turn_id, session_id, state FROM toon_workspace_turn_sessions ORDER BY created_at").all()).toEqual([
      { turn_id: "turn-old", session_id: "session-root", state: "terminal" },
      { turn_id: "turn-active", session_id: "session-root", state: "active" },
    ]);
    sqlite.close();
  });

  test("runtime migration adds durable abort state to existing v11 turn sessions", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`CREATE TABLE toon_workspace_schema_migrations(version INTEGER PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);
      INSERT INTO toon_workspace_schema_migrations(version, applied_at) VALUES (11, 1);
      CREATE TABLE toon_workspace_turn_sessions (
        workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL, parent_session_id TEXT, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_scope, project_id, conversation_id, turn_id, session_id)
      );
      INSERT INTO toon_workspace_turn_sessions VALUES ('ws', 'project', 'conversation', 'turn', 'session', NULL, 'active', 1, 1);`);
    const adapter = automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() });
    migrateToonWorkspaceRuntimeDatabase(adapter);
    expect(sqlite.query("SELECT session_id, abort_requested_at, abort_attempts FROM toon_workspace_turn_sessions").all()).toEqual([
      { session_id: "session", abort_requested_at: null, abort_attempts: 0 },
    ]);
    expect((sqlite.query("SELECT MAX(version) AS version FROM toon_workspace_schema_migrations").get() as { version: number }).version).toBe(16);
    sqlite.close();
  });

  test("initializes v2, reconciles runtime mapping, and keeps operation retries idempotent", async () => {
    const fx = await fixture();
    const input = { operationId: "init-1", actor, origin: "human-ui", name: "Series", directory: "toons/series" };
    const first = await fx.coordinator.initialize(input);
    const retry = await fx.coordinator.initialize(input);
    expect(retry).toEqual(first);
    const projectId = "toon-init-1";
    const exported = await fx.coordinator.exportProject(projectId);
    expect(exported.project.metadata.id).toBe(projectId);
    expect(exported.project.workflow.episodes).toEqual([
      expect.objectContaining({ id: "episode-main", canvasId: "main", stages: expect.arrayContaining([{ stage: "content-script", status: "pending-confirmation", updatedAt: expect.any(String) }]), steps: expect.arrayContaining([expect.objectContaining({ id: "source-material", status: "pending-confirmation" }), expect.objectContaining({ id: "delivery-manifest", dependencies: ["adopt-clips"] })]) }),
    ]);
    expect(exported.project.workflow.episodes[0]!.stages).toHaveLength(6);
    expect(exported.project.workflow.episodes[0]!.steps).toHaveLength(9);
    expect(exported.canvases.canvases[0]).toMatchObject({ id: "main", kind: "episode" });
    expect(JSON.stringify(exported)).not.toMatch(/sessionId|runtimeId|sqliteId|apiKey|credential/i);
    const rows = fx.sqlite.query("SELECT project_id FROM toon_workspace_projects").all() as Array<{ project_id: string }>;
    expect(rows).toEqual([{ project_id: projectId }]);
    fx.sqlite.run("DELETE FROM toon_workspace_projects");
    expect((await fx.coordinator.listProjects())[0]?.projectId).toBe(projectId);
    expect(fx.sqlite.query("SELECT project_id FROM toon_workspace_projects").all()).toEqual([{ project_id: projectId }]);
    fx.store.markUnavailable("ws-1", projectId, 1);
    expect(fx.store.cleanupOrphanMappings(2)).toBe(1);
    expect(JSON.parse(await readFile(join(fx.root, "toons/series/toon-project.json"), "utf8")).metadata.id).toBe(projectId);
    fx.store.close();
  });

  test("opens an existing v2 directory without copying or reinitializing it", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-open", actor, origin: "human-ui", name: "Open", directory: "catalog/open" });
    const before = await readFile(join(fx.root, "catalog/open/toon-project.json"));
    const opened = await fx.coordinator.openProjectDirectory("catalog/open");
    expect(opened).toMatchObject({ imported: false, project: { projectId: "toon-init-open", directory: "catalog/open", name: "Open" } });
    expect(await readFile(join(fx.root, "catalog/open/toon-project.json"))).toEqual(before);
    await expect(fx.coordinator.openProjectDirectory("../outside")).rejects.toMatchObject({ code: "path_escape" });
    fx.store.close();
  });

  test("orphan cleanup retains projects that still own pending conversation cleanup", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-cleanup-owner", actor, origin: "human-ui", name: "Cleanup owner", directory: "cleanup-owner" });
    const projectId = "toon-init-cleanup-owner";
    fx.store.createConversation({ workspaceScope: "ws-1", projectId, conversationId: "conversation-cleanup", sessionId: "session-cleanup", title: "Cleanup", model: { kind: "text", providerID: "provider", modelID: "model" } });
    fx.store.beginConversationCleanup("ws-1", projectId, "conversation-cleanup", [{ sessionId: "session-cleanup", parentSessionId: null, depth: 0, kind: "root" }], 1);
    fx.store.markUnavailable("ws-1", projectId, 1);

    expect(fx.store.cleanupOrphanMappings(2)).toBe(0);
    expect(fx.store.conversationForSession("ws-1", "session-cleanup")).toMatchObject({ projectId, conversationId: "conversation-cleanup" });
    expect(fx.store.listPendingConversationCleanups("ws-1")).toHaveLength(1);
    fx.store.close();
  });

  test("rejects a copied portable project ID at a new root without exposing original runtime history", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-copy", actor, origin: "human-ui", name: "Copy", directory: "original" });
    const projectId = "toon-init-copy";
    fx.store.createConversation({ workspaceScope: "ws-1", projectId, conversationId: "private-conversation", sessionId: "private-session", title: "Private", model: { kind: "text", providerID: "provider", modelID: "model" } });
    await cp(join(fx.root, "original"), join(fx.root, "copied"), { recursive: true });
    await rm(join(fx.root, "original"), { recursive: true });
    await expect(fx.coordinator.openProjectDirectory("copied")).rejects.toMatchObject({ code: "toon_project_instance_changed" });
    expect(fx.store.listConversations("ws-1", projectId)).toEqual([expect.objectContaining({ id: "private-conversation" })]);
    expect(fx.store.conversationForSession("ws-1", "private-session")).toMatchObject({ projectId, conversationId: "private-conversation" });
    fx.store.close();
  });

  test("removes an interrupted initialized directory before commit so retry can safely recreate it", async () => {
    const fx = await fixture({ crashAt: "after-prepare" });
    const input = { operationId: "init-crash", actor, origin: "human-ui" as const, name: "Crash", directory: "crash-create" };
    await expect(fx.coordinator.initialize(input)).rejects.toThrow("Injected");
    const recovered = new ToonWorkspaceCoordinator("ws-1", fx.root, fx.store);
    expect(await recovered.recover()).toBe(1);
    expect(await Bun.file(join(fx.root, "crash-create/toon-project.json")).exists()).toBe(false);
    expect((await recovered.initialize(input)).status).toBe("committed");
    expect(JSON.parse(await readFile(join(fx.root, "crash-create/toon-project.json"), "utf8")).metadata.id).toBe("toon-init-crash");
    fx.store.close();
  });

  test("supports folder, canvas, document, and asset catalog commands with idempotency conflicts", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-2", actor, origin: "human-ui", name: "Series", directory: "series" });
    const projectId = "toon-init-2";
    await fx.coordinator.execute(projectId, { ...envelope("folder-1"), kind: "folder.create", folder: { id: "shots", title: "Shots", order: 0, state: "active" } });
    const createCanvas = { ...envelope("canvas-1"), kind: "canvas.create", canvas: { id: "second", title: "Second", kind: "freeform", folderId: "shots", order: 0, file: "canvases/second.json", state: "active" }, body: { schemaVersion: 2, id: "second", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    const created = await fx.coordinator.execute(projectId, createCanvas);
    expect(await fx.coordinator.execute(projectId, createCanvas)).toEqual(created);
    await expect(fx.coordinator.execute(projectId, { ...createCanvas, canvas: { ...createCanvas.canvas, title: "Changed" } })).rejects.toMatchObject({ code: "toon_operation_id_conflict" });
    await fx.coordinator.execute(projectId, { ...envelope("doc-1"), kind: "document.create", document: { id: "script", title: "Script", path: "documents/script.md", kind: "markdown", mimeType: "text/markdown", state: "active" }, content: "draft" });
    await fx.coordinator.execute(projectId, { ...envelope("doc-move"), kind: "document.rename", documentId: "script", title: "Moved Script", path: "documents/moved.md" });
    expect((await fx.coordinator.query(projectId, { kind: "document.read", documentId: "script" }) as any).content).toBe("draft");
    expect(await Bun.file(join(fx.root, "series/documents/script.md")).exists()).toBe(false);
    const assetBytes = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(assetBytes); assetBytes.writeUInt32BE(1, 16); assetBytes.writeUInt32BE(1, 20);
    await fx.coordinator.execute(projectId, { ...envelope("asset-1"), kind: "asset.register", asset: { id: "frame", title: "Frame", path: "assets/frame.png", mimeType: "image/png", bytes: assetBytes.byteLength, checksum: createHash("sha256").update(assetBytes).digest("hex"), origin: "imported", state: "active", references: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, contentBase64: assetBytes.toString("base64") });
    const catalogs = await fx.coordinator.query(projectId, { kind: "catalogs.read" }) as any;
    expect(catalogs.canvases.folders[0].id).toBe("shots");
    expect(catalogs.documents.documents[0].id).toBe("script");
    expect(catalogs.assets.assets[0].id).toBe("frame");
    fx.store.close();
  });

  const recoveryCases = [
    { name: "create", setup: async () => ({}), command: () => ({ ...envelope("recover-create"), kind: "canvas.create" as const, canvas: { id: "created", title: "Created", kind: "freeform" as const, order: 1, file: "canvases/created.json", state: "active" as const }, body: { schemaVersion: 2 as const, id: "created", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }) },
    { name: "rename", setup: async (coordinator: ToonWorkspaceCoordinator, projectId: string) => { await coordinator.execute(projectId, { ...envelope("setup-rename"), kind: "document.create", document: { id: "rename", title: "Before", path: "documents/before.md", kind: "markdown", mimeType: "text/markdown", state: "active" }, content: "rename" }); return {}; }, command: () => ({ ...envelope("recover-rename"), kind: "document.rename" as const, documentId: "rename", title: "After", path: "documents/after.md" }) },
    { name: "move", setup: async (coordinator: ToonWorkspaceCoordinator, projectId: string) => { await coordinator.execute(projectId, { ...envelope("setup-move-folder"), kind: "folder.create", folder: { id: "destination", title: "Destination", order: 0, state: "active" } }); return {}; }, command: () => ({ ...envelope("recover-move"), kind: "canvas.move" as const, canvasId: "main", folderId: "destination", order: 0 }) },
    { name: "reorder", setup: async (coordinator: ToonWorkspaceCoordinator, projectId: string) => { await coordinator.execute(projectId, { ...envelope("setup-reorder"), kind: "canvas.create", canvas: { id: "second", title: "Second", kind: "freeform", order: 1, file: "canvases/second.json", state: "active" }, body: { schemaVersion: 2, id: "second", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }); return {}; }, command: () => ({ ...envelope("recover-reorder"), kind: "canvas.reorder" as const, canvasIds: ["second", "main"] }) },
    { name: "duplicate", setup: async () => ({}), command: () => ({ ...envelope("recover-duplicate"), kind: "canvas.duplicate" as const, canvasId: "main", newCanvasId: "duplicate", title: "Duplicate" }) },
    { name: "delete", setup: async (coordinator: ToonWorkspaceCoordinator, projectId: string) => { await coordinator.execute(projectId, { ...envelope("setup-delete"), kind: "document.create", document: { id: "delete", title: "Delete", path: "documents/delete.md", kind: "markdown", mimeType: "text/markdown", state: "active" }, content: "delete" }); return {}; }, command: () => ({ ...envelope("recover-delete"), kind: "document.delete" as const, documentId: "delete" }) },
    { name: "restore", setup: async (coordinator: ToonWorkspaceCoordinator, projectId: string) => { await coordinator.execute(projectId, { ...envelope("setup-restore-create"), kind: "document.create", document: { id: "restore", title: "Restore", path: "documents/restore.md", kind: "markdown", mimeType: "text/markdown", state: "active" }, content: "restore" }); await coordinator.execute(projectId, { ...envelope("setup-restore-delete"), kind: "document.delete", documentId: "restore" }); return {}; }, command: () => ({ ...envelope("recover-restore"), kind: "document.restore" as const, documentId: "restore" }) },
    { name: "import", setup: async () => ({}), command: () => { const bytes = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes); bytes.writeUInt32BE(1, 16); bytes.writeUInt32BE(1, 20); return { ...envelope("recover-import"), kind: "asset.import" as const, assetId: "imported", filename: "imported.png", declaredMimeType: "image/png", assetOrigin: "imported" as const, contentBase64: bytes.toString("base64") }; } },
  ];

  for (const recoveryCase of recoveryCases) for (const crashAt of ["after-prepare", "during-publish", "after-publish"] as const) {
    test(`recovers multi-file ${recoveryCase.name} at ${crashAt}`, async () => {
      const fx = await fixture();
      await fx.coordinator.initialize({ operationId: `init-${recoveryCase.name}-${crashAt}`, actor, origin: "human-ui", name: recoveryCase.name, directory: `${recoveryCase.name}-${crashAt}` });
      const projectId = `toon-init-${recoveryCase.name}-${crashAt}`;
      await recoveryCase.setup(fx.coordinator, projectId);
      const command = recoveryCase.command();
      const crashing = new ToonWorkspaceCoordinator("ws-1", fx.root, fx.store, { crashAt, crashAfterEntry: 0 });
      await expect(crashing.execute(projectId, command)).rejects.toThrow("Injected");
      const recovered = new ToonWorkspaceCoordinator("ws-1", fx.root, fx.store);
      expect(await recovered.recover()).toBe(1);
      const retry = await recovered.execute(projectId, command);
      expect(["committed", "recovered"]).toContain(retry.status);
      expect((await recovered.query(projectId, { kind: "project.read" }) as any).project.metadata.id).toBe(projectId);
      fx.store.close();
    });
  }

  test("reconciles a lost canvas save response with the same operation ID without applying twice", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-lost", actor, origin: "human-ui", name: "Lost", directory: "lost" });
    const projectId = "toon-init-lost";
    const read = await fx.coordinator.query(projectId, { kind: "canvas.read", canvasId: "main" }) as any;
    const command = { ...envelope("autosave-lost"), expectedRevisions: { "canvases/main.json": read.revision }, kind: "canvas.write" as const, canvasId: "main", body: { ...read.canvas, nodes: [{ id: "once", kind: "text", position: { x: 1, y: 2 }, handles: [], config: {} }] } };
    const committed = await fx.coordinator.execute(projectId, command);
    const reconciled = await fx.coordinator.execute(projectId, command);
    expect(reconciled).toEqual(committed);
    expect(((await fx.coordinator.query(projectId, { kind: "canvas.read", canvasId: "main" })) as any).canvas.nodes.map((item: any) => item.id)).toEqual(["once"]);
    fx.store.close();
  });

  test("does not delete an external replacement that wins the final v2 publication race", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-final-cas", actor, origin: "human-ui", name: "Final CAS", directory: "final-cas" });
    const target = join(fx.root, "final-cas/catalogs/canvases.json");
    const before = await readFile(target, "utf8");
    let replaced = false;
    const racing = new ToonWorkspaceCoordinator("ws-1", fx.root, fx.store, {
      afterDestinationCheck: async (path) => {
        if (path !== "catalogs/canvases.json" || replaced) return;
        replaced = true;
        await writeFile(target, "external replacement", "utf8");
      },
    });

    await expect(racing.execute("toon-init-final-cas", { ...envelope("final-cas-race"), kind: "folder.create", folder: { id: "folder", title: "Folder", order: 0, state: "active" } })).rejects.toMatchObject({ status: 409, code: "toon_factory_revision_conflict" });
    expect(await readFile(target, "utf8")).toBe("external replacement");
    expect(await readFile(`${target}.jugglework-final-cas-race-0.bak`, "utf8")).toBe(before);
    expect(fx.store.listRecoverable("ws-1")).toEqual([expect.objectContaining({ operationId: "final-cas-race", state: "committing" })]);
    await expect(new ToonWorkspaceCoordinator("ws-1", fx.root, fx.store).recover()).rejects.toMatchObject({ status: 409, code: "toon_factory_revision_conflict" });
    expect(await readFile(target, "utf8")).toBe("external replacement");
    expect(await readFile(`${target}.jugglework-final-cas-race-0.bak`, "utf8")).toBe(before);
    fx.store.close();
  });

  test("rejects stale revisions, duplicate paths, dangling references, and symlink escapes without mutation", async () => {
    const fx = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "toon-workspace-outside-")); roots.push(outside);
    await fx.coordinator.initialize({ operationId: "init-safe", actor, origin: "human-ui", name: "Safe", directory: "safe" });
    const projectId = "toon-init-safe";
    const catalogs = await fx.coordinator.query(projectId, { kind: "catalogs.read" }) as any;
    await expect(fx.coordinator.execute(projectId, { ...envelope("stale-1"), expectedRevisions: { "catalogs/canvases.json": "b".repeat(64) }, kind: "folder.create", folder: { id: "stale", title: "Stale", order: 0, state: "active" } })).rejects.toMatchObject({ code: "toon_factory_revision_conflict" });
    await fx.coordinator.execute(projectId, { ...envelope("canvas-safe"), kind: "canvas.create", canvas: { id: "second", title: "Second", kind: "freeform", order: 1, file: "canvases/second.json", state: "active" }, body: { schemaVersion: 2, id: "second", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } });
    await expect(fx.coordinator.execute(projectId, { ...envelope("canvas-duplicate"), kind: "canvas.create", canvas: { id: "third", title: "Third", kind: "freeform", order: 2, file: "canvases/second.json", state: "active" }, body: { schemaVersion: 2, id: "third", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } })).rejects.toMatchObject({ code: "toon_duplicate_path" });
    await expect(fx.coordinator.execute(projectId, { ...envelope("dangling-1"), kind: "canvas.write", canvasId: "main", body: { schemaVersion: 2, id: "main", nodes: [{ id: "node-1", kind: "image-asset", position: { x: 0, y: 0 }, handles: [], config: { asset: { kind: "asset", id: "missing" } } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } })).rejects.toMatchObject({ code: "toon_reference_integrity" });
    const main = await fx.coordinator.query(projectId, { kind: "canvas.read", canvasId: "main" }) as any;
    await fx.coordinator.execute(projectId, { ...envelope("global-id-main"), expectedRevisions: { "canvases/main.json": main.revision }, kind: "canvas.write", canvasId: "main", body: { ...main.canvas, nodes: [{ id: "global-node", kind: "text", position: { x: 0, y: 0 }, handles: [], config: {} }] } });
    const second = await fx.coordinator.query(projectId, { kind: "canvas.read", canvasId: "second" }) as any;
    await expect(fx.coordinator.execute(projectId, { ...envelope("global-id-second"), expectedRevisions: { "canvases/second.json": second.revision }, kind: "canvas.write", canvasId: "second", body: { ...second.canvas, groups: [{ id: "global-node", title: "Collision", position: { x: 0, y: 0 } }] } })).rejects.toMatchObject({ code: "toon_reference_integrity" });
    await rm(join(fx.root, "safe/documents"), { recursive: true });
    await symlink(outside, join(fx.root, "safe/documents"), "dir");
    await expect(fx.coordinator.execute(projectId, { ...envelope("symlink-1"), kind: "document.create", document: { id: "escape", title: "Escape", path: "documents/escape.md", kind: "markdown", mimeType: "text/markdown", state: "active" }, content: "outside" })).rejects.toMatchObject({ code: "path_escape" });
    expect(await readFile(join(fx.root, "safe/catalogs/canvases.json"), "utf8")).toContain(catalogs.canvases.projectId);
    expect(await Bun.file(join(outside, "escape.md")).exists()).toBe(false);
    fx.store.close();
  });

  test("preflight is read-only, migration preserves v1 workflow and publishes root last", async () => {
    const fx = await fixture();
    const v1 = new ToonFactoryRepository(fx.root);
    const created = await v1.createProject({ name: "Legacy", directory: "legacy" });
    const now = new Date().toISOString();
    const outputRevision = "c".repeat(64);
    const project = { ...created.project, episodes: [{ id: "episode-1", title: "Episode", ordinal: 0, canvasId: "main", stages: [{ stage: "content-script" as const, status: "awaiting-review" as const, outputRevision, updatedAt: now }], steps: [{ id: "episode-script", stage: "content-script" as const, title: "Script", status: "awaiting-review" as const, dependencies: [], contentApprovals: [{ id: "approval", outputRevision, approvedAt: now }], computeAuthorizations: [], resultAdoptions: [{ id: "adoption", resultId: "result-1", adoptedAt: now }], history: [], generationJobId: "runtime-job-1", generatedResults: [{ id: "result-1", jobId: "runtime-job-1", action: "script" as const, status: "awaiting-review" as const, nodeId: "source", resultRef: "generations/manifests/result-1.json", contentRef: "content/nodes/source.md", outputRevision, recordedAt: now }], updatedAt: now }], createdAt: now, updatedAt: now }], updatedAt: now };
    const updated = await v1.updateProject(created.project.id, { project, expectedRevision: created.revision });
    const canvas = await v1.readCanvas(created.project.id, "main");
    await v1.writeCanvas(created.project.id, "main", { canvas: { ...canvas.canvas, nodes: [{ id: "source", kind: "text", position: { x: 0, y: 0 }, handles: [{ id: "out", direction: "source", dataType: "text" }], data: { contentRef: "content/nodes/source.md" } }, { id: "target", kind: "storyboard", position: { x: 100, y: 0 }, handles: [{ id: "in", direction: "target", dataType: "text" }], data: {} }], edges: [{ id: "edge-1", sourceNodeId: "source", sourceHandleId: "out", targetNodeId: "target", targetHandleId: "in" }] }, expectedRevision: canvas.revision });
    await v1.writeText(created.project.id, "source", { content: "# Legacy script\n" });
    const rootPath = join(fx.root, "legacy/toon-project.json");
    const before = await readFile(rootPath);
    const preflight = await fx.coordinator.migrationPreflight(created.project.id);
    expect(await readFile(rootPath)).toEqual(before);
    expect(preflight.changedFiles.at(-1)).toBe("toon-project.json");
    const outcome = await fx.coordinator.migrate(created.project.id, { operationId: "migrate-1", expectedRevision: updated.revision, confirmed: true, actor });
    expect(outcome.status).toBe("committed");
    const exported = await fx.coordinator.exportProject(created.project.id);
    expect(exported.project.workflow.episodes[0]).toMatchObject({ id: "episode-1", stages: project.episodes[0]!.stages });
    const migratedResult = exported.project.workflow.episodes[0]!.steps![0]!.generatedResults![0]!;
    const migratedContentRef = migratedResult.contentRef;
    const migratedResultRef = migratedResult.resultRef;
    expect(migratedResult).toMatchObject({ id: expect.stringMatching(/^text-result-/), nodeId: "source", outputRevision, contentRef: expect.stringMatching(/^content\/generated\//), resultRef: expect.stringMatching(/^generations\/manifests\/text-result-/) });
    expect(exported.project.workflow.episodes[0]!.steps![0]).toMatchObject({ id: "episode-script", contentApprovals: project.episodes[0]!.steps![0]!.contentApprovals, resultAdoptions: [{ id: "adoption", resultId: migratedResult.id }], generationRefs: [{ kind: "generation", id: migratedResult.id, revision: outputRevision }] });
    expect(JSON.stringify(exported.project)).not.toContain("runtime-job-1");
    expect(await readFile(join(fx.root, "legacy", migratedContentRef), "utf8")).toBe("# Legacy script\n");
    expect(await readFile(join(fx.root, "legacy", migratedResultRef), "utf8")).not.toContain("runtime-job-1");
    expect(exported.canvasFiles["canvases/v2/main.json"]?.edges[0]?.id).toBe("edge-1");
    expect((await fx.coordinator.query(created.project.id, { kind: "document.read", documentId: "source" }) as any).content).toBe("# Legacy script\n");
    expect(exported.project.migration?.backupManifestRef).toBe(".toon-backups/migrate-1/manifest.json");
    expect(JSON.parse(await readFile(rootPath, "utf8")).schemaVersion).toBe(2);
    expect((await v1.listProjects()).items).toEqual([]);
    fx.store.close();
  });

  test("aborts migration before publication when any captured source changes externally", async () => {
    let sourcePath = "";
    const fx = await fixture({ beforePublish: async () => { await writeFile(sourcePath, "external-change", "utf8"); } });
    const v1 = new ToonFactoryRepository(fx.root);
    const created = await v1.createProject({ name: "CAS", directory: "migration-cas" });
    sourcePath = join(fx.root, "migration-cas/content/external.md");
    await mkdir(join(fx.root, "migration-cas/content"), { recursive: true });
    await writeFile(sourcePath, "captured", "utf8");
    const preflight = await fx.coordinator.migrationPreflight(created.project.id);
    await expect(fx.coordinator.migrate(created.project.id, { operationId: "migrate-cas", expectedRevision: preflight.projectRevision, confirmed: true, actor })).rejects.toMatchObject({ code: "toon_migration_source_changed" });
    expect(JSON.parse(await readFile(join(fx.root, "migration-cas/toon-project.json"), "utf8")).schemaVersion).toBe(1);
    expect(await readFile(sourcePath, "utf8")).toBe("external-change");
    expect(await Bun.file(join(fx.root, "migration-cas/catalogs/canvases.json")).exists()).toBe(false);
    expect(await Bun.file(join(fx.root, "migration-cas/.toon-backups/migrate-cas/manifest.json")).exists()).toBe(false);
    fx.store.close();
  });

  test("aborts migration when a parsed v1 canvas changes before the complete source snapshot", async () => {
    let mutateCanvas: () => Promise<void> = async () => undefined;
    const fx = await fixture({ beforeMigrationCapture: () => mutateCanvas() });
    const v1 = new ToonFactoryRepository(fx.root);
    const created = await v1.createProject({ name: "Capture CAS", directory: "migration-capture-cas" });
    const before = await v1.readCanvas(created.project.id, "main");
    mutateCanvas = async () => {
      await v1.writeCanvas(created.project.id, "main", {
        canvas: { ...before.canvas, viewport: { x: 17, y: 23, zoom: 1 } },
        expectedRevision: before.revision,
      });
    };
    const preflight = await fx.coordinator.migrationPreflight(created.project.id);

    await expect(fx.coordinator.migrate(created.project.id, { operationId: "migrate-capture-cas", expectedRevision: preflight.projectRevision, confirmed: true, actor })).rejects.toMatchObject({ code: "toon_migration_source_changed" });

    expect(JSON.parse(await readFile(join(fx.root, "migration-capture-cas/toon-project.json"), "utf8")).schemaVersion).toBe(1);
    expect((await v1.readCanvas(created.project.id, "main")).canvas.viewport).toEqual({ x: 17, y: 23, zoom: 1 });
    expect(await Bun.file(join(fx.root, "migration-capture-cas/catalogs/canvases.json")).exists()).toBe(false);
    expect(await Bun.file(join(fx.root, "migration-capture-cas/.toon-backups/migrate-capture-cas/manifest.json")).exists()).toBe(false);
    fx.store.close();
  });

  test("migration preserves media candidates and adoptions while rebuilding runtime links without portable job IDs", async () => {
    const fx = await fixture();
    const v1 = new ToonFactoryRepository(fx.root);
    const created = await v1.createProject({ name: "Legacy media", directory: "legacy-media" });
    const now = new Date().toISOString();
    const project = {
      ...created.project,
      episodes: [{
        id: "episode", title: "Episode", ordinal: 0, canvasId: "main",
        stages: [{ stage: "images" as const, status: "draft" as const, updatedAt: now }],
        steps: [{ id: "image-candidates", stage: "images" as const, title: "Images", status: "draft" as const, dependencies: [], contentApprovals: [], computeAuthorizations: [], resultAdoptions: [], history: [], updatedAt: now }],
        createdAt: now, updatedAt: now,
      }],
      updatedAt: now,
    };
    await v1.updateProject(created.project.id, { project, expectedRevision: created.revision });
    const canvas = await v1.readCanvas(created.project.id, "main");
    await v1.writeCanvas(created.project.id, "main", { canvas: { ...canvas.canvas, nodes: [{ id: "image-node", kind: "image-generation", position: { x: 0, y: 0 }, handles: [], data: {} }] }, expectedRevision: canvas.revision });
    const plan = { kind: "image" as const, model: { kind: "image" as const, providerID: "provider", modelID: "image" }, object: "frame", quantity: 1, prompt: "Draw", referencePaths: [], referenceScope: "project" as const, mode: "text-to-image" as const, size: "1024x1024", executionCount: 1, knownCost: null };
    const snapshot = { requestId: "legacy-media-request", projectId: created.project.id, episodeId: "episode", canvasId: "main", nodeId: "image-node", stepId: "image-candidates", plan };
    const request = { requestId: snapshot.requestId, episodeId: snapshot.episodeId, canvasId: snapshot.canvasId, nodeId: snapshot.nodeId, stepId: snapshot.stepId, plan, authorization: createToonMediaAuthorization(toonMediaRequestHash(snapshot), 1) };
    const adapter = automationSqliteAdapter({ kind: "bun", sqlite: fx.sqlite, db: null as never, close: () => undefined });
    const jobs = ToonMediaJobRepository.fromDatabase(adapter);
    const queued = jobs.create("ws-1", created.project.id, request, 2);
    await v1.queueMediaJob(queued);
    await mkdir(join(fx.root, "legacy-media/assets"), { recursive: true });
    const artifact = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(artifact); artifact.writeUInt32BE(2, 16); artifact.writeUInt32BE(3, 20);
    await writeFile(join(fx.root, "legacy-media/assets/candidate.png"), artifact);
    const reviewable = jobs.update(queued.id, (job, updatedAt) => ({ ...job, status: "awaiting-review", candidates: job.candidates.map((candidate) => ({ ...candidate, status: "awaiting-review", artifact: { scope: "project", path: "assets/candidate.png", mimeType: "image/png", bytes: artifact.byteLength }, updatedAt })) }), 3);
    await v1.adoptMediaCandidate(reviewable, reviewable.candidates[0]!);
    const adopted = jobs.update(queued.id, (job, updatedAt) => ({ ...job, status: "adopted", candidates: job.candidates.map((candidate) => ({ ...candidate, status: "adopted", review: { decision: "adopted", reviewedAt: updatedAt }, updatedAt })) }), 4);
    await v1.writeMediaJobManifest(adopted);

    const preflight = await fx.coordinator.migrationPreflight(created.project.id);
    await fx.coordinator.migrate(created.project.id, { operationId: "migrate-media", expectedRevision: preflight.projectRevision, confirmed: true, actor });
    const exported = await fx.coordinator.exportProject(created.project.id);
    const generation = exported.project.workflow.generations[0]!;
    expect(generation).toMatchObject({ requestId: "legacy-media-request", status: "adopted", candidates: [{ status: "adopted", assetId: expect.any(String) }] });
    expect(exported.project.workflow.adoptions).toEqual([expect.objectContaining({ candidateId: generation.candidates[0]!.id, generationId: generation.id })]);
    expect(exported.assets.assets[0]).toMatchObject({ path: "assets/candidate.png", checksum: createHash("sha256").update(artifact).digest("hex") });
    expect(JSON.stringify(exported)).not.toContain(queued.id);
    expect(fx.store.generationLinkByGeneration("ws-1", created.project.id, generation.id)).toMatchObject({ runtimeJobId: queued.id, nodeId: "image-node" });
    fx.store.close();
  });

  test("scopes protected workflow transitions to the selected episode when canonical step IDs repeat", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-episodes", actor, origin: "human-ui", name: "Episodes", directory: "episodes" });
    const projectId = "toon-init-episodes";
    await fx.coordinator.execute(projectId, {
      ...envelope("episode-two-canvas"),
      kind: "canvas.create",
      canvas: { id: "episode-two-canvas", title: "Episode 2", kind: "episode", order: 1, file: "canvases/episode-two.json", state: "active" },
      body: { schemaVersion: 2, id: "episode-two-canvas", nodes: [{ id: "episode-two-video", kind: "video-generation", position: { x: 0, y: 0 }, handles: [], config: {} }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    });
    const initialized = await fx.coordinator.exportProject(projectId);
    const now = "2026-01-01T00:00:00.000Z";
    const firstEpisode = initialized.project.workflow.episodes[0]!;
    const secondEpisode = {
      ...firstEpisode,
      id: "episode-two",
      title: "Episode 2",
      ordinal: 1,
      canvasId: "episode-two-canvas",
      stages: firstEpisode.stages.map((stage) => ({ ...stage, status: "draft" as const, updatedAt: now })),
      steps: firstEpisode.steps!.map((step) => ({
        ...step,
        status: step.id === "source-material" || step.id === "video-clips" ? "pending-confirmation" as const
          : ["episode-script", "asset-plan", "direction", "storyboard", "image-candidates"].includes(step.id) ? "approved" as const
            : "draft" as const,
        contentApprovals: [], computeAuthorizations: [], resultAdoptions: [], dependencyLinks: [], history: [], updatedAt: now,
      })),
      createdAt: now,
      updatedAt: now,
    };
    await fx.coordinator.executeRecoveryCommand(projectId, { ...envelope("configure-two-episodes"), kind: "workflow.configure", episodes: [firstEpisode, secondEpisode] });
    const before = await fx.coordinator.exportProject(projectId);
    const firstBefore = before.project.workflow.episodes.find((episode) => episode.id === firstEpisode.id)!;
    const outputLinks = await fx.coordinator.observeDependencies(projectId, [{ kind: "canvas", id: "episode-two-canvas" }]);
    await fx.coordinator.executeHumanInteraction(projectId, {
      ...envelope("approve-episode-two-source"), expectedRevisions: {}, kind: "workflow.approve", episodeId: "episode-two", workflowRecordId: "source-material", outputRevision: outputLinks[0]!.revision, dependencyLinks: outputLinks,
    }, actor.id);
    const sourceApproved = await fx.coordinator.exportProject(projectId);
    const approvedSource = sourceApproved.project.workflow.episodes.find((episode) => episode.id === "episode-two")!.steps!.find((step) => step.id === "source-material")!;
    const refreshedEpisode = sourceApproved.project.workflow.episodes.find((episode) => episode.id === "episode-two")!;
    await fx.coordinator.executeRecoveryCommand(projectId, { ...envelope("refresh-two-episodes"), kind: "workflow.configure", episodes: sourceApproved.project.workflow.episodes.map((episode) => episode.id !== "episode-two" ? episode : { ...refreshedEpisode, steps: refreshedEpisode.steps!.map((step) => step.id === "source-material" ? approvedSource : { ...step, dependencyLinks: [] }) }) });

    const requestHash = "a".repeat(64);
    await fx.coordinator.execute(projectId, {
      ...envelope("prepare-episode-two-video"), kind: "generation.prepare",
      generation: { id: "episode-two-generation", requestId: "episode-two-request", episodeId: "episode-two", workflowRecordId: "video-clips", canvasId: "episode-two-canvas", nodeId: "episode-two-video", source: "canvas", plan: { kind: "video", model: { kind: "video", providerID: "provider", modelID: "video" }, object: "clip", quantity: 1, prompt: "Animate episode two", references: [], parameters: { mode: "text-to-video", durationSeconds: 5, resolution: "720p" }, executionCount: 1, knownCost: null }, requestHash },
      dependencyLinks: await fx.coordinator.observeGenerationDependencies(projectId, "episode-two", "video-clips", [{ kind: "canvas", id: "episode-two-canvas" }, { kind: "node", id: "episode-two-video" }]),
    });
    const authorization = createToonMediaAuthorization(requestHash, 1);
    await fx.coordinator.executeHumanInteraction(projectId, {
      ...envelope("authorize-episode-two-video"), kind: "workflow.authorize", episodeId: "episode-two", workflowRecordId: "video-clips", generationId: "episode-two-generation", authorization,
    }, actor.id);
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(8)]);
    await mkdir(join(fx.root, "episodes/artifacts"), { recursive: true });
    await writeFile(join(fx.root, "episodes/artifacts/episode-two.mp4"), mp4);
    await fx.coordinator.executeRecoveryCommand(projectId, {
      ...envelope("project-episode-two-video"), kind: "generation.project", generationId: "episode-two-generation", status: "awaiting-review",
      candidates: [{ id: "episode-two-candidate", ordinal: 1, status: "awaiting-review", artifact: { path: "artifacts/episode-two.mp4", scope: "project", mimeType: "video/mp4", bytes: mp4.byteLength }, createdAt: now, updatedAt: now }],
    });
    await fx.coordinator.executeHumanInteraction(projectId, {
      ...envelope("adopt-episode-two-video"), kind: "workflow.adopt", episodeId: "episode-two", workflowRecordId: "video-clips", generationId: "episode-two-generation", candidateId: "episode-two-candidate", adoptionId: "episode-two-adoption",
    }, actor.id);
    await fx.coordinator.executeHumanInteraction(projectId, {
      ...envelope("deliver-episode-two"), kind: "workflow.delivery", episodeId: "episode-two", workflowRecordId: "delivery-manifest",
    }, actor.id);

    const after = await fx.coordinator.exportProject(projectId);
    expect(after.project.workflow.episodes.find((episode) => episode.id === firstEpisode.id)).toEqual(firstBefore);
    const secondAfter = after.project.workflow.episodes.find((episode) => episode.id === "episode-two")!;
    expect(secondAfter.steps!.find((step) => step.id === "source-material")).toMatchObject({ status: "approved", contentApprovals: [expect.any(Object)] });
    expect(secondAfter.steps!.find((step) => step.id === "video-clips")).toMatchObject({ status: "adopted", computeAuthorizations: [expect.any(Object)], resultAdoptions: [expect.objectContaining({ id: "episode-two-adoption" })] });
    expect(secondAfter.steps!.find((step) => step.id === "adopt-clips")?.status).toBe("adopted");
    expect(secondAfter.steps!.find((step) => step.id === "delivery-manifest")?.status).toBe("approved");
    expect(after.project.workflow.adoptions).toEqual([expect.objectContaining({ id: "episode-two-adoption", episodeId: "episode-two", workflowRecordId: "video-clips" })]);
    fx.store.close();
  });

  for (const crashAt of ["after-prepare", "during-publish", "after-publish", "after-commit"] as const) {
    test(`recovers an injected ${crashAt} interruption to a valid v1 or complete v2 project`, async () => {
      const fx = await fixture({ crashAt, crashAfterEntry: 1 });
      const v1 = new ToonFactoryRepository(fx.root);
      const created = await v1.createProject({ name: "Crash", directory: `crash-${crashAt}` });
      const preflight = await fx.coordinator.migrationPreflight(created.project.id);
      await expect(fx.coordinator.migrate(created.project.id, { operationId: `migrate-${crashAt}`, expectedRevision: preflight.projectRevision, confirmed: true, actor })).rejects.toThrow("Injected");
      const recovered = new ToonWorkspaceCoordinator("ws-1", fx.root, fx.store);
      expect(await recovered.recover()).toBe(1);
      const root = JSON.parse(await readFile(join(fx.root, `crash-${crashAt}/toon-project.json`), "utf8"));
      if (crashAt === "after-prepare") {
        expect(root.schemaVersion).toBe(1);
        expect((await v1.getProject(created.project.id)).project.id).toBe(created.project.id);
      } else {
        expect(root.schemaVersion).toBe(2);
        const exported = await recovered.exportProject(created.project.id);
        expect(exported.canvases.canvases[0]?.file).toBe("canvases/v2/main.json");
      }
      fx.store.close();
    });
  }

  test("rejects future portable versions without rewriting them", async () => {
    const fx = await fixture();
    await mkdir(join(fx.root, "future"));
    const path = join(fx.root, "future/toon-project.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 99, metadata: { id: "future" } }));
    await expect(fx.coordinator.exportProject("future")).rejects.toMatchObject({ code: "toon_factory_unsupported_version" });
    expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toBe(99);
    fx.store.close();
  });

  test("renews and expires visible editor leases without affecting durable commands", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-lease", actor, origin: "human-ui", name: "Lease", directory: "lease" });
    const projectId = "toon-init-lease";
    const first = await fx.coordinator.acquireCanvasLease(projectId, { leaseId: "editor-1", canvasId: "main", holder: "window-1", ttlMs: 5_000 });
    const renewed = await fx.coordinator.acquireCanvasLease(projectId, { leaseId: "editor-1", canvasId: "main", holder: "window-1", ttlMs: 10_000 });
    expect(renewed.expiresAt).toBeGreaterThanOrEqual(first.expiresAt);
    expect(renewed).toMatchObject({ leaseToken: first.leaseToken, generation: first.generation });
    const canvas = await fx.coordinator.query(projectId, { kind: "canvas.read", canvasId: "main" }) as any;
    const autosave = { ...envelope("lease-autosave"), origin: "autosave" as const, expectedRevisions: { "canvases/main.json": canvas.revision }, kind: "canvas.write" as const, canvasId: "main", body: { ...canvas.canvas, viewport: { x: 1, y: 2, zoom: 1 } }, leaseToken: first.leaseToken, leaseGeneration: first.generation };
    const saved = await fx.coordinator.execute(projectId, autosave, { requireCanvasLease: true });
    fx.coordinator.releaseCanvasLease(projectId, "main", "editor-1");
    expect(await fx.coordinator.execute(projectId, autosave, { requireCanvasLease: true })).toEqual(saved);
    await expect(fx.coordinator.execute(projectId, { ...autosave, operationId: "lease-autosave-stale" }, { requireCanvasLease: true })).rejects.toMatchObject({ code: "toon_canvas_lease_invalid" });
    const next = await fx.coordinator.acquireCanvasLease(projectId, { leaseId: "editor-2", canvasId: "main", holder: "window-2", ttlMs: 5_000 });
    expect(next.leaseToken).not.toBe(first.leaseToken);
    expect(next.generation).toBeGreaterThan(first.generation);
    await expect(fx.coordinator.acquireCanvasLease(projectId, { leaseId: "editor-other", canvasId: "main", holder: "window-other", ttlMs: 5_000 })).rejects.toMatchObject({ code: "toon_canvas_lease_conflict" });
    expect(fx.store.purgeExpiredLeases(Number.MAX_SAFE_INTEGER)).toBe(1);
    expect((await fx.coordinator.acquireCanvasLease(projectId, { leaseId: "editor-3", canvasId: "main", holder: "window-3", ttlMs: 5_000 })).leaseId).toBe("editor-3");
    fx.store.close();
  });

  test("creates and restores canvas checkpoints as new revisions while retaining history", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-history", actor, origin: "human-ui", name: "History", directory: "history" });
    const projectId = "toon-init-history";
    const first = await fx.coordinator.query(projectId, { kind: "canvas.read", canvasId: "main" }) as any;
    const checkpoint = await fx.coordinator.createCanvasCheckpoint(projectId, { operationId: "checkpoint-1", canvasId: "main", expectedRevision: first.revision, title: "Before edit", actor, origin: "human-ui" });
    expect(checkpoint.status).toBe("committed");
    const edited = { ...first.canvas, nodes: [{ id: "node-1", kind: "text", position: { x: 10, y: 20 }, handles: [], config: { label: "Edited" } }] };
    await fx.coordinator.execute(projectId, { ...envelope("edit-after-checkpoint"), expectedRevisions: { "canvases/main.json": first.revision }, kind: "canvas.write", canvasId: "main", body: edited });
    const current = await fx.coordinator.query(projectId, { kind: "canvas.read", canvasId: "main" }) as any;
    await fx.coordinator.restoreCanvasCheckpoint(projectId, "main", { operationId: "restore-1", checkpointId: "checkpoint-checkpoint-1", expectedRevision: current.revision, actor, origin: "human-ui" });
    const restored = await fx.coordinator.query(projectId, { kind: "canvas.read", canvasId: "main" }) as any;
    expect(restored.canvas.nodes).toEqual([]);
    expect(restored.revision).not.toBe(first.revision);
    expect((await fx.coordinator.listCanvasCheckpoints(projectId, "main")).items).toHaveLength(2);
    fx.store.close();
  });

  test("saves, searches, conflicts, and restores safe text documents as new revisions", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-docs", actor, origin: "human-ui", name: "Documents", directory: "documents" });
    const projectId = "toon-init-docs";
    await fx.coordinator.execute(projectId, { ...envelope("doc-create"), kind: "document.create", document: { id: "script", title: "Script", path: "documents/scripts/script.md", kind: "markdown", mimeType: "text/markdown", state: "active" }, content: "# First\nneedle one\n" });
    const first = await fx.coordinator.query(projectId, { kind: "document.read", documentId: "script" }) as any;
    await fx.coordinator.execute(projectId, { ...envelope("doc-write"), origin: "autosave", expectedRevisions: { "documents/scripts/script.md": first.revision }, kind: "document.write", documentId: "script", content: "# Second\nneedle two\n" });
    await expect(fx.coordinator.execute(projectId, { ...envelope("doc-stale-write"), expectedRevisions: { "documents/scripts/script.md": first.revision }, kind: "document.write", documentId: "script", content: "stale" })).rejects.toMatchObject({ code: "toon_factory_revision_conflict" });
    const search = await fx.coordinator.searchDocuments(projectId, { query: "needle", mode: "all", limit: 10 });
    expect(search.items).toEqual([expect.objectContaining({ documentId: "script", match: "content", line: 2, from: 0, to: 6 })]);
    expect(search.nextCursor).toBeNull();
    await fx.coordinator.execute(projectId, { ...envelope("doc-second"), kind: "document.create", document: { id: "notes", title: "Notes", path: "documents/notes.txt", kind: "text", mimeType: "text/plain", state: "active" }, content: "needle three" });
    expect(((await fx.coordinator.query(projectId, { kind: "catalogs.read" })) as any).documents.documents.map((item: any) => item.id)).toEqual(["script", "notes"]);
    const firstPage = await fx.coordinator.searchDocuments(projectId, { query: "needle", mode: "content", limit: 1, cursor: 0 });
    expect(firstPage).toMatchObject({ items: [expect.objectContaining({ documentId: "script" })], nextCursor: 1, truncated: true });
    const secondPage = await fx.coordinator.searchDocuments(projectId, { query: "needle", mode: "content", limit: 1, cursor: firstPage.nextCursor });
    expect(secondPage).toMatchObject({ items: [expect.objectContaining({ documentId: "notes" })], nextCursor: null });
    const revisions = await fx.coordinator.listDocumentRevisions(projectId, "script");
    expect(revisions.items).toHaveLength(2);
    const current = await fx.coordinator.query(projectId, { kind: "document.read", documentId: "script" }) as any;
    await fx.coordinator.restoreDocumentRevision(projectId, "script", revisions.items[0]!.id, { operationId: "doc-restore", expectedRevision: current.revision, actor, origin: "human-ui" });
    const restored = await fx.coordinator.query(projectId, { kind: "document.read", documentId: "script" }) as any;
    expect(restored.content).toBe("# First\nneedle one\n");
    expect(restored.revision).not.toBe(current.revision);
    expect((await fx.coordinator.listDocumentRevisions(projectId, "script")).items).toHaveLength(3);
    const controller = new AbortController(); controller.abort();
    await expect(fx.coordinator.searchDocuments(projectId, { query: "needle" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(fx.coordinator.execute(projectId, { ...envelope("doc-secret"), kind: "document.create", document: { id: "secret", title: "Secret", path: "documents/secrets/.env", kind: "text", mimeType: "text/plain", state: "active" }, content: "token" })).rejects.toMatchObject({ code: "invalid_toon_workspace_command" });
    fx.store.close();
  });

  test("validates passive media previews through the shared asset content boundary", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-preview", actor, origin: "human-ui", name: "Preview", directory: "preview" });
    const projectId = "toon-init-preview";
    const png = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
    await fx.coordinator.execute(projectId, { ...envelope("preview-register"), kind: "asset.register", asset: { id: "image", title: "Image.png", path: "assets/image.png", mimeType: "image/png", bytes: png.byteLength, checksum: createHash("sha256").update(png).digest("hex"), origin: "imported", state: "active", references: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, contentBase64: png.toString("base64") });
    const preview = await fx.coordinator.readAssetContent(projectId, "image");
    expect(preview.asset).toMatchObject({ id: "image", mimeType: "image/png" });
    expect(preview.bytes).toEqual(png);
    const fake = Buffer.from("not a png");
    await expect(fx.coordinator.execute(projectId, { ...envelope("fake-register"), kind: "asset.register", asset: { id: "fake", title: "Fake.png", path: "assets/fake.png", mimeType: "image/png", bytes: fake.byteLength, checksum: createHash("sha256").update(fake).digest("hex"), origin: "imported", state: "active", references: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, contentBase64: fake.toString("base64") })).rejects.toMatchObject({ code: "toon_asset_signature_mismatch" });
    fx.store.close();
  });

  test("recovers a multi-canvas dirty transition journal and bounds retained histories", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-transition", actor, origin: "human-ui", name: "Transition", directory: "transition" });
    const projectId = "toon-init-transition";
    const read = await fx.coordinator.query(projectId, { kind: "canvas.read", canvasId: "main" }) as any;
    await fx.coordinator.execute(projectId, { ...envelope("transition-second"), kind: "canvas.create", canvas: { id: "second", title: "Second", kind: "freeform", order: 1, file: "canvases/second.json", state: "active" }, body: { schemaVersion: 2, id: "second", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } });
    const flushed = await fx.coordinator.execute(projectId, { ...envelope("transition-flush"), expectedRevisions: { "canvases/main.json": read.revision }, kind: "canvas.write", canvasId: "main", body: { ...read.canvas, viewport: { x: 12, y: 18, zoom: 1.2 } } });
    expect(flushed.status).toBe("committed");
    expect(((await fx.coordinator.query(projectId, { kind: "canvas.read", canvasId: "second" })) as any).canvas.id).toBe("second");
    const flushedRead = await fx.coordinator.query(projectId, { kind: "canvas.read", canvasId: "main" }) as any;
    const crashing = new ToonWorkspaceCoordinator("ws-1", fx.root, fx.store, { crashAt: "after-commit" });
    await expect(crashing.execute(projectId, { ...envelope("dirty-flush"), expectedRevisions: { "canvases/main.json": flushedRead.revision }, kind: "canvas.write", canvasId: "main", body: { ...flushedRead.canvas, nodes: [{ id: "retained", kind: "text", position: { x: 0, y: 0 }, handles: [], config: {} }] } })).rejects.toThrow("Injected");
    const recovered = new ToonWorkspaceCoordinator("ws-1", fx.root, fx.store);
    expect(await recovered.recover()).toBe(1);
    expect(((await recovered.query(projectId, { kind: "canvas.read", canvasId: "main" })) as any).canvas.nodes[0].id).toBe("retained");
    await expect(recovered.execute(projectId, { ...envelope("blocked-transition"), expectedRevisions: { "canvases/main.json": read.revision }, kind: "canvas.write", canvasId: "main", body: read.canvas })).rejects.toMatchObject({ code: "toon_factory_revision_conflict" });
    fx.store.close();
  });

  test("preserves stable cross-catalog references and marks only the dependency closure stale", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-dependencies", actor, origin: "human-ui", name: "Dependencies", directory: "dependencies" });
    const projectId = "toon-init-dependencies";
    await fx.coordinator.execute(projectId, { ...envelope("doc-dependency"), kind: "document.create", document: { id: "script", title: "Script", path: "documents/script.md", kind: "markdown", mimeType: "text/markdown", state: "active" }, content: "v1" });
    const canvas = await fx.coordinator.query(projectId, { kind: "canvas.read", canvasId: "main" }) as any;
    await fx.coordinator.execute(projectId, { ...envelope("node-dependency"), expectedRevisions: { "canvases/main.json": canvas.revision }, kind: "canvas.write", canvasId: "main", body: { ...canvas.canvas, nodes: [
      { id: "script-node", kind: "text", position: { x: 0, y: 0 }, handles: [], config: { content: { kind: "document", id: "script" } } },
      { id: "image-node", kind: "image-generation", position: { x: 100, y: 0 }, handles: [], config: {} },
      { id: "unrelated", kind: "text", position: { x: 200, y: 0 }, handles: [], config: {} },
    ] } });
    const links = await fx.coordinator.observeDependencies(projectId, [{ kind: "document", id: "script" }, { kind: "node", id: "script-node" }]);
    const now = "2026-01-01T00:00:00.000Z";
    const baseStep = { title: "Step", status: "approved" as const, dependencyLinks: [], contentApprovals: [], computeAuthorizations: [], resultAdoptions: [], history: [], updatedAt: now };
    await fx.coordinator.executeMigrationCommand(projectId, { operationId: "workflow-dependencies", expectedRevisions: {}, kind: "workflow.configure", episodes: [{ id: "episode", title: "Episode", ordinal: 0, canvasId: "main", stages: [{ stage: "content-script", status: "approved", updatedAt: now }, { stage: "images", status: "approved", updatedAt: now }, { stage: "videos", status: "approved", updatedAt: now }], steps: [
      { ...baseStep, id: "script-step", stage: "content-script", dependencies: [], dependencyLinks: links },
      { ...baseStep, id: "image-candidates", stage: "images", dependencies: ["script-step"] },
      { ...baseStep, id: "independent", stage: "videos", dependencies: [], dependencyLinks: await fx.coordinator.observeDependencies(projectId, [{ kind: "node", id: "unrelated" }]) },
    ], createdAt: now, updatedAt: now }] });
    const doc = await fx.coordinator.query(projectId, { kind: "document.read", documentId: "script" }) as any;
    const write = { ...envelope("doc-stale"), expectedRevisions: { "documents/script.md": doc.revision }, kind: "document.write" as const, documentId: "script", content: "v2" };
    const outcome = await fx.coordinator.execute(projectId, write);
    expect(await fx.coordinator.execute(projectId, write)).toEqual(outcome);
    const project = (await fx.coordinator.query(projectId, { kind: "project.read" }) as any).project;
    const steps = Object.fromEntries(project.workflow.episodes[0].steps.map((step: any) => [step.id, step]));
    expect(steps["script-step"]).toMatchObject({ status: "stale", contentApprovals: [], staleReason: expect.any(String) });
    expect(steps["image-candidates"].status).toBe("stale");
    expect(steps.independent.status).toBe("approved");
    expect(steps["script-step"].history).toHaveLength(1);
    expect((await fx.coordinator.query(projectId, { kind: "references.read", target: { kind: "document", id: "script" } }) as any).references).toContainEqual({ kind: "node", id: "script-node" });
    fx.store.close();
  });

  test("requires trusted coordinator and authenticated human authorities for protected workflow writes", async () => {
    const fx = await fixture();
    await fx.coordinator.initialize({ operationId: "init-authority", actor, origin: "human-ui", name: "Authority", directory: "authority" });
    const projectId = "toon-init-authority";
    const before = await readFile(join(fx.root, "authority/toon-project.json"));
    const episodes = [{ id: "episode", title: "Episode", ordinal: 0, canvasId: "main", stages: [], steps: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }];
    await expect(fx.coordinator.execute(projectId, { operationId: "spoof-configure", actor: { kind: "system" }, origin: "migration", expectedRevisions: {}, kind: "workflow.configure", episodes })).rejects.toMatchObject({ status: 403, code: "toon_internal_command_required" });
    await expect(fx.coordinator.execute(projectId, { operationId: "spoof-approve", actor, origin: "human-ui", expectedRevisions: {}, kind: "workflow.approve", episodeId: "episode", workflowRecordId: "missing", outputRevision: "a".repeat(64), dependencyLinks: [] })).rejects.toMatchObject({ status: 403, code: "toon_human_action_required" });
    expect(await readFile(join(fx.root, "authority/toon-project.json"))).toEqual(before);
    await fx.coordinator.executeMigrationCommand(projectId, { operationId: "trusted-configure", expectedRevisions: {}, kind: "workflow.configure", episodes });
    expect(((await fx.coordinator.query(projectId, { kind: "project.read" })) as any).project.workflow.episodes).toEqual(episodes);
    fx.store.close();
  });

  test("cleans expired runtime state and old unreferenced trash only after documented grace periods", async () => {
    const fx = await fixture();
    const now = Date.parse("2026-10-17T12:00:00.000Z");
    await fx.coordinator.initialize({ operationId: "init-cleanup", actor, origin: "human-ui", name: "Cleanup", directory: "cleanup" });
    const projectId = "toon-init-cleanup";
    const png = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
    await fx.coordinator.importAsset(projectId, { operationId: "cleanup-asset", assetId: "old", filename: "old.png", declaredMimeType: "image/png", origin: "imported", actor }, png);
    await fx.coordinator.execute(projectId, { ...envelope("trash-old"), kind: "asset.delete", assetId: "old", destructive: true });
    const projectRoot = join(fx.root, "cleanup");
    const assetsPath = join(projectRoot, "catalogs/assets.json");
    const assets = JSON.parse(await readFile(assetsPath, "utf8"));
    assets.assets[0].trashedAt = new Date(now - TOON_WORKSPACE_CLEANUP_GRACE.assetTrashMs - 1).toISOString();
    await writeFile(assetsPath, `${JSON.stringify(assets, null, 2)}\n`);
    fx.store.acquireCanvasLease("ws-1", projectId, "main", "expired", "test", now - 1, now - 2);
    fx.sqlite.run("UPDATE toon_workspace_recovery_journals SET updated_at = ? WHERE state = 'terminal'", [now - TOON_WORKSPACE_CLEANUP_GRACE.completedJournalsMs - 1]);
    fx.store.reconcileProject("ws-1", "abandoned", join(fx.root, "missing"), 2, now - TOON_WORKSPACE_CLEANUP_GRACE.unavailableMappingsMs - 2);
    fx.store.markUnavailable("ws-1", "abandoned", now - TOON_WORKSPACE_CLEANUP_GRACE.unavailableMappingsMs - 1);
    for (let sequence = 1; sequence <= TOON_WORKSPACE_CLEANUP_GRACE.retainedAssistantEvents + 2; sequence += 1) {
      fx.sqlite.run(`INSERT INTO toon_workspace_assistant_events(workspace_scope, project_id, conversation_id, sequence, event_id, event_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ws-1", projectId, "conversation", sequence, `event-${sequence}`, "{}", now - TOON_WORKSPACE_CLEANUP_GRACE.assistantEventsMs - 1]);
    }
    const first = await fx.coordinator.cleanupLifecycle(now);
    expect(first.runtime.leases).toBe(1);
    expect(first.runtime.journals).toBeGreaterThan(0);
    expect(first.runtime.mappings).toBe(1);
    expect(first.runtime.events).toBe(2);
    expect((fx.sqlite.query("SELECT COUNT(*) AS count FROM toon_workspace_assistant_events").get() as { count: number }).count).toBe(TOON_WORKSPACE_CLEANUP_GRACE.retainedAssistantEvents);
    expect((await fx.coordinator.query(projectId, { kind: "asset.read", assetId: "old" }) as any).asset.state).toBe("tombstone");
    const second = await fx.coordinator.cleanupLifecycle(now);
    expect(second).toEqual({ runtime: { leases: 0, journals: 0, mappings: 0, events: 0 }, trashedAssets: 0 });
    expect(JSON.parse(await readFile(join(projectRoot, "toon-project.json"), "utf8")).metadata.id).toBe(projectId);
    fx.store.close();
  });
});
