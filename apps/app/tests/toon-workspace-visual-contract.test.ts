import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const domainRoot = new URL("../src/react-app/domains/toon-factory/", import.meta.url);

test("workspace surfaces use semantic theme tokens and responsive collision rules", async () => {
  const files = [
    "canvas/toon-spatial-canvas.tsx",
    "workspace/toon-workspace.tsx",
    "workspace/toon-document-workspace.tsx",
    "workspace/toon-document-editor.tsx",
    "workspace/toon-asset-panel.tsx",
    "workspace/toon-project-assistant.tsx",
  ];
  const source = (await Promise.all(files.map((path) => readFile(new URL(path, domainRoot), "utf8")))).join("\n");
  expect(source).toContain("var(--app-page-bg)");
  expect(source).toMatch(/dls-border/);
  expect(source).toMatch(/dls-accent/);
  expect(source).toMatch(/motion-reduce/);
  expect(source).toMatch(/max-\[900px\]|max-\[760px\]|max-\[720px\]/);
  expect(source).not.toMatch(/bg-white|text-black|#[0-9a-f]{3,8}/i);
  expect(source).not.toMatch(/from\s+["'](?:element-plus|@toonflow\/)/i);
});

test("floating controls reserve minimap and narrow dock collision space", async () => {
  const canvas = await readFile(new URL("canvas/toon-spatial-canvas.tsx", domainRoot), "utf8");
  const workspace = await readFile(new URL("workspace/toon-workspace.tsx", domainRoot), "utf8");
  expect(canvas).toContain("marginBottom: 48");
  expect(canvas).toContain("max-w-[calc(100%-15rem)]");
  expect(canvas).toContain("max-[760px]:bottom-14");
  expect(workspace).toContain("max-[900px]:absolute");
  expect(workspace).toContain("Math.max(280, Math.min(520");
});
