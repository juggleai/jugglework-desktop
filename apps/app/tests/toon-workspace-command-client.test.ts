import { afterEach, expect, test } from "bun:test";

import { createJuggleWorkServerClient } from "../src/app/lib/jugglework-server";

const originalFetch = globalThis.fetch;
const hash = (value: string) => ({ p: "1", c: "2", d: "3", a: "4", m: "5", s: "6", f: "7", o: "8" }[value] ?? "9").repeat(64);
const now = "2026-01-01T00:00:00.000Z";

afterEach(() => { globalThis.fetch = originalFetch; });

test("workspace client sends complete command-specific revisions from the latest query snapshot", async () => {
  const canvas = { schemaVersion: 2 as const, id: "main", nodes: [{ id: "asset-node", kind: "image-asset" as const, position: { x: 0, y: 0 }, handles: [], config: { asset: { kind: "asset" as const, id: "asset-1" } } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const revisions = {
    "toon-project.json": hash("p"),
    "catalogs/canvases.json": hash("c"),
    "catalogs/documents.json": hash("d"),
    "catalogs/assets.json": hash("a"),
    "canvases/main.json": hash("m"),
    "documents/script.md": hash("s"),
    "assets/frame.png": hash("f"),
  };
  const catalogs = {
    kind: "catalogs.read" as const,
    canvases: { schemaVersion: 2 as const, projectId: "project-1", folders: [], canvases: [{ id: "main", title: "Main", kind: "freeform" as const, order: 0, file: "canvases/main.json", revision: revisions["canvases/main.json"], state: "active" as const }] },
    documents: { schemaVersion: 2 as const, projectId: "project-1", folders: [], documents: [{ id: "script", title: "Script", path: "documents/script.md", kind: "markdown" as const, mimeType: "text/markdown", revision: revisions["documents/script.md"], state: "active" as const, updatedAt: now }] },
    assets: { schemaVersion: 2 as const, projectId: "project-1", assets: [{ id: "asset-1", title: "Frame", path: "assets/frame.png", mimeType: "image/png", bytes: 4, checksum: revisions["assets/frame.png"], origin: "imported" as const, state: "active" as const, references: [{ kind: "node" as const, id: "asset-node" }], createdAt: now, updatedAt: now }] },
    revisions,
  };
  const commands: Array<Record<string, any>> = [];
  globalThis.fetch = (async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (String(input).endsWith("/query")) {
      if (body.kind === "canvas.read") return Response.json({ kind: "canvas.read", canvas, descriptor: catalogs.canvases.canvases[0], revision: revisions["canvases/main.json"], revisions });
      return Response.json(catalogs);
    }
    commands.push(body);
    return Response.json({ operationId: body.operationId, payloadHash: hash("o"), status: "committed", origin: body.kind === "canvas.write" ? "autosave" : "human-ui", actor: { kind: "human" }, affected: [], revisions: {}, committedAt: now });
  }) as typeof fetch;
  const client = createJuggleWorkServerClient({ baseUrl: "http://127.0.0.1:8787", token: "client-token" });

  await client.executeToonWorkspaceCommand("ws", "project-1", { operationId: "canvas-save", expectedRevisions: { "canvases/main.json": revisions["canvases/main.json"] }, kind: "canvas.write", canvasId: "main", body: { ...canvas, nodes: [] } });
  await client.executeToonWorkspaceCommand("ws", "project-1", { operationId: "document-save", expectedRevisions: { "documents/script.md": revisions["documents/script.md"] }, kind: "document.write", documentId: "script", content: "next" });
  await client.executeToonWorkspaceCommand("ws", "project-1", { operationId: "asset-delete", expectedRevisions: {}, kind: "asset.delete", assetId: "asset-1", destructive: true });

  expect(commands[0]!.expectedRevisions).toEqual({
    "canvases/main.json": revisions["canvases/main.json"],
    "toon-project.json": revisions["toon-project.json"],
    "catalogs/canvases.json": revisions["catalogs/canvases.json"],
    "catalogs/assets.json": revisions["catalogs/assets.json"],
  });
  expect(commands[1]!.expectedRevisions).toEqual({
    "documents/script.md": revisions["documents/script.md"],
    "toon-project.json": revisions["toon-project.json"],
    "catalogs/documents.json": revisions["catalogs/documents.json"],
  });
  expect(commands[2]!.expectedRevisions).toEqual({
    "toon-project.json": revisions["toon-project.json"],
    "catalogs/assets.json": revisions["catalogs/assets.json"],
    "assets/frame.png": revisions["assets/frame.png"],
    ".toon-trash/assets/asset-1/frame.png": null,
  });
});
