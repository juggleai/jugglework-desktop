import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { createToonDocumentRetainedState, ToonDocumentWorkspace } from "../src/react-app/domains/toon-factory/workspace/toon-document-workspace";

const revision = "a".repeat(64);
const now = "2026-01-01T00:00:00.000Z";
const document = { id: "script", title: "Script", path: "documents/scenes/script.md", kind: "markdown" as const, mimeType: "text/markdown", revision, state: "active" as const, updatedAt: now };
const catalogs = {
  kind: "catalogs.read" as const,
  canvases: { schemaVersion: 2 as const, projectId: "project-1", folders: [], canvases: [] },
  documents: { schemaVersion: 2 as const, projectId: "project-1", folders: [{ id: "scenes", title: "Scenes", path: "documents/scenes", state: "active" as const }], documents: [document] },
  assets: { schemaVersion: 2 as const, projectId: "project-1", assets: [] },
  revisions: { "catalogs/documents.json": revision },
};

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = { prompt: () => "mutated", addEventListener() {}, removeEventListener() {} };
});
afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe("Toon document workspace read-only fence", () => {
  test("disables the folder selector and guards create, rename, copy, delete, restore, and move handlers", async () => {
    const retained = createToonDocumentRetainedState();
    retained.selectedId = document.id;
    let mutations = 0;
    const client = {
      queryToonWorkspace: async () => ({ kind: "document.read" as const, document, content: "", revision }),
      executeToonWorkspaceCommand: async () => { mutations += 1; throw new Error("read-only mutation escaped"); },
      searchToonDocuments: async () => ({ items: [], scannedFiles: 0, scannedBytes: 0, truncated: false, nextCursor: null }),
      listToonDocumentRevisions: async () => ({ items: [] }),
      restoreToonDocumentRevision: async () => { mutations += 1; throw new Error("read-only restore escaped"); },
      downloadToonProjectAsset: async () => ({ data: new ArrayBuffer(0) }),
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonDocumentWorkspace client={client as any} workspaceId="workspace-1" projectId="project-1" visible readOnly catalogs={catalogs} retained={retained} onCatalogsChange={async () => catalogs} />); });
    const selector = renderer.root.findAllByType("select").find((item) => item.props.value === "documents/scenes")!;
    expect(selector.props.disabled).toBe(true);
    await act(async () => { selector.props.onChange({ target: { value: "documents" } }); });
    const toolbar = renderer.root.findAllByType("button").slice(0, 6);
    expect(toolbar).toHaveLength(6);
    for (const button of toolbar) {
      expect(button.props.disabled).toBe(true);
      await act(async () => { await button.props.onClick(); });
    }
    expect(mutations).toBe(0);
    await act(async () => { renderer.unmount(); });
  });
});
