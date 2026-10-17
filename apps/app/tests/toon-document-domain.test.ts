import { describe, expect, test } from "bun:test";
import { buildToonDocumentTree, clearToonDocumentPendingSave, completeToonDocumentSave, documentOffsetForLine, editableToonDocument, flushAllDirtyTabs, prepareToonDocumentSave, toonWorkspaceRetentionKey, TOON_DOCUMENT_EDITABLE_MAX_CHARS } from "../src/react-app/domains/toon-factory/workspace/toon-document-domain";
import { readFileSync } from "node:fs";

const revision = "a".repeat(64);
const now = "2026-01-01T00:00:00.000Z";

describe("Toon document workspace domain", () => {
  test("keeps every document mutation behind the read-only fence", () => {
    const source = readFileSync(new URL("../src/react-app/domains/toon-factory/workspace/toon-document-workspace.tsx", import.meta.url), "utf8");
    expect(source).toContain("disabled={props.readOnly}");
    expect(source).toContain('if (readOnlyRef.current) throw new Error(t("toon_factory.lease_read_only"))');
    for (const guarded of ["createFile", "createFolder", "moveDocument", "itemAction", "saveConflictCopy", "restoreRevision"]) {
      const start = source.indexOf(`const ${guarded}`);
      expect(start).toBeGreaterThan(-1);
      expect(source.slice(start, start + 220)).toMatch(/(?:props\.readOnly|readOnlyRef\.current)/);
    }
    expect(source).toContain("readOnly={props.readOnly || !editableToonDocument");
    expect(source).toContain('title={props.readOnly ? t("toon_factory.lease_read_only") : undefined}');
  });
  test("builds a retained catalog-only tree without traversing arbitrary files", () => {
    const documents = [{ id: "script", title: "Script", path: "documents/scenes/script.md", kind: "markdown" as const, mimeType: "text/markdown", revision, state: "active" as const, updatedAt: now }];
    const folders = [{ id: "scenes", title: "Scenes", path: "documents/scenes", state: "active" as const }];
    const assets = [{ id: "frame", title: "Frame", path: "assets/frame.png", mimeType: "image/png", bytes: 8, checksum: revision, origin: "imported" as const, state: "active" as const, references: [], createdAt: now, updatedAt: now }];
    expect(buildToonDocumentTree(documents, folders, assets, new Set())).toEqual([
      expect.objectContaining({ id: "scenes", kind: "folder", depth: 0 }),
      expect.objectContaining({ id: "frame", kind: "asset", depth: 0 }),
    ]);
    expect(buildToonDocumentTree(documents, folders, assets, new Set(["scenes"]))).toEqual([
      expect.objectContaining({ id: "scenes", kind: "folder" }),
      expect.objectContaining({ id: "script", kind: "document", depth: 1 }),
      expect.objectContaining({ id: "frame", kind: "asset" }),
    ]);
  });

  test("maps bounded search line ranges and declares only markdown/text editable", () => {
    expect(documentOffsetForLine("one\ntwo\nthree", 2, 1)).toBe(5);
    expect(documentOffsetForLine("one", 99, 99)).toBe(3);
    const base = { id: "doc", title: "Doc", path: "documents/doc.md", mimeType: "text/plain", revision, state: "active" as const, updatedAt: now };
    expect(editableToonDocument({ ...base, kind: "markdown" })).toBe(true);
    expect(editableToonDocument({ ...base, kind: "text" })).toBe(true);
    expect(editableToonDocument({ ...base, kind: "json" })).toBe(false);
    expect(editableToonDocument({ ...base, kind: "preview" })).toBe(false);
    expect(editableToonDocument({ ...base, kind: "text" }, TOON_DOCUMENT_EDITABLE_MAX_CHARS + 1)).toBe(false);
    expect(editableToonDocument({ ...base, kind: "text", state: "trashed" })).toBe(false);
  });

  test("excludes generated and unsafe catalog entries without traversing disk", () => {
    const base = { title: "Doc", kind: "text" as const, mimeType: "text/plain", revision, state: "active" as const, updatedAt: now };
    const documents = [
      { ...base, id: "safe", path: "documents/safe.txt" },
      { ...base, id: "generated", path: "documents/generated/output.txt" },
      { ...base, id: "secret", path: "documents/secrets/credentials.txt" },
    ];
    const assets = [
      { id: "imported", title: "Imported", path: "assets/imported/frame.png", mimeType: "image/png", bytes: 8, checksum: revision, origin: "imported" as const, state: "active" as const, references: [], createdAt: now, updatedAt: now },
      { id: "generated-asset", title: "Generated", path: "assets/generated/frame.png", mimeType: "image/png", bytes: 8, checksum: revision, origin: "generated" as const, state: "active" as const, references: [], createdAt: now, updatedAt: now },
    ];
    expect(buildToonDocumentTree(documents, [], assets, new Set()).map((item) => item.id)).toEqual(["safe", "imported"]);
  });

  test("keeps autosave snapshots idempotent while newer edits remain dirty", () => {
    const state = { draft: "first", saved: "", revision, pendingSave: undefined };
    const pending = prepareToonDocumentSave(state, "save-1", "autosave")!;
    state.draft = "second";
    expect(prepareToonDocumentSave(state, "save-2", "human-ui")).toEqual(pending);
    expect(pending).toMatchObject({ operationId: "save-1", content: "first", revision, origin: "autosave", attempts: 0 });
    expect(completeToonDocumentSave(state, pending, "b".repeat(64))).toBe(true);
    expect(state).toMatchObject({ draft: "second", saved: "first", revision: "b".repeat(64), pendingSave: undefined });
    const retry = prepareToonDocumentSave(state, "save-2")!;
    clearToonDocumentPendingSave(state, retry);
    expect(state.pendingSave).toBeUndefined();
  });

  test("scopes retained views to workspace and project", () => {
    expect(toonWorkspaceRetentionKey("https://a.example", "workspace-a", "project")).not.toBe(toonWorkspaceRetentionKey("https://a.example", "workspace-b", "project"));
    expect(toonWorkspaceRetentionKey("https://a.example", "workspace-a", "project")).not.toBe(toonWorkspaceRetentionKey("https://a.example", "workspace-a", "other"));
    expect(toonWorkspaceRetentionKey("https://a.example", "workspace-a", "project")).not.toBe(toonWorkspaceRetentionKey("https://b.example", "workspace-a", "project"));
  });

  test("flushes every dirty tab in order and blocks the transition on failure", async () => {
    const tabs = [
      { draft: "dirty-a", saved: "", revision, pendingSave: undefined },
      { draft: "clean", saved: "clean", revision, pendingSave: undefined },
      { draft: "dirty-b", saved: "", revision, pendingSave: undefined },
    ];
    const flushed: string[] = [];
    const result = await flushAllDirtyTabs(tabs, async (tab) => {
      flushed.push(tab.draft);
      return tab.draft !== "dirty-b";
    });
    expect(result).toBe(false);
    expect(flushed).toEqual(["dirty-a", "dirty-b"]);
  });

  test("coalesces an inflight snapshot while preserving the newer dirty edit", () => {
    const state = { draft: "first", saved: "", revision, pendingSave: undefined };
    const pending = prepareToonDocumentSave(state, "save-1")!;
    state.draft = "newer";
    expect(prepareToonDocumentSave(state, "save-2")).toBe(pending);
    expect(completeToonDocumentSave(state, pending, "b".repeat(64))).toBe(true);
    expect(prepareToonDocumentSave(state, "save-2")?.content).toBe("newer");
  });
});
