import { afterEach, beforeEach, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ToonAssetPanel } from "../src/react-app/domains/toon-factory/workspace/toon-asset-panel";

const now = "2026-01-01T00:00:00.000Z";
const asset = (id: string) => ({ id, title: id, path: `assets/${id}.png`, mimeType: "image/png", bytes: 4, checksum: id.repeat(64).slice(0, 64), origin: "imported" as const, state: "active" as const, references: [], createdAt: now, updatedAt: now });

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

test("switching preview A to B aborts only A and keeps B object URL live", async () => {
  const pending = new Map<string, { resolve: (value: any) => void; signal: AbortSignal }>();
  const revoked: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (() => { let value = 0; return () => `blob:${++value}`; })() });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: (url: string) => revoked.push(url) });
  const assets = [asset("a"), asset("b")];
  const client = {
    queryToonWorkspace: async (_workspaceId: string, _projectId: string, query: any) => ({ kind: "asset.references", asset: assets.find((item) => item.id === query.assetId), impacts: [] }),
    downloadToonProjectAsset: async (_workspaceId: string, _projectId: string, id: string, _preview: boolean, signal: AbortSignal) => new Promise((resolve) => pending.set(id, { resolve, signal })),
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => { renderer = TestRenderer.create(<ToonAssetPanel client={client as any} workspaceId="workspace" projectId="project" assets={assets} onClose={() => {}} onChanged={() => {}} onReuse={() => {}} onAttach={() => {}} />); });
    const buttons = () => renderer.root.findAll((node) => node.type === "button" && node.findAllByType("strong").length > 0);
    await act(async () => { void buttons()[0]!.props.onClick(); await Promise.resolve(); });
    await act(async () => { void buttons()[1]!.props.onClick(); await Promise.resolve(); });
    expect(pending.get("a")?.signal.aborted).toBe(true);
    expect(pending.get("b")?.signal.aborted).toBe(false);
    await act(async () => { pending.get("a")?.resolve({ data: new Uint8Array([1]), contentType: "image/png" }); pending.get("b")?.resolve({ data: new Uint8Array([2]), contentType: "image/png" }); await Promise.resolve(); });
    expect(renderer.root.findByType("img").props.src).toBe("blob:1");
    expect(revoked).not.toContain("blob:1");
    await act(async () => { renderer.unmount(); });
    expect(revoked).toContain("blob:1");
  } finally {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
  }
});
