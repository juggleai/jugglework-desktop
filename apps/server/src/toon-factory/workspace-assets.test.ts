import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationSqliteAdapter } from "../automation/sqlite.js";
import { ToonWorkspaceCoordinator } from "./workspace-coordinator.js";
import { ToonWorkspaceRuntimeStore } from "./workspace-runtime-store.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function fixture(hooks: ConstructorParameters<typeof ToonWorkspaceCoordinator>[3] = {}) {
  const root = await mkdtemp(join(tmpdir(), "toon-assets-")); roots.push(root);
  const sqlite = new Database(":memory:");
  const runtime = ToonWorkspaceRuntimeStore.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
  const coordinator = new ToonWorkspaceCoordinator("ws", root, runtime, hooks);
  await coordinator.initialize({ operationId: "init-assets", actor: { kind: "human" }, origin: "human-ui", name: "Assets", directory: "project" });
  return { root, runtime, coordinator };
}

function png(): Buffer {
  const bytes = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes); bytes.writeUInt32BE(640, 16); bytes.writeUInt32BE(360, 20); return bytes;
}

describe("portable project assets", () => {
  test("atomically imports a signed asset and compatible canvas node, then retries idempotently", async () => {
    const fx = await fixture();
    const canvas = await fx.coordinator.query("toon-init-assets", { kind: "canvas.read", canvasId: "main" }) as any;
    const input = { operationId: "import-image", assetId: "asset-image", filename: "Frame.png", declaredMimeType: "image/png", origin: "imported" as const, actor: { kind: "human" as const }, canvas: { id: "main", expectedRevision: canvas.revision, position: { x: 42, y: 84 } } };
    const first = await fx.coordinator.importAsset("toon-init-assets", input, png());
    expect(await fx.coordinator.importAsset("toon-init-assets", input, png())).toEqual(first);
    expect(first.result).toMatchObject({ asset: { id: "asset-image", width: 640, height: 360, mimeType: "image/png" }, nodeId: "asset-image-node", reused: false });
    const imported = await fx.coordinator.query("toon-init-assets", { kind: "canvas.read", canvasId: "main" }) as any;
    expect(imported.canvas.nodes[0]).toMatchObject({ id: "asset-image-node", kind: "image-asset", position: { x: 42, y: 84 }, config: { asset: { id: "asset-image" } } });
    expect([...(await readFile(join(fx.root, "project/assets/imported/Frame-" + (first.result as any).asset.checksum.slice(0, 12) + ".png")))]).toEqual([...png()]);
    fx.runtime.close();
  });

  test("rejects mismatched and unsupported content before catalog or node publication", async () => {
    const fx = await fixture();
    const canvas = await fx.coordinator.query("toon-init-assets", { kind: "canvas.read", canvasId: "main" }) as any;
    await expect(fx.coordinator.importAsset("toon-init-assets", { operationId: "bad", assetId: "bad", filename: "bad.png", declaredMimeType: "image/png", origin: "imported", actor: { kind: "human" }, canvas: { id: "main", expectedRevision: canvas.revision, position: { x: 0, y: 0 } } }, Buffer.from("not png"))).rejects.toMatchObject({ code: "toon_asset_signature_mismatch" });
    expect((await fx.coordinator.query("toon-init-assets", { kind: "catalogs.read" }) as any).assets.assets).toEqual([]);
    expect((await fx.coordinator.query("toon-init-assets", { kind: "canvas.read", canvasId: "main" }) as any).canvas.nodes).toEqual([]);
    fx.runtime.close();
  });

  test("recovers an interrupted asset import without publishing partial bytes, catalog, or node", async () => {
    const fx = await fixture();
    const canvas = await fx.coordinator.query("toon-init-assets", { kind: "canvas.read", canvasId: "main" }) as any;
    const crashing = new ToonWorkspaceCoordinator("ws", fx.root, fx.runtime, { crashAt: "after-prepare" });
    await expect(crashing.importAsset("toon-init-assets", { operationId: "crash-import", assetId: "crash", filename: "crash.png", declaredMimeType: "image/png", origin: "imported", actor: { kind: "human" }, canvas: { id: "main", expectedRevision: canvas.revision, position: { x: 1, y: 2 } } }, png())).rejects.toThrow("Injected");
    expect(await new ToonWorkspaceCoordinator("ws", fx.root, fx.runtime).recover()).toBe(1);
    const catalogs = await fx.coordinator.query("toon-init-assets", { kind: "catalogs.read" }) as any;
    expect(catalogs.assets.assets).toEqual([]);
    expect((await fx.coordinator.query("toon-init-assets", { kind: "canvas.read", canvasId: "main" }) as any).canvas.nodes).toEqual([]);
    expect(await Bun.file(join(fx.root, "project/assets/imported/crash.png")).exists()).toBe(false);
    fx.runtime.close();
  });

  test("recovers a published import after response loss and returns the recovered idempotent outcome", async () => {
    const fx = await fixture();
    const crashing = new ToonWorkspaceCoordinator("ws", fx.root, fx.runtime, { crashAt: "after-publish" });
    const input = { operationId: "lost-response", assetId: "lost", filename: "lost.png", declaredMimeType: "image/png", origin: "imported" as const, actor: { kind: "human" as const } };
    await expect(crashing.importAsset("toon-init-assets", input, png())).rejects.toThrow("Injected");
    const recovered = new ToonWorkspaceCoordinator("ws", fx.root, fx.runtime);
    expect(await recovered.recover()).toBe(1);
    const retry = await recovered.importAsset("toon-init-assets", input, png());
    expect(retry).toMatchObject({ operationId: "lost-response", status: "recovered", result: { asset: { id: "lost" }, reused: false } });
    expect((await recovered.query("toon-init-assets", { kind: "catalogs.read" }) as any).assets.assets).toHaveLength(1);
    fx.runtime.close();
  });

  test("reuses bytes by checksum and exposes reference impact for recoverable trash and stable-ID restore", async () => {
    const fx = await fixture();
    await fx.coordinator.importAsset("toon-init-assets", { operationId: "first", assetId: "first", filename: "one.png", declaredMimeType: "image/png", origin: "imported", actor: { kind: "human" } }, png());
    const reused = await fx.coordinator.importAsset("toon-init-assets", { operationId: "second", assetId: "second", filename: "two.png", declaredMimeType: "image/png", origin: "imported", actor: { kind: "human" } }, png());
    expect(reused.result).toMatchObject({ asset: { id: "first" }, reused: true });
    expect((await fx.coordinator.query("toon-init-assets", { kind: "catalogs.read" }) as any).assets.assets).toHaveLength(1);
    const canvas = await fx.coordinator.query("toon-init-assets", { kind: "canvas.read", canvasId: "main" }) as any;
    await fx.coordinator.execute("toon-init-assets", { operationId: "reuse-node", actor: { kind: "human" }, origin: "human-ui", expectedRevisions: { "canvases/main.json": canvas.revision }, kind: "canvas.write", canvasId: "main", body: { ...canvas.canvas, nodes: [{ id: "node", kind: "image-asset", position: { x: 0, y: 0 }, handles: [], config: { asset: { kind: "asset", id: "first" } } }] } });
    const impacts = await fx.coordinator.query("toon-init-assets", { kind: "asset.references", assetId: "first" }) as any;
    expect(impacts.impacts).toContainEqual(expect.objectContaining({ source: "canvas", id: "node" }));
    await expect(fx.coordinator.execute("toon-init-assets", { operationId: "blocked-delete", actor: { kind: "human" }, origin: "human-ui", expectedRevisions: {}, kind: "asset.delete", assetId: "first", destructive: false })).rejects.toMatchObject({ code: "toon_asset_referenced" });
    await fx.coordinator.execute("toon-init-assets", { operationId: "delete", actor: { kind: "human" }, origin: "human-ui", expectedRevisions: {}, kind: "asset.delete", assetId: "first", destructive: true });
    expect((await fx.coordinator.query("toon-init-assets", { kind: "asset.read", assetId: "first" }) as any).asset.state).toBe("trashed");
    const reimported = await fx.coordinator.importAsset("toon-init-assets", { operationId: "reimport", assetId: "third", filename: "three.png", declaredMimeType: "image/png", origin: "imported", actor: { kind: "human" } }, png());
    expect(reimported.result).toMatchObject({ asset: { id: "first", state: "active" }, reused: true });
    await fx.coordinator.execute("toon-init-assets", { operationId: "delete-again", actor: { kind: "human" }, origin: "human-ui", expectedRevisions: {}, kind: "asset.delete", assetId: "first", destructive: true });
    await fx.coordinator.execute("toon-init-assets", { operationId: "restore", actor: { kind: "human" }, origin: "human-ui", expectedRevisions: {}, kind: "asset.restore", assetId: "first" });
    expect((await fx.coordinator.query("toon-init-assets", { kind: "asset.read", assetId: "first" }) as any).asset).toMatchObject({ id: "first", state: "active" });
    fx.runtime.close();
  });

  test("replaces compatible live canvas references before trashing without rewriting history", async () => {
    const fx = await fixture();
    const one = png(); const two = png(); two.writeUInt32BE(320, 16);
    await fx.coordinator.importAsset("toon-init-assets", { operationId: "replace-first", assetId: "first", filename: "first.png", declaredMimeType: "image/png", origin: "imported", actor: { kind: "human" } }, one);
    await fx.coordinator.importAsset("toon-init-assets", { operationId: "replace-second", assetId: "second", filename: "second.png", declaredMimeType: "image/png", origin: "imported", actor: { kind: "human" } }, two);
    const canvas = await fx.coordinator.query("toon-init-assets", { kind: "canvas.read", canvasId: "main" }) as any;
    await fx.coordinator.execute("toon-init-assets", { operationId: "replace-node", actor: { kind: "human" }, origin: "human-ui", expectedRevisions: { "canvases/main.json": canvas.revision }, kind: "canvas.write", canvasId: "main", body: { ...canvas.canvas, nodes: [{ id: "replace-me", kind: "image-asset", position: { x: 0, y: 0 }, handles: [], config: { asset: { kind: "asset", id: "first" } } }] } });
    await fx.coordinator.execute("toon-init-assets", { operationId: "replace-delete", actor: { kind: "human" }, origin: "human-ui", expectedRevisions: {}, kind: "asset.delete", assetId: "first", replacementAssetId: "second", destructive: false });
    const replaced = await fx.coordinator.query("toon-init-assets", { kind: "canvas.read", canvasId: "main" }) as any;
    expect(replaced.canvas.nodes[0].config.asset.id).toBe("second");
    const catalogs = await fx.coordinator.query("toon-init-assets", { kind: "catalogs.read" }) as any;
    expect(catalogs.assets.assets.find((item: any) => item.id === "first").state).toBe("trashed");
    expect(catalogs.assets.assets.find((item: any) => item.id === "second").references).toContainEqual({ kind: "node", id: "replace-me" });
    fx.runtime.close();
  });
});
